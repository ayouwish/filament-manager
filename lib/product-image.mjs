// 商品图抓取：多图源搜索 + 相关性过滤 + 可选颜色校验。
// 只用于个人库存展示；图片版权归原站点所有。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deltaE2000, hexToLab, rgbToLab } from './color.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIN_BYTES = 6000;
const MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MIN_SCORE = Number(process.env.PRODUCT_IMAGE_MIN_SCORE || 4);
const MAX_COLOR_DELTA_E = Number(process.env.PRODUCT_IMAGE_MAX_DELTA_E || 40);

const STOP_WORDS = new Set(['filament', '3d', 'printing', 'spool', 'pla', 'petg', 'abs', 'asa', 'tpu', 'pa', 'pc', 'matte', 'silk']);
const BAD_WORDS = /(logo|icon|sprite|avatar|banner|favicon|placeholder|watermark|wallpaper|地图|壁纸|头像|表情|海报|招聘|广告|风景|旅游|汽车|轮胎|猫|狗|鸟|美食|菜谱|股票|房价|地图|涂色|简笔画|clipart|coloring)/i;
const BAD_URL = /(logo|icon|sprite|avatar|banner|favicon|placeholder|thumbnail|150x|100x|50x|watermark)/i;
const GOOD_EXT = /\.(jpe?g|png|webp)(\?|$)/i;

// 品牌官网/官方商店：命中时优先
const OFFICIAL_HOSTS = [
  /(^|\.)polymaker\.com$/i,
  /(^|\.)panchroma3d\.com$/i,
  /(^|\.)bambulab\.com$/i,
  /(^|\.)bblmw\.com$/i,
  /(^|\.)esun3d\.(com|store)$/i,
  /(^|\.)sunlu\.com$/i,
  /(^|\.)creality\.com$/i,
  /(^|\.)anycubic\.com$/i,
  /(^|\.)prusa3d\.com$/i,
];

export function isOfficialHost(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return OFFICIAL_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

export function isSafeImageUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') return false;
  if (/^(127\.|10\.|169\.254\.|192\.168\.)/.test(host)) return false;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  if (host === '::1' || host.startsWith('[')) return false;
  return true;
}

export function buildQuery(spool = {}) {
  const brand = String(spool.brand || '').trim();
  const color = String(spool.colorName || '').trim();
  const type = String(spool.type || '').trim();
  const seen = new Set();
  return [brand, color, type, 'filament']
    .filter(Boolean)
    .filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(' ')
    .slice(0, 120);
}

function queryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，;；/|+]+/)
    .map((t) => t.replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** 解析 Bing 图片搜索（async 接口）里的结果对象：murl / purl / title。 */
export function parseBingResults(html) {
  const out = [];
  const re = /m="([^"]*)"/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const raw = decodeEntities(m[1]);
    if (!raw.includes('murl')) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.murl === 'string' && /^https?:\/\//i.test(obj.murl)) {
        out.push({ murl: obj.murl, purl: typeof obj.purl === 'string' ? obj.purl : '', title: typeof obj.t === 'string' ? obj.t : '' });
      }
    } catch {
      /* 跳过坏对象 */
    }
  }
  return out;
}

/** 兼容旧接口：只取图片 URL 列表。 */
export function parseBingImageUrls(html) {
  return [...new Set(parseBingResults(html).map((r) => r.murl))];
}

/** 解析百度图片 JSON（对非法转义做容错）。 */
export function parseBaiduResults(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').replace(/\\'/g, "'"));
  } catch {
    return [];
  }
  const list = Array.isArray(data?.data) ? data.data : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const murl = item.middleURL || item.thumbURL || item.hoverURL || '';
    if (!/^https?:\/\//i.test(murl)) continue;
    out.push({
      murl,
      purl: typeof item.fromURL === 'string' ? item.fromURL : '',
      title: typeof item.fromPageTitleEnc === 'string' ? item.fromPageTitleEnc : '',
    });
  }
  return out;
}

