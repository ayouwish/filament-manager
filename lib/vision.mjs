// 图片识别耗材：把照片交给视觉模型（本地 Ollama / OpenAI 兼容接口），
// 输出结构化的耗材清单，并用本地色卡（SpoolmanDB 的 Panchroma 数据）校正颜色。
//
// 设计原则：
// - 识别结果永远可编辑、可逐项勾选，不直接写库存（避免模型幻觉污染账本）。
// - 颜色优先级：模型给的 hex（校验后）→ 色卡按颜色名匹配 → 内置色名字典 → 留空让用户点图取色。
// - 不把 API Key 写入日志；只有显式配置才调用网络。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deltaEHex } from './color.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_FILES = [
  process.env.FM_CATALOG_FILE,
  path.join(ROOT, 'data', 'catalog', 'panchroma-pla.json'),
  path.join(ROOT, 'catalog', 'panchroma-pla.json'), // Docker 镜像内的兜底路径
].filter(Boolean);

const MATERIAL_WORDS = /(PETG|PLA\+?|ABS|ASA|TPU|TPE|PA6|PA12|NYLON|PC|PVA|HIPS)/i;
const MATERIAL_MAP = { TPE: 'TPU', NYLON: 'PA', PA6: 'PA', PA12: 'PA', 'PLA+': 'PLA' };
const MATERIAL_CHOICES = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', '其他'];

// 常见英文/中文色名兜底（色卡缺失时用）
const COLOR_HINTS = {
  'charcoal black': '#333333', 'matte charcoal black': '#333333', black: '#17181A',
  'muted blue': '#6C8EA4', blue: '#1E5FBF', 'forest green': '#2F6B45', green: '#2F6B45',
  'sunrise orange': '#E87A3E', orange: '#E8622A',
  'savannah yellow': '#E4C05A', yellow: '#E8C23A',
  'fossil grey': '#8C8C8C', 'fossil gray': '#8C8C8C', grey: '#8A8F98', gray: '#8A8F98',
  'lavender purple': '#A78BBA', purple: '#7B4FA3',
  'army beige': '#C8B89B', beige: '#C8B89B',
  'pastel peanut': '#D8B48C', peanut: '#D8B48C',
  'silk water': '#3E8ED0', 'silk water gradient': '#3E8ED0',
  red: '#C62828', white: '#F2F2EE', 'matte white': '#F2F2EE',
  'matte black': '#17181A', 'matte blue': '#1E5FBF', 'matte red': '#C62828',
  'matte green': '#2F6B45', 'matte orange': '#E8622A', 'matte yellow': '#E8C23A',
  'matte purple': '#7B4FA3', 'matte pink': '#E893A8', pink: '#E893A8',
  'dark blue': '#1B2A5B', 'light blue': '#4FA3D8', cyan: '#2AA7A0', brown: '#6B4A32',
  transparent: '#E9E9E2', clear: '#E9E9E2', gold: '#C9A227', silver: '#B9BEC6',
  黑色: '#17181A', 白色: '#F2F2EE', 灰色: '#8A8F98', 红色: '#C62828', 橙色: '#E8622A',
  黄色: '#E8C23A', 绿色: '#2F6B45', 蓝色: '#1E5FBF', 紫色: '#7B4FA3', 粉色: '#E893A8',
  棕色: '#6B4A32', 米色: '#EFE8D8', 透明: '#E9E9E2',
};

const DEFAULTS = {
  provider: '', // '' / auto | ollama | openai | anthropic
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  timeoutMs: 180000,
};

let catalogCache = null;

export function loadCatalog() {
  if (catalogCache) return catalogCache;
  try {
    const file = CATALOG_FILES.find((f) => fs.existsSync(f));
    if (!file) throw new Error('catalog not found');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    catalogCache = (raw.entries || []).map((e) => ({
      ...e,
      norm: normalizeColorName(e.name),
    }));
  } catch {
    catalogCache = [];
  }
  return catalogCache;
}

