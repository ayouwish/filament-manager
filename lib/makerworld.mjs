// MakerWorld 链接解析。
//
// 实测结论（2026-10，无代理/无登录）：
//   - makerworld.com（含 /v1/design-service）→ Cloudflare 403「Just a moment...」，服务端抓不了；
//   - api.bambulab.com/v1/design-service → 200，可匿名拿到标题/封面/作者/配置列表；
//     但匿名态 weight=0、prediction=0、instanceFilaments=null、f3mf.url=""（登录才有）。
// 因此：能拿到的元数据先展示；克重以用户上传的 .3mf（slice_info.config）为准。
// 不持久化用户 Cookie/clearance（合规考虑）；可选只用环境变量 MAKERWORLD_COOKIE 临时注入。

import { parse3mf, mergePlateRequirements, normalizeHexColor } from './threemf.mjs';

const API_BASES = [
  'https://api.bambulab.com/v1/design-service',
  'https://makerworld.com/v1/design-service',
];
const SITE = 'https://makerworld.com';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 从链接中提取 designId / profileId。 */
export function parseMakerWorldUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: 'invalid_url', message: '链接格式不正确' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_url', message: '只支持 https://makerworld.com/... 链接' };
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'makerworld.com' && !host.endsWith('.makerworld.com')) {
    return { ok: false, reason: 'invalid_url', message: '不是 MakerWorld 链接（应为 makerworld.com）' };
  }
  const m = u.pathname.match(/\/models?\/(\d+)/i);
  if (!m) {
    return { ok: false, reason: 'invalid_url', message: '链接里找不到模型 ID（形如 /models/1234567-xxx）' };
  }
  const hash = decodeURIComponent(u.hash || '');
  const profileMatch = hash.match(/profileId[-=](\d+)/) || u.search.match(/profileId=(\d+)/);
  return {
    ok: true,
    designId: m[1],
    profileId: profileMatch ? profileMatch[1] : null,
    canonicalUrl: `${SITE}/zh/models/${m[1]}`,
    url: u.toString(),
  };
}