/** 相关度打分：标题命中权重最高，其次来源页/图片 URL；官方域名加分。 */
export function scoreImageUrl(candidate, tokens) {
  const url = typeof candidate === 'string' ? candidate : candidate.murl || '';
  const title = typeof candidate === 'string' ? '' : String(candidate.title || '');
  const purl = typeof candidate === 'string' ? '' : String(candidate.purl || '');
  const haystacks = [
    [title.toLowerCase(), 4],
    [purl.toLowerCase(), 2],
    [String(url).toLowerCase(), 2],
  ];
  let score = 0;
  let strong = 0;
  for (const token of tokens) {
    for (const [text, weight] of haystacks) {
      if (text.includes(token)) {
        score += weight;
        strong += 1;
        break;
      }
    }
  }
  if (!/^https?:\/\//i.test(String(url))) return -100;
  if (GOOD_EXT.test(String(url).toLowerCase())) score += 1;
  if (isOfficialHost(url)) score += 4;
  if (BAD_WORDS.test(title) || BAD_WORDS.test(purl)) score -= 10;
  if (BAD_URL.test(String(url).toLowerCase())) score -= 8;
  if (/bing\.net|bing\.com/i.test(String(url))) score -= 3;
  return { score, strong, relevant: strong >= 1 };
}

async function fetchWithTimeout(url, { headers = {}, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchBingAsync(query, fetchImpl) {
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}&first=1&count=35&mkt=zh-CN&setlang=zh-hans`;
  const res = await fetchWithTimeout(url, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' }, fetchImpl });
  if (!res.ok) return [];
  return parseBingResults(await res.text());
}

async function searchBaidu(query, fetchImpl) {
  const enc = encodeURIComponent(query);
  const url =
    `https://image.baidu.com/search/acjson?tn=resultjson_com&logid=1&ipn=rj&ct=201326592&fp=result` +
    `&word=${enc}&queryWord=${enc}&cl=2&lm=-1&ie=utf-8&oe=utf-8&pn=0&rn=30&gsm=1e`;
  const res = await fetchWithTimeout(url, { headers: { Referer: 'https://image.baidu.com/' }, fetchImpl });
  if (!res.ok) return [];
  return parseBaiduResults(await res.text());
}

/**
 * 搜索候选：Bing async 为主，百度兜底；按相关性过滤后排序。
 * @returns {Promise<Array<{murl,purl,title,score,strong}>>}
 */
export async function searchImageCandidates(query, { fetchImpl = fetch, limit = 12, minScore = DEFAULT_MIN_SCORE } = {}) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  let raw = [];
  try {
    raw = await searchBingAsync(query, fetchImpl);
  } catch {
    raw = [];
  }
  if (raw.length < 4) {
    try {
      raw = raw.concat(await searchBaidu(query, fetchImpl));
    } catch {
      /* 忽略兜底失败 */
    }
  }
  const seen = new Set();
  const scored = [];
  for (const item of raw) {
    if (!item.murl || seen.has(item.murl)) continue;
    seen.add(item.murl);
    if (!isSafeImageUrl(item.murl)) continue;
    const s = scoreImageUrl(item, tokens);
    if (!s.relevant || s.score < minScore) continue; // 相关性门槛：宁可不抓，也不抓错
    scored.push({ ...item, score: s.score, strong: s.strong });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function detectImageType(buffer, contentType = '') {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (/^image\/(jpeg|jpg)/i.test(contentType)) return 'jpg';
  if (/^image\/png/i.test(contentType)) return 'png';
  if (/^image\/webp/i.test(contentType)) return 'webp';
  return '';
}

export async function downloadImage(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!isSafeImageUrl(url)) throw new Error('不允许的图片地址（内网/非 http）');
  const res = await fetchWithTimeout(url, {
    headers: { Referer: 'https://www.bing.com/', Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*' },
    timeoutMs,
    fetchImpl,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (!/^image\//i.test(contentType)) throw new Error(`不是图片（${contentType || 'unknown'}）`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('图片过大');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < MIN_BYTES) throw new Error('图片太小');
  if (buffer.length > MAX_BYTES) throw new Error('图片过大');
  const ext = detectImageType(buffer, contentType);
  if (!ext) throw new Error('无法识别的图片格式');
  return { buffer, ext, contentType, size: buffer.length };
}

// ---------- 颜色校验（可选，依赖本机 python3 + Pillow） ----------

const PY_COLOR_SCRIPT = `
import json, sys
from PIL import Image
try:
    img = Image.open(sys.argv[1]).convert('RGB')
    img = img.resize((64, 64))
    colors = img.getcolors(64 * 64) or []
    colors.sort(key=lambda c: -c[0])
    pick = None
    for count, c in colors:
        if not (c[0] > 235 and c[1] > 235 and c[2] > 235):
            pick = c
            break
    if pick is None and colors:
        pick = colors[0][1]
    if pick is None:
        print(json.dumps({'error': 'no pixels'}))
    else:
        total = 64 * 64
        kept = sum(c for c, col in colors if col == pick)
        print(json.dumps({'r': pick[0], 'g': pick[1], 'b': pick[2], 'coverage': round(kept / total, 3)}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

let pythonPillowCache = null;

async function pythonPillowAvailable() {
  if (pythonPillowCache !== null) return pythonPillowCache;
  pythonPillowCache = await new Promise((resolve) => {
    execFile('python3', ['-c', 'import PIL'], { timeout: 5000 }, (err) => resolve(!err));
  });
  return pythonPillowCache;
}

/** 用主色和料盘颜色做 ΔE 比较；环境没有 python3+Pillow 时跳过。 */
export async function verifyImageColor(buffer, targetHex, { ext = 'jpg', maxDeltaE = MAX_COLOR_DELTA_E } = {}) {
  if (process.env.PRODUCT_IMAGE_COLOR_CHECK === 'off') return { ok: true, skipped: true };
  if (!(await pythonPillowAvailable())) return { ok: true, skipped: true };
  const tmp = path.join(os.tmpdir(), `fm-color-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  fs.writeFileSync(tmp, buffer);
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('python3', ['-c', PY_COLOR_SCRIPT, tmp], { timeout: 20000 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    const data = JSON.parse(stdout);
    if (data.error) return { ok: true, skipped: true };
    if (data.coverage < 0.05) return { ok: true, skipped: true }; // 几乎全白/透明，判断不了
    const target = hexToLab(targetHex);
    if (!target) return { ok: true, skipped: true };
    const dE = deltaE2000(target, rgbToLab(data));
    return { ok: dE <= maxDeltaE, deltaE: Math.round(dE), skipped: false };
  } catch {
    return { ok: true, skipped: true };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
  }
}

/** 生成搜索词变体：从最具体到最宽松。 */
export function buildQueryVariants(spool = {}) {
  const brand = String(spool.brand || '').trim();
  const color = String(spool.colorName || '').trim();
  const type = String(spool.type || '').trim();
  const variants = [
    [brand, color, type, 'filament'].filter(Boolean).join(' '),
    [brand, color, type].filter(Boolean).join(' '),
    [color, type, 'filament'].filter(Boolean).join(' '),
    [brand, color, 'spool'].filter(Boolean).join(' '),
    [color, 'filament'].filter(Boolean).join(' '),
  ];
  return [...new Set(variants.filter((v) => v.length >= 3))];
}

/**
 * 给一盘料找商品图（只下载，不落库）。
 * @returns {Promise<{ok:true, buffer:Buffer, ext:string, sourceUrl:string, query:string, colorCheck?:object}
 *   | {ok:false, reason:string, query:string, message?:string}>}
 */
export async function fetchProductImage(spool, { fetchImpl = fetch, maxCandidates = 8, colorVerifier = verifyImageColor } = {}) {
  if (process.env.PRODUCT_IMAGES === 'off') {
    return { ok: false, reason: 'disabled', query: '', message: '商品图抓取已被 PRODUCT_IMAGES=off 关闭' };
  }
  const variants = buildQueryVariants(spool);
  if (!variants.length) return { ok: false, reason: 'empty_query', query: '', message: '缺少品牌/颜色信息，无法搜索' };

  let tried = 0;
  for (const query of variants) {
    let candidates = [];
    try {
      candidates = await searchImageCandidates(query, { fetchImpl, limit: maxCandidates });
    } catch {
      candidates = [];
    }
    if (!candidates.length) continue;
    for (const cand of candidates) {
      tried += 1;
      try {
        const img = await downloadImage(cand.murl, { fetchImpl });
        if (spool.colorHex && colorVerifier) {
          const check = await colorVerifier(img.buffer, spool.colorHex, { ext: img.ext });
          if (check && check.ok === false) continue; // 主色差太多，换下一张
          if (check && check.deltaE !== undefined) img.colorDeltaE = check.deltaE;
        }
        return { ok: true, buffer: img.buffer, ext: img.ext, sourceUrl: cand.murl, query, title: cand.title, colorDeltaE: img.colorDeltaE };
      } catch {
        /* 下一张 */
      }
    }
  }
  return {
    ok: false,
    reason: tried ? 'no_relevant_candidate' : 'no_candidates',
    query: variants[0],
    message: tried ? '搜到的图片与品牌/颜色不匹配，已放弃（避免抓到无关图）' : '没有搜到候选图片',
  };
}