export function normalizeColorName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[™®]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(panchroma|polymaker|pla|petg|matte|silk|gradient|former|formerly|polylite)\b/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 在本地色卡里按颜色名找官方色值（严格：完全匹配，或词元全覆盖且多余词 ≤2）。 */
export function matchCatalogColor(name, { catalog = loadCatalog() } = {}) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const norm = normalizeColorName(raw);
  if (!norm) return null;
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length < 2) return null; // 泛色名（Black/Blue）交给色名字典，避免误命中某个变体
  for (const entry of catalog) {
    if (entry.norm === norm) return entry.colorHex;
  }
  let best = null;
  let bestExtra = Infinity;
  for (const entry of catalog) {
    if (!entry.norm) continue;
    const entryTokens = entry.norm.split(' ').filter(Boolean);
    const entrySet = new Set(entryTokens);
    const covered = tokens.filter((t) => entrySet.has(t)).length;
    if (covered !== tokens.length) continue;
    const extra = entryTokens.length - tokens.length;
    if (extra < 0 || extra > 2) continue;
    if (extra < bestExtra || (extra === bestExtra && entry.norm.length < best.norm.length)) {
      best = entry;
      bestExtra = extra;
    }
  }
  return best ? best.colorHex : null;
}

/** 内置色名字典兜底（不含官方色号）。 */
export function hintColorHex(name) {
  const norm = normalizeColorName(name);
  if (!norm) return null;
  const keys = Object.keys(COLOR_HINTS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (norm.includes(normalizeColorName(k))) return COLOR_HINTS[k];
  }
  return null;
}

export function hexForColorName(name, opts = {}) {
  return matchCatalogColor(name, opts) || hintColorHex(name);
}

export function inferMaterial(...texts) {
  const joined = texts.filter(Boolean).join(' ');
  const m = joined.match(MATERIAL_WORDS);
  if (!m) return '';
  let word = m[1].toUpperCase();
  word = MATERIAL_MAP[word] || word;
  return MATERIAL_CHOICES.includes(word) ? word : '其他';
}

export function normalizeMaterial(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  if (MATERIAL_CHOICES.includes(raw)) return raw;
  const inferred = inferMaterial(raw);
  return inferred || '';
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function asString(value, max = 80) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 从可能被截断的输出里尽量捞出完整的 item 对象。 */
export function parseItemsLoose(text) {
  const s = String(text || '');
  const itemsKey = s.indexOf('"items"');
  const startBracket = s.indexOf('[', itemsKey >= 0 ? itemsKey : 0);
  if (startBracket < 0) return [];
  const items = [];
  let i = startBracket + 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (s[i] === ']') break;
    if (s[i] !== '{') { i++; continue; }
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    if (depth !== 0) break; // 最后一个对象不完整，丢弃
    try {
      const obj = JSON.parse(s.slice(start, i));
      if (obj && typeof obj === 'object') items.push(obj);
    } catch {
      /* 跳过坏对象 */
    }
  }
  return items;
}

/** 解析模型返回的 JSON（容忍 markdown 代码块、前后废话、被截断的数组）。 */
export function parseRecognitionJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('模型没有返回内容');
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const arrFirst = s.indexOf('[');
  const arrLast = s.lastIndexOf(']');
  if (s.startsWith('[') && arrFirst === 0 && arrLast > 0) {
    const arr = JSON.parse(s.slice(arrFirst, arrLast + 1));
    if (!Array.isArray(arr)) throw new Error('模型返回的不是 items 数组');
    return { items: arr, summary: '', partial: false, boxCount: null };
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) {
    if (arrFirst >= 0 && arrLast > arrFirst) {
      const arr = JSON.parse(s.slice(arrFirst, arrLast + 1));
      if (!Array.isArray(arr)) throw new Error('模型返回的不是 items 数组');
      return { items: arr, summary: '', partial: false, boxCount: null };
    }
    throw new Error('模型没有返回 JSON');
  }
  let obj;
  try {
    obj = JSON.parse(s.slice(first, last + 1));
  } catch {
    const loose = parseItemsLoose(s);
    if (loose.length) return { items: loose, summary: '', partial: true, boxCount: null };
    throw new Error('模型返回的 JSON 无法解析');
  }
  const items = Array.isArray(obj) ? obj : Array.isArray(obj.items) ? obj.items : null;
  if (!items) {
    const loose = parseItemsLoose(s);
    if (loose.length) return { items: loose, summary: '', partial: true, boxCount: null };
    throw new Error('JSON 里没有 items 数组');
  }
  const boxCount = Number(obj.boxCount ?? obj.box_count ?? obj.count);
  return {
    items,
    summary: asString(obj.summary, 200),
    partial: false,
    boxCount: Number.isFinite(boxCount) && boxCount > 0 ? Math.round(boxCount) : null,
  };
}