async function fetchWithTimeout(url, { headers = {}, timeoutMs = 12000, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { ...BROWSER_HEADERS, ...headers }, redirect, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isCloudflareChallenge(res, text) {
  if (res.status !== 403 && res.status !== 503) return false;
  return /just a moment|cf-challenge|challenge-platform|cloudflare|please log in/i.test(text || '');
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 深度遍历 JSON，收集满足条件的对象（限制节点数，防止大响应卡死）。 */
export function deepCollect(root, predicate, { maxNodes = 20000 } = {}) {
  const out = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < maxNodes) {
    const node = stack.pop();
    seen++;
    if (!node || typeof node !== 'object') continue;
    if (predicate(node)) out.push(node);
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return out;
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function collectImageUrls(obj) {
  const urls = [];
  for (const node of deepCollect(obj, (n) => typeof n === 'object' && n !== null)) {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^https?:\/\//.test(v) && /\.(png|jpe?g|webp)(\?|$)/i.test(v)) {
        if (/cover|thumb|image|pic/i.test(k)) urls.push(v);
      }
    }
  }
  return [...new Set(urls)].slice(0, 12);
}

/** 从 design / instances 响应提取模型信息（字段按实际 payload，防御式读取）。 */
export function extractFromDesignJson(designJson, instancesJson, { profileId = null } = {}) {
  const design = designJson?.design || designJson || {};
  const title = firstString(design, ['title', 'name']);
  const cover = firstString(design, ['coverUrl', 'cover']) || collectImageUrls(designJson)[0] || '';
  const author = firstString(design?.designCreator || {}, ['name', 'handle']);
  const summary = String(design.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);

  const rawHits =
    (Array.isArray(instancesJson?.hits) && instancesJson.hits) ||
    (Array.isArray(instancesJson) && instancesJson) ||
    (Array.isArray(instancesJson?.instances) && instancesJson.instances) ||
    instancesJson?.data ||
    [];

  const instances = rawHits.map((hit) => {
    const detail = hit.detail || {};
    const modelInfo = detail.extention?.modelInfo || {};
    return {
      id: hit.id ?? null,
      profileId: hit.profileId ?? null,
      title: firstString(hit, ['title', 'name']),
      cover: hit.cover || '',
      predictionSeconds: Number(detail.prediction) || 0,
      grams: Number(detail.weight) || 0,
      materialCount: Number(detail.materialCnt) || 0,
      colorCount: Number(detail.materialColorCnt) || 0,
      needAms: Boolean(detail.needAms),
      printer: modelInfo.compatibility?.devModelName || '',
      f3mfUrl: modelInfo.f3mf?.url || '',
      filaments: detail.instanceFilaments ?? null,
    };
  });

  const chosen =
    instances.find((i) => profileId && String(i.profileId) === String(profileId || '')) ||
    instances.find((i) => profileId && String(i.id) === String(profileId || '')) ||
    instances.find((i) => i.grams > 0 || i.f3mfUrl) ||
    instances[0] ||
    null;

  return { title, cover, author, summary, instances, chosen, defaultInstanceId: design.defaultInstanceId ?? null };
}

/** 把 instanceFilaments 尽力映射为需求（结构未公开，所有字段防防御式读取）。 */
export function mapInstanceFilaments(filaments) {
  if (!Array.isArray(filaments)) return [];
  const out = [];
  for (const f of filaments) {
    if (!f || typeof f !== 'object') continue;
    const type = firstString(f, ['type', 'filamentType', 'filament_type', 'material', 'materialType', 'material_type']);
    const colorRaw = firstString(f, ['color', 'colour', 'filamentColor', 'filament_color', 'colorHex', 'color_hex']);
    if (!/^#?[0-9a-fA-F]{6}/.test(colorRaw)) continue;
    const grams =
      Number(f.weight ?? f.gram ?? f.grams ?? f.usedG ?? f.used_g ?? f.filamentWeight ?? f.filament_weight) || null;
    out.push({ type, colorHex: normalizeHexColor(colorRaw), grams });
  }
  // 相同颜色/类型合并
  const map = new Map();
  for (const r of out) {
    const key = `${r.type.toUpperCase()}|${r.colorHex}`;
    const cur = map.get(key);
    if (!cur) map.set(key, { ...r });
    else {
      if (cur.grams === null || r.grams === null) cur.grams = null;
      else cur.grams += r.grams;
    }
  }
  return [...map.values()].map((r, i) => ({ index: i + 1, ...r }));
}

/** 从 MakerWorld 页面 HTML 的 __NEXT_DATA__ 里提取模型信息（油猴脚本兜底）。 */
export function extractFromPageHtml(html, { designId } = {}) {
  const result = { title: '', cover: '', requirements: [], instances: [], warnings: [] };
  const m = String(html || '').match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) {
    result.warnings.push('页面里没有 __NEXT_DATA__，可能是反爬页面或页面结构已变化');
    return result;
  }
  const data = parseJsonSafe(m[1]);
  if (!data) {
    result.warnings.push('__NEXT_DATA__ 不是合法 JSON');
    return result;
  }

  const designNodes = deepCollect(data, (n) => {
    if (typeof n !== 'object' || n === null) return false;
    const id = n.id ?? n.designId ?? n.design_id;
    return id !== undefined && String(id) === String(designId);
  });
  const design = designNodes[0] || null;
  result.title = firstString(design || {}, ['name', 'title', 'designName', 'design_name']);
  result.cover = collectImageUrls(design || data)[0] || '';

  const filamentNodes = deepCollect(data, (n) => {
    if (typeof n !== 'object' || n === null || Array.isArray(n)) return false;
    const keys = Object.keys(n).map((k) => k.toLowerCase());
    const hasType = keys.some((k) => /^(filament_?type|material|material_?type|type)$/.test(k));
    const hasColor = keys.some((k) => /^(filament_?colou?r|color|colour|hex)$/.test(k));
    return hasType && hasColor;
  });
  const seen = new Set();
  const materialOk = (t) => /^(PLA\+?|PETG|ABS|ASA|TPU|TPE|PA6?|PA12|PC|PVA|HIPS)$/i.test(String(t || '').trim());
  for (const node of filamentNodes.slice(0, 40)) {
    const raw = JSON.stringify(node);
    if (seen.has(raw)) continue;
    seen.add(raw);
    const type = firstString(node, ['filament_type', 'filamentType', 'material', 'material_type', 'materialType', 'type']);
    const color = firstString(node, ['filament_colour', 'filament_color', 'filamentColour', 'filamentColor', 'color', 'colour', 'hex']);
    const grams = Number(node.used_g ?? node.usedG ?? node.weight ?? node.grams ?? node.filament_weight ?? 0) || null;
    if (!/^#?[0-9a-fA-F]{6}/.test(color)) continue;
    if (type && !materialOk(type)) continue; // 排除推荐模型等无关节点
    if (grams !== null && grams <= 0 && !type) continue;
    const colorHex = normalizeHexColor(color);
    if (result.requirements.some((r) => r.colorHex === colorHex && String(r.type).toUpperCase() === type.toUpperCase())) continue;
    result.requirements.push({ type: type || '', colorHex, grams });
  }
  if (!result.requirements.length) {
    result.warnings.push('页面数据里没有解析到材料信息，请改用「下载打印配置 .3mf 后上传」');
  }
  return result;
}

function pickDownloadUrlFromJson(obj) {
  for (const node of deepCollect(obj, () => true)) {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== 'string' || !/^https?:\/\//.test(v)) continue;
      if (/\.(3mf|zip)(\?|$)/i.test(v) || /download|f3mf/i.test(k)) return v;
    }
  }
  return '';
}

async function downloadAndParse3mf(url, { cookie, title } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await fetchWithTimeout(url, { headers, redirect: 'follow', timeoutMs: 30000 });
  const ct = res.headers.get('content-type') || '';
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > 200 * 1024 * 1024) return { ok: false, reason: 'download_unavailable' };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) return { ok: false, reason: 'download_unavailable' };
  if (buf.subarray(0, 2).toString() === 'PK') {
    return { ok: true, model: parse3mf(buf, { filename: 'makerworld.3mf', title: title || undefined }) };
  }
  const text = buf.toString('utf8');
  if (isCloudflareChallenge(res, text)) return { ok: false, reason: 'blocked' };
  const json = parseJsonSafe(text);
  const nextUrl = json ? pickDownloadUrlFromJson(json) : '';
  if (nextUrl) {
    const r2 = await fetchWithTimeout(nextUrl, { headers, redirect: 'follow', timeoutMs: 30000 });
    const b2 = Buffer.from(await r2.arrayBuffer());
    if (b2.subarray(0, 2).toString() === 'PK') {
      return { ok: true, model: parse3mf(b2, { filename: 'makerworld.3mf', title: title || undefined }) };
    }
  }
  return { ok: false, reason: 'download_unavailable' };
}