/** 把模型的原始 items 规范化成库存可用的结构。 */
export function normalizeRecognitionItems(rawItems, { catalog = loadCatalog(), warnings = [] } = {}) {
  const out = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || typeof raw !== 'object') continue;
    const brand = asString(raw.brand, 40);
    const productLine = asString(raw.productLine || raw.product_line || raw.line, 60);
    const colorName = asString(raw.colorName || raw.color_name || raw.color, 60);
    const labelText = asString(raw.labelText || raw.label || raw.text, 160);
    const sku = asString(raw.sku || raw.SKU || raw.model, 24).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    let material = normalizeMaterial(raw.material);
    if (!material) {
      material = inferMaterial(productLine, colorName, labelText) || 'PLA';
      if (material === 'PLA' && !/pla/i.test([productLine, colorName, labelText].join(' '))) {
        warnings.push(`「${colorName || productLine || '未命名'}」材料类型是推测值（PLA），请核对`);
      }
    }

    const hexRaw = asString(raw.colorHex || raw.color_hex || raw.hex, 9);
    const modelColorHex = /^#?[0-9a-fA-F]{6}/.test(hexRaw)
      ? `#${hexRaw.replace(/^#/, '').slice(0, 6).toUpperCase()}`
      : null;
    // 颜色优先级：本地色卡（官方色号）> 模型给的近似色 > 内置色名兜底
    const catalogHex = colorName ? matchCatalogColor(colorName, { catalog }) : null;
    const hintHex = !catalogHex ? (colorName ? hintColorHex(colorName) : null) || hintColorHex(labelText) : null;
    const colorHex = catalogHex || modelColorHex || hintHex || '';
    const hexSource = catalogHex ? 'catalog' : modelColorHex ? 'model' : hintHex ? 'dictionary' : null;

    const weightRaw = Number(raw.spoolWeightG ?? raw.spool_weight_g ?? raw.weight ?? raw.weightG);
    const spoolWeightG = Number.isFinite(weightRaw) && weightRaw > 0 ? Math.round(clamp(weightRaw, 50, 5000)) : 1000;
    const countRaw = Number(raw.count ?? raw.quantity ?? 1);
    const count = Number.isFinite(countRaw) ? Math.round(clamp(countRaw, 1, 20)) : 1;
    const confRaw = Number(raw.confidence);
    const confidence = Number.isFinite(confRaw) ? clamp(confRaw <= 1 ? confRaw : confRaw / 100, 0, 1) : 0.5;

    if (!brand && !productLine && !colorName) continue;
    out.push({
      brand,
      productLine,
      material,
      colorName,
      colorHex,
      modelColorHex,
      hexSource,
      sku,
      spoolWeightG,
      count,
      confidence,
      labelText,
    });
  }

  // 去重（同 SKU 或同 品牌+产品线+颜色）并累加数量
  const map = new Map();
  for (const item of out) {
    const key = item.sku
      ? `sku:${item.sku}`
      : `name:${item.brand}|${item.productLine}|${item.colorName}|${item.colorHex}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, item);
    } else {
      prev.count = Math.min(20, prev.count + item.count);
      prev.confidence = Math.max(prev.confidence, item.confidence);
      if (!prev.colorHex && item.colorHex) {
        prev.colorHex = item.colorHex;
        prev.hexSource = item.hexSource;
      }
    }
  }
  return [...map.values()];
}

function isSameSpool(a, b) {
  if (a.sku && b.sku && a.sku === b.sku) return true;
  const sameBrand = !a.brand || !b.brand || a.brand.toLowerCase() === b.brand.toLowerCase();
  if (!sameBrand) return false;
  if (a.material && b.material && a.material !== b.material) return false;
  const na = normalizeColorName(a.colorName);
  const nb = normalizeColorName(b.colorName);
  const nameClose = Boolean(na && nb && (na === nb || na.includes(nb) || nb.includes(na)));
  let dE = Infinity;
  if (a.colorHex && b.colorHex) {
    try {
      dE = deltaEHex(a.colorHex, b.colorHex);
    } catch {
      dE = Infinity;
    }
  }
  // 名字互相包含 + 颜色几乎一致 → 同一个盒子被识别两次
  if (nameClose && dE <= 4) return true;
  // 颜色几乎一样 + 名字词元高度重合（例如 "Matte Forest Green" / "Forest Green"）
  if (dE <= 1.5 && na && nb) {
    const ta = new Set(na.split(' ').filter(Boolean));
    const tb = new Set(nb.split(' ').filter(Boolean));
    if (!ta.size || !tb.size) return false;
    const inter = [...ta].filter((t) => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    if (inter / union >= 0.8) return true;
  }
  return false;
}

/** 合并"看起来是同一盘被识别多次"的条目；返回合并后的列表与合并条数。 */
export function mergeSimilarItems(items) {
  const out = [];
  let mergedCount = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const target = out.find((x) => isSameSpool(x, item));
    if (!target) {
      out.push({ ...item });
      continue;
    }
    target.count = Math.min(20, (target.count || 1) + (item.count || 1));
    target.confidence = Math.max(target.confidence || 0, item.confidence || 0);
    if (!target.colorHex && item.colorHex) {
      target.colorHex = item.colorHex;
      target.hexSource = item.hexSource;
    }
    if (!target.sku && item.sku) target.sku = item.sku;
    if (!target.labelText || (item.labelText || '').length > (target.labelText || '').length) {
      target.labelText = item.labelText || target.labelText;
    }
    mergedCount++;
  }
  return { items: out, mergedCount };
}

export function buildRecognitionPrompt({ brandHint = '' } = {}) {
  return `你是 3D 打印耗材盘点助手。请仔细看这张照片，识别照片里所有可见的 3D 打印耗材（盒装线材、料盘、包装）${brandHint ? `（提示：可能是 ${brandHint}）` : ''}。

先仔细数一遍照片里有几个**独立的包装盒/料盘**，把数量填进 boxCount 字段；
items 的条数必须等于 boxCount。同一个盒子的正面/侧面/标签/条形码只算一条；
渐变或多色盒（例如 Gradient Silk）算一条，不要拆成多条。

只输出一个 JSON 对象，不要 Markdown，不要解释，结构如下：
{
  "boxCount": 10,
  "items": [
    {
      "brand": "品牌，如 Polymaker / Bambu Lab / eSun / Panchroma；看不清填 null",
      "productLine": "产品线，如 Panchroma PLA Matte / PLA Basic；看不清填 null",
      "material": "材料类型，只能是 PLA/PETG/ABS/ASA/TPU/PA/PC/其他 之一",
      "colorName": "颜色名，优先用包装上印的原文，如 Forest Green / 黑色；看不清填 null",
      "colorHex": "该耗材颜色的近似 #RRGGBB；不确定填 null",
      "sku": "包装上的 SKU/型号编号，如 CA04078；看不清填 null",
      "spoolWeightG": 1000,
      "count": 1,
      "confidence": 0.9,
      "labelText": "包装上能看到的品牌/颜色文字（最多 60 字）"
    }
  ],
  "summary": "一句话说明照片里有几件耗材"
}

规则：
1. 每个独立的包装盒/料盘输出一个 item；同一 SKU 的多盒用 count 表示数量，但优先每盒一条。
1.1 一个盒子只允许出现一次；不要把盒子的正面、侧面、标签、条形码分别列成多条。
2. 只看照片里真实存在的内容，不要编造 SKU、品牌或颜色。
3. colorHex 应接近包装上展示的耗材颜色，不要用背景（地板/桌面/盒子牛皮纸色）。
4. 照片里没有耗材时返回 {"items":[],"summary":"未发现耗材"}。`;
}

function resolveBase(cfg) {
  return String(cfg.baseUrl || '').replace(/\/+$/, '');
}

/** 解析配置：settings.vision > 环境变量 > 默认（自动检测 Ollama）。 */
export function resolveVisionConfig(settings = {}, env = process.env) {
  const s = settings.vision || {};
  const provider = String(s.provider ?? env.VISION_PROVIDER ?? '').toLowerCase();
  const baseUrl = s.baseUrl || env.VISION_BASE_URL || env.OLLAMA_BASE_URL || '';
  const ollamaBaseUrl = env.OLLAMA_BASE_URL || DEFAULTS.ollamaBaseUrl;
  const apiKey = s.apiKey || env.VISION_API_KEY || '';
  let model = s.model || env.VISION_MODEL || '';
  // 输出上限：部分网关/上游对 >4k 的 max_tokens 直接 400，默认取 3500 更稳
  let maxTokens = Number(s.maxTokens || env.VISION_MAX_TOKENS || 3500);
  if (!Number.isFinite(maxTokens)) maxTokens = 3500;
  maxTokens = Math.min(16000, Math.max(256, Math.round(maxTokens)));
  // 推理型模型（DeepSeek 等）把 token 花在思考上会导致 content 为空；low 可显著降低概率
  const reasoningEffort = String(s.reasoningEffort || env.VISION_REASONING_EFFORT || '').toLowerCase();
  let timeoutMs = Number(s.timeoutMs || env.VISION_TIMEOUT_MS || DEFAULTS.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5000) timeoutMs = DEFAULTS.timeoutMs;
  return {
    provider,
    baseUrl:
      baseUrl ||
      (provider === 'ollama'
        ? ollamaBaseUrl
        : provider === 'anthropic'
          ? 'https://api.anthropic.com'
          : provider === 'openai'
            ? 'https://api.openai.com/v1'
            : ''),
    ollamaBaseUrl,
    model,
    apiKey,
    maxTokens,
    reasoningEffort: ['minimal', 'low', 'medium', 'high'].includes(reasoningEffort) ? reasoningEffort : '',
    headers: s.headers && typeof s.headers === 'object' ? s.headers : {},
    timeoutMs,
    auto: !provider || provider === 'auto',
  };
}

let autoStatusCache = { at: 0, value: null };

/** 测试/配置变更后重置自动检测缓存。 */
export function resetVisionDetectionCache() {
  autoStatusCache = { at: 0, value: null };
}

/** 检测当前可用的识别提供方（默认找本地 Ollama 的视觉模型）。
 *  显式配置（provider=openai/ollama/anthropic）总是实时判定；自动检测结果缓存 15s。 */
export async function detectVisionProvider({ settings = {}, env = process.env, fetchImpl = fetch, force = false } = {}) {
  const cfg = resolveVisionConfig(settings, env);
  if (!cfg.auto && !force) {
    const explicit = { ...cfg, ready: Boolean(cfg.provider && cfg.model && (cfg.provider === 'ollama' || cfg.apiKey)), reason: '', availableModels: [] };
    if (!cfg.model) explicit.reason = 'missing_model';
    else if (cfg.provider !== 'ollama' && !cfg.apiKey) explicit.reason = 'missing_api_key';
    return explicit;
  }
  if (cfg.auto && !force && autoStatusCache.value && Date.now() - autoStatusCache.at < 15000) return autoStatusCache.value;
  let result = { ...cfg, ready: false, reason: '', availableModels: [] };

  if (!cfg.auto) {
    result.ready = Boolean(cfg.provider && cfg.model && (cfg.provider === 'ollama' || cfg.apiKey));
    if (!cfg.model) result.reason = 'missing_model';
    else if (cfg.provider !== 'ollama' && !cfg.apiKey) result.reason = 'missing_api_key';
    return result;
  }

  // auto：只找本地 Ollama
  try {
    const res = await fetchImpl(`${cfg.ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const models = (data.models || []).map((m) => m.name).filter(Boolean);
      result.availableModels = models;
      const vision = models.find((name) => /vl|vision|llava|moondream|minicpm|pixtral|gemma3/i.test(name));
      if (vision) {
        result = { ...result, provider: 'ollama', baseUrl: cfg.ollamaBaseUrl, model: cfg.model || vision, ready: true };
      } else {
        result.reason = models.length ? 'ollama_no_vision_model' : 'ollama_no_models';
      }
    } else {
      result.reason = 'ollama_unreachable';
    }
  } catch {
    result.reason = 'ollama_unreachable';
  }
  autoStatusCache = { at: Date.now(), value: result };
  return result;
}