/**
 * 解析 MakerWorld 模型链接。
 * @returns {Promise<object>}
 *   { ok:true, source, title, cover, author, requirements, plates?, instances, warnings, needs3mf? }
 *   { ok:false, reason, message, fallbacks, warnings }
 */
export async function resolveMakerWorld(rawUrl, { cookie = '', timeoutMs = 10000 } = {}) {
  const parsed = parseMakerWorldUrl(rawUrl);
  if (!parsed.ok) return parsed;

  const warnings = [];
  let design = null;
  let instancesJson = null;
  let blockedCount = 0;

  for (const base of API_BASES) {
    try {
      const res = await fetchWithTimeout(`${base}/design/${parsed.designId}`, { headers: cookie ? { Cookie: cookie } : {}, timeoutMs });
      const text = await res.text();
      if (isCloudflareChallenge(res, text)) {
        blockedCount++;
        continue;
      }
      if (!res.ok) continue;
      const json = parseJsonSafe(text);
      if (!json) continue;
      design = json;
      try {
        const res2 = await fetchWithTimeout(`${base}/design/${parsed.designId}/instances`, {
          headers: cookie ? { Cookie: cookie } : {},
          timeoutMs,
        });
        const text2 = await res2.text();
        if (res2.ok && !isCloudflareChallenge(res2, text2)) instancesJson = parseJsonSafe(text2);
      } catch (err) {
        warnings.push(`配置列表请求失败：${err.name === 'AbortError' ? '超时' : err.message}`);
      }
      break;
    } catch (err) {
      warnings.push(`接口请求失败：${err.name === 'AbortError' ? '超时' : err.message}`);
    }
  }

  if (design || instancesJson) {
    const meta = extractFromDesignJson(design, instancesJson, { profileId: parsed.profileId });
    const instance = meta.chosen;

    // 有登录态/直链时，直接下载 3mf 精确解析
    if (instance?.f3mfUrl) {
      try {
        const dl = await downloadAndParse3mf(instance.f3mfUrl, { cookie, title: meta.title });
        if (dl.ok) {
          const model = dl.model;
          return {
            ok: true,
            source: 'makerworld+3mf',
            title: meta.title || model.title,
            cover: meta.cover || instance.cover,
            author: meta.author,
            plates: model.plates,
            requirements: mergePlateRequirements(model.plates),
            instances: meta.instances,
            warnings: [...warnings, ...model.warnings],
            designId: parsed.designId,
            profileId: instance.profileId ?? instance.id ?? null,
          };
        }
        warnings.push('打印配置下载失败（匿名态需要登录才能下载），请手动下载 .3mf 后上传。');
      } catch (err) {
        warnings.push(`打印配置下载失败：${err.message}`);
      }
    }

    // 实例自带耗材清单（登录态才有）
    const mapped = mapInstanceFilaments(instance?.filaments);
    if (mapped.length) {
      return {
        ok: true,
        source: 'makerworld+api',
        title: meta.title || 'MakerWorld 模型',
        cover: meta.cover,
        author: meta.author,
        plates: [],
        requirements: mapped,
        instances: meta.instances,
        warnings: [...warnings, '材料数据来自 makerworld 接口（登录态），请核对后再扣减。'],
        designId: parsed.designId,
        profileId: instance?.profileId ?? null,
      };
    }

    // 只有元数据：匿名接口拿不到克重/材料，引导用户上传 3mf
    warnings.push(
      'MakerWorld 匿名接口能拿到模型信息，但拿不到材料克重（需要登录）。请在该模型页点「下载打印配置」，再把 .3mf 上传到这里，克重会精确到 0.1 g。',
    );
    return {
      ok: true,
      source: 'makerworld+metadata',
      needs3mf: true,
      title: meta.title || 'MakerWorld 模型',
      cover: meta.cover,
      author: meta.author,
      summary: meta.summary,
      instances: meta.instances,
      requirements: [],
      plates: [],
      warnings,
      designId: parsed.designId,
      profileId: parsed.profileId,
    };
  }

  // 兜底：页面 HTML（服务端通常会被 CF 拦，保留给可直连的部署环境）
  try {
    const res = await fetchWithTimeout(parsed.url, { headers: cookie ? { Cookie: cookie } : {}, timeoutMs: 8000 });
    const html = await res.text();
    if (!isCloudflareChallenge(res, html) && res.ok) {
      const page = extractFromPageHtml(html, { designId: parsed.designId });
      if (page.requirements.length) {
        return {
          ok: true,
          source: 'makerworld+page',
          title: page.title || `MakerWorld ${parsed.designId}`,
          cover: page.cover,
          plates: [],
          requirements: page.requirements,
          instances: page.instances,
          warnings: [...warnings, ...page.warnings, '材料数据来自页面 JSON，可能不完整，请核对。'],
          designId: parsed.designId,
          profileId: parsed.profileId,
        };
      }
      warnings.push(...page.warnings);
    }
  } catch (err) {
    warnings.push(`页面抓取失败：${err.name === 'AbortError' ? '超时' : err.message}`);
  }

  if (blockedCount > 0) {
    return {
      ok: false,
      reason: 'upstream_blocked',
      message: 'MakerWorld 拒绝了服务器请求（Cloudflare 人机校验 / 需要登录）。这不影响使用。',
      fallbacks: ['upload_3mf', 'paste_page', 'manual'],
      designId: parsed.designId,
      warnings,
    };
  }
  return {
    ok: false,
    reason: 'no_requirements',
    message: '没有解析到材料需求。建议在 MakerWorld 点「下载打印配置」得到 .3mf，再上传到这里精确解析。',
    fallbacks: ['upload_3mf', 'paste_page', 'manual'],
    designId: parsed.designId,
    warnings,
  };
}