async function callOllama(cfg, { imageBase64, prompt, fetchImpl = fetch }) {
  const res = await fetchImpl(`${resolveBase(cfg)}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_predict: 3000 },
      messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Ollama HTTP ${res.status}：${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  return { text: asString(data.message?.content, 12000), usedReasoning: false };
}

async function callOpenAI(cfg, { imageBase64, mime, prompt, fetchImpl = fetch }) {
  const base = resolveBase(cfg);
  const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const body = {
    model: cfg.model,
    temperature: 0.1,
    max_tokens: cfg.maxTokens || 3500,
    messages: [
      { role: 'system', content: '你是耗材识别器。直接输出要求的 JSON，不要展开推理过程，不要解释。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
        ],
      },
    ],
  };
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  const call = async (payload) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.headers || {}),
        // opencode/new-api 网关的路由头；普通 OpenAI 兼容服务会忽略未知头
        'x-opencode-session': `fm-${crypto.randomUUID()}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    return { res, text: await res.text() };
  };
  const { res, text } = await call(body);
  if (!res.ok) {
    const err = new Error(`识别接口 HTTP ${res.status}：${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  const message = data.choices?.[0]?.message || {};
  const content = asString(message.content, 12000);
  if (content) return { text: content, usedReasoning: false };
  const reasoning = asString(message.reasoning_content, 20000);
  if (reasoning) return { text: reasoning, usedReasoning: true };
  // 正文和推理都为空：交给上层做一次重试，而不是直接抛错
  return { text: '', usedReasoning: false };
}

async function callAnthropic(cfg, { imageBase64, mime, prompt, fetchImpl = fetch }) {
  const base = resolveBase(cfg);
  const url = /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      authorization: `Bearer ${cfg.apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`识别接口 HTTP ${res.status}：${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  const blocks = Array.isArray(data.content) ? data.content : [];
  return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), usedReasoning: false };
}

/**
 * 识别图片中的耗材。
 * @param {{imageBase64:string, mime?:string, settings?:object, env?:object, fetchImpl?:Function, provider?:object}} opts
 */
export async function recognizeFilaments({
  imageBase64,
  mime = 'image/jpeg',
  settings = {},
  env = process.env,
  fetchImpl = fetch,
  provider = null,
  brandHint = '',
} = {}) {
  if (!imageBase64) return { ok: false, reason: 'no_image', message: '缺少图片数据' };
  const cfg = provider || (await detectVisionProvider({ settings, env, fetchImpl }));
  if (!cfg.ready) {
    const hints = {
      ollama_unreachable: '没有检测到本地 Ollama。安装 Ollama 后执行：ollama pull qwen2.5vl:3b（或配置 OpenAI 兼容接口）',
      ollama_no_models: 'Ollama 已运行但没有模型。执行：ollama pull qwen2.5vl:3b',
      ollama_no_vision_model: 'Ollama 里没有视觉模型。执行：ollama pull qwen2.5vl:3b',
      missing_model: '请在设置里填写视觉模型名称',
      missing_api_key: '请在设置里填写 API Key',
    };
    return {
      ok: false,
      reason: cfg.reason || 'not_configured',
      message: hints[cfg.reason] || '没有可用的图片识别服务，请在 ⚙ 设置里配置 Ollama 或 OpenAI 兼容接口。',
      availableModels: cfg.availableModels || [],
    };
  }

  const prompt = buildRecognitionPrompt({ brandHint });
  const warnings = [];
  let text = '';
  const callProvider = async () => {
    if (cfg.provider === 'ollama') return callOllama(cfg, { imageBase64, prompt, fetchImpl });
    if (cfg.provider === 'openai') return callOpenAI(cfg, { imageBase64, mime, prompt, fetchImpl });
    if (cfg.provider === 'anthropic') return callAnthropic(cfg, { imageBase64, mime, prompt, fetchImpl });
    throw new Error(`不支持的识别服务：${cfg.provider}`);
  };
  let usedReasoning = false;
  const runProvider = async () => {
    const out = await callProvider();
    text = typeof out === 'string' ? out : out.text;
    usedReasoning = typeof out === 'object' && Boolean(out.usedReasoning);
  };
  try {
    await runProvider();
    if (!String(text || '').trim()) {
      await new Promise((r) => setTimeout(r, 1500));
      await runProvider();
    }
  } catch (err) {
    const transient = /bad_response_status_code|HTTP 5\d\d|upstream|temporar|timeout/i.test(String(err.message));
    if (transient) {
      // 网关/上游偶发 5xx 时重试一次（不重试鉴权/参数错误，避免无谓计费）
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await runProvider();
      } catch (err2) {
        return { ok: false, reason: 'provider_error', message: `识别失败（重试后仍失败）：${err2.message}` };
      }
    } else {
      const message =
        err.name === 'TimeoutError' || err.name === 'AbortError'
          ? `识别超时（${Math.round(cfg.timeoutMs / 1000)} 秒）。本地视觉模型首次加载较慢，可重试或换更小模型。`
          : `识别失败：${err.message}`;
      return { ok: false, reason: 'provider_error', message };
    }
  }

  let parsed;
  try {
    parsed = parseRecognitionJson(text);
  } catch (err) {
    // 推理型模型偶发只输出推理、正文为空或 JSON 不完整：再给一次机会
    try {
      await new Promise((r) => setTimeout(r, 1200));
      await runProvider();
      parsed = parseRecognitionJson(text);
    } catch (err2) {
      return {
        ok: false,
        reason: 'bad_response',
        message: `模型返回的内容不是预期的 JSON：${err2.message || err.message}`,
        raw: String(text || '').slice(0, 1200),
      };
    }
  }

  if (usedReasoning) {
    warnings.push('模型正文为空，结果来自推理内容，请重点核对（可把 settings.vision.reasoningEffort 设为 low）。');
  }
  if (parsed.partial) {
    warnings.push(`模型输出被截断，只解析出 ${parsed.items.length} 项；请核对是否缺少包装或换用更小/更强的模型。`);
  }
  const normalized = normalizeRecognitionItems(parsed.items, { warnings });
  const { items, mergedCount } = mergeSimilarItems(normalized);
  if (mergedCount > 0) {
    warnings.push(`自动合并了 ${mergedCount} 条疑似重复项（同一盒被识别多次）。`);
  }
  if (parsed.boxCount && parsed.boxCount !== items.length) {
    warnings.push(
      `模型数出 ${parsed.boxCount} 个包装盒，但列出 ${items.length} 项，可能有重复或遗漏，请核对后再入库。`,
    );
  }
  if (!items.length) {
    return { ok: true, provider: cfg.provider, model: cfg.model, items: [], summary: '没有识别到耗材', warnings };
  }
  return {
    ok: true,
    provider: cfg.provider,
    model: cfg.model,
    items,
    summary: parsed.summary || `识别到 ${items.length} 项耗材`,
    warnings,
    ...(settings.vision?.debug ? { rawText: text } : {}),
  };
}

export { normalizeHexForTest as __normalizeHex };
function normalizeHexForTest(hex) {
  return /^#?[0-9a-fA-F]{6}/.test(String(hex || '')) ? `#${String(hex).replace(/^#/, '').slice(0, 6).toUpperCase()}` : null;
}
