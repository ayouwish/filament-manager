// 耗材管家本地服务：零依赖 Node HTTP 服务。
// 提供静态页面、材料库存 API、3mf 解析、MakerWorld 解析、匹配与扣减。
//
// 启动：node server.mjs           （默认 http://127.0.0.1:4173）
//      node server.mjs --lan     （监听 0.0.0.0，方便手机同一 Wi-Fi 访问）

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.mjs';
import { matchRequirements, DEFAULT_MATCH_OPTIONS } from './lib/match.mjs';
import { parse3mf, mergePlateRequirements } from './lib/threemf.mjs';
import { resolveMakerWorld, extractFromPageHtml, parseMakerWorldUrl } from './lib/makerworld.mjs';
import { recognizeFilaments, detectVisionProvider } from './lib/vision.mjs';
import { fetchProductImage } from './lib/product-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = path.join(ROOT, 'web');
const PHOTO_DIR = store.PHOTO_DIR;
function readPortArg(argv) {
  const i = argv.indexOf('--port');
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  const eq = argv.find((a) => a.startsWith('--port='));
  return eq ? Number(eq.split('=')[1]) : null;
}
const CLI_PORT = readPortArg(process.argv.slice(2));
const PORT = Number(CLI_PORT || process.env.PORT || 4173);
// 可选访问令牌：部署到 NAS/局域网时建议设置；未设置则保持原来的开放访问
const API_TOKEN = process.env.FM_TOKEN || '';
const HOST = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.3mf': 'application/octet-stream',
};

// 浏览器油猴脚本导入的临时结果（内存缓存，重启即失效）
const PENDING_IMPORTS = new Map();

// 入库后自动拉商品图的后台队列（AUTO_PRODUCT_IMAGES=off 可关闭）
const AUTO_PRODUCT_IMAGES = process.env.AUTO_PRODUCT_IMAGES !== 'off';
const imageQueue = { pending: new Set(), running: false, done: 0, failed: 0 };

async function runImageQueue() {
  if (imageQueue.running) return;
  imageQueue.running = true;
  try {
    while (imageQueue.pending.size) {
      const id = imageQueue.pending.values().next().value;
      imageQueue.pending.delete(id);
      try {
        const spool = store.readDb().spools.find((s) => s.id === id);
        if (spool && !spool.productPhoto) {
          const r = await fetchProductImage(spool);
          if (r.ok) {
            const photo = store.saveProductImage(id, r.buffer, r.ext);
            store.setProductPhoto(id, { photo, sourceUrl: r.sourceUrl, query: r.query });
            imageQueue.done++;
          } else {
            imageQueue.failed++;
          }
        }
      } catch {
        imageQueue.failed++;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally {
    imageQueue.running = false;
  }
}

function queueProductImages(ids) {
  if (!AUTO_PRODUCT_IMAGES || process.env.PRODUCT_IMAGES === 'off') return;
  let added = false;
  for (const id of ids || []) {
    if (id && !imageQueue.pending.has(id)) {
      imageQueue.pending.add(id);
      added = true;
    }
  }
  if (added) runImageQueue();
}

function storePendingImport(payload) {
  const id = Math.random().toString(16).slice(2, 10);
  PENDING_IMPORTS.set(id, { payload, createdAt: Date.now() });
  while (PENDING_IMPORTS.size > 20) {
    PENDING_IMPORTS.delete(PENDING_IMPORTS.keys().next().value);
  }
  return id;
}

const SAMPLE_MODEL = {
  title: '示例：三色拼装小夜灯（MakerWorld 模型模拟）',
  sourceUrl: 'https://makerworld.com/zh/models/0000000-sample',
  cover: '',
  sample: true,
  plates: [],
  warnings: ['这是内置示例需求，用来演示自动选料；真实使用时请粘贴 MakerWorld 链接或上传 .3mf。'],
  requirements: [
    { index: 1, type: 'PLA', colorHex: '#17181A', colorName: '黑色', grams: 120, display: '黑色 / PLA' },
    { index: 2, type: 'PLA', colorHex: '#F2F2EE', colorName: '白色', grams: 600, display: '白色 / PLA' },
    { index: 3, type: 'PLA', colorHex: '#C62828', colorName: '红色', grams: 30, display: '红色 / PLA' },
    { index: 4, type: 'PETG', colorHex: '#E0A030', colorName: '琥珀', grams: 60, display: '琥珀 / PETG' },
  ],
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, message, extra = {}) {
  json(res, status, { error: message, ...extra });
}

async function readJsonBody(req, limit = 64 * 1024 * 1024) { // 3mf(base64) 可能较大
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

function serveFile(res, baseDir, relPath, { cache = false } = {}) {
  let safeRel;
  try {
    safeRel = path.normalize(decodeURIComponent(relPath)).replace(/^([/\\])+/, '');
  } catch {
    fail(res, 400, '非法路径');
    return;
  }
  const filePath = path.join(baseDir, safeRel);
  if (!filePath.startsWith(baseDir + path.sep)) {
    fail(res, 403, '禁止访问');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fail(res, 404, '文件不存在');
    return;
  }
  if (!stat.isFile()) {
    fail(res, 404, '文件不存在');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache',
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) fail(res, 500, '读取文件失败');
    else res.destroy();
  });
  stream.pipe(res);
}

function requireSpool(id) {
  const spool = store.getSpool(id);
  if (!spool) throw Object.assign(new Error('材料不存在'), { status: 404 });
  return spool;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function tokenAllowed(req, url) {
  if (!API_TOKEN) return true;
  if (url.pathname === '/api/health') return true; // 供客户端"测试连接"
  const header = req.headers['x-fm-token'];
  const query = url.searchParams.get('token');
  return (typeof header === 'string' && safeEqual(header, API_TOKEN)) || (query && safeEqual(query, API_TOKEN));
}

function publicVisionSettings(vision = {}) {
  return {
    provider: vision.provider || '',
    baseUrl: vision.baseUrl || '',
    model: vision.model || '',
    hasApiKey: Boolean(vision.apiKey),
  };
}

function mergeVisionSettings(prev, input) {
  const out = { ...prev };
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  if (input.provider !== undefined) out.provider = ['ollama', 'openai', 'anthropic', ''].includes(String(input.provider))
    ? String(input.provider)
    : '';
  if (input.baseUrl !== undefined) out.baseUrl = text(input.baseUrl, 300);
  if (input.model !== undefined) out.model = text(input.model, 100);
  if (input.reasoningEffort !== undefined) {
    const v = String(input.reasoningEffort).toLowerCase();
    out.reasoningEffort = ['minimal', 'low', 'medium', 'high'].includes(v) ? v : '';
  }
  if (input.maxTokens !== undefined) {
    const n = Number(input.maxTokens);
    if (Number.isFinite(n)) out.maxTokens = Math.min(16000, Math.max(256, Math.round(n)));
  }
  if (input.apiKey !== undefined) {
    // 空字符串表示保留原 key；显式 clearApiKey 才清除
    const key = String(input.apiKey || '').trim();
    if (key) out.apiKey = key.slice(0, 300);
  }
  if (input.clearApiKey === true) delete out.apiKey;
  return out;
}

const ALLOWED_CROSS_ORIGIN = /^https:\/\/(www\.)?makerworld\.com$/;

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  if (method === 'GET' && parts[0] === 'health') {
    return json(res, 200, { ok: true, version: 1 });
  }

  if (method === 'GET' && parts[0] === 'state') {
    const db = store.readDb();
    return json(res, 200, {
      spools: db.spools,
      jobs: db.jobs,
      settings: {
        match: db.settings?.match || {},
        vision: publicVisionSettings(db.settings?.vision || {}),
      },
      matchDefaults: DEFAULT_MATCH_OPTIONS,
      productImageQueue: {
        pending: imageQueue.pending.size,
        running: imageQueue.running,
        done: imageQueue.done,
        failed: imageQueue.failed,
      },
    });
  }

  if (parts[0] === 'spools') {
    if (method === 'GET' && parts.length === 1) return json(res, 200, { spools: store.listSpools() });
    if (method === 'POST' && parts.length === 1) {
      const body = await readJsonBody(req);
      const spool = store.createSpool(body);
      queueProductImages([spool.id]);
      return json(res, 201, { spool });
    }
    const id = parts[1];
    if (method === 'PUT' && parts.length === 2) {
      requireSpool(id);
      const body = await readJsonBody(req);
      const spool = store.updateSpool(id, body);
      return json(res, 200, { spool });
    }
    if (method === 'DELETE' && parts.length === 2) {
      const ok = store.deleteSpool(id);
      return ok ? json(res, 200, { ok: true }) : fail(res, 404, '材料不存在');
    }
    if (method === 'POST' && parts.length === 3 && parts[2] === 'consume') {
      requireSpool(id);
      const body = await readJsonBody(req);
      const spool = store.consumeSpool(id, body.grams);
      return json(res, 200, { spool });
    }
  }

  if (method === 'POST' && parts[0] === 'match') {
    const body = await readJsonBody(req);
    const requirements = Array.isArray(body.requirements) ? body.requirements.filter((r) => r && typeof r === 'object') : [];
    if (!requirements.length) return fail(res, 400, '缺少 requirements');
    for (const r of requirements) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(r.colorHex || ''))) {
        return fail(res, 400, 'requirements 里的颜色格式应为 #RRGGBB');
      }
      if (r.grams !== null && r.grams !== undefined && !Number.isFinite(Number(r.grams))) {
        return fail(res, 400, 'requirements 里的克重必须是数字或留空');
      }
    }
    const db = store.readDb();
    const result = matchRequirements(requirements, db.spools, { ...(db.settings?.match || {}), ...(body.options || {}) });
    return json(res, 200, { ...result, spools: db.spools });
  }

  if (method === 'GET' && parts[0] === 'pending' && parts[1]) {
    const item = PENDING_IMPORTS.get(parts[1]);
    if (!item || Date.now() - item.createdAt > 30 * 60 * 1000) {
      PENDING_IMPORTS.delete(parts[1]);
      return fail(res, 404, '导入结果不存在或已过期');
    }
    return json(res, 200, { payload: item.payload });
  }

  if (method === 'GET' && parts[0] === 'sample') {
    return json(res, 200, { model: SAMPLE_MODEL });
  }

  if (method === 'GET' && parts[0] === 'net') {
    const urls = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) {
          urls.push({ name, address: a.address, url: `http://${a.address}:${PORT}` });
        }
      }
    }
    return json(res, 200, { port: PORT, host: HOST, lanEnabled: HOST === '0.0.0.0', urls });
  }

  if (method === 'GET' && parts[0] === 'vision' && parts[1] === 'status') {
    const db = store.readDb();
    const status = await detectVisionProvider({ settings: db.settings || {}, force: true });
    return json(res, 200, {
      ready: status.ready,
      provider: status.provider || '',
      model: status.model || '',
      reason: status.reason || '',
      availableModels: status.availableModels || [],
    });
  }

  if (method === 'POST' && parts[0] === 'recognize') {
    const body = await readJsonBody(req, 12 * 1024 * 1024);
    const b64 = String(body.base64 || body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!b64) return fail(res, 400, '缺少图片数据');
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length < 16) return fail(res, 400, '图片数据太小或解码失败');
    if (buffer.length > 10 * 1024 * 1024) return fail(res, 413, '图片太大（上限 10MB）');
    const mime = /^data:(image\/[a-z+]+)/i.exec(String(body.base64 || ''))?.[1]
      || (buffer.subarray(0, 8).toString('hex').startsWith('89504e47') ? 'image/png' : 'image/jpeg');
    const db = store.readDb();
    const result = await recognizeFilaments({
      imageBase64: b64,
      mime,
      settings: db.settings || {},
      brandHint: String(body.brandHint || '').slice(0, 60),
    });
    return json(res, result.ok ? 200 : 422, result);
  }

  if (method === 'POST' && parts[0] === 'spools' && parts[1] === 'merge-duplicates') {
    const result = store.mergeDuplicateSpools();
    return json(res, 200, { ok: true, ...result });
  }

  if (method === 'POST' && parts[0] === 'spools' && parts[1] === 'product-images') {
    const body = await readJsonBody(req);
    const db = store.readDb();
    const force = Boolean(body.force);
    const limit = Math.min(10, Math.max(1, Number(body.limit) || 10));
    const ids = Array.isArray(body.ids) ? body.ids : null;
    let candidates = ids ? db.spools.filter((s2) => ids.includes(s2.id)) : db.spools.slice();
    if (!force) candidates = candidates.filter((s2) => !s2.productPhoto);
    candidates = candidates.slice(0, limit);
    const results = [];
    for (const spool of candidates) {
      const r = await fetchProductImage(spool);
      if (!r.ok) {
        results.push({ id: spool.id, name: spool.name, ok: false, error: r.message || r.reason });
        continue;
      }
      const photo = store.saveProductImage(spool.id, r.buffer, r.ext);
      store.setProductPhoto(spool.id, { photo, sourceUrl: r.sourceUrl, query: r.query });
      results.push({ id: spool.id, name: spool.name, ok: true, query: r.query, sourceUrl: r.sourceUrl });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return json(res, 200, {
      results,
      fetched: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
  }

  if ((method === 'POST' || method === 'DELETE') && parts[0] === 'spools' && parts[2] === 'product-image') {
    const spool = requireSpool(parts[1]);
    if (method === 'DELETE') {
      const updated = store.clearProductPhoto(spool.id);
      return json(res, 200, { ok: true, spool: updated });
    }
    const body = await readJsonBody(req);
    if (spool.productPhoto && !body.force) {
      return json(res, 200, { ok: true, cached: true, spool });
    }
    const r = await fetchProductImage(spool);
    if (!r.ok) {
      return json(res, 422, { ok: false, reason: r.reason, message: r.message, query: r.query });
    }
    const photo = store.saveProductImage(spool.id, r.buffer, r.ext);
    const updated = store.setProductPhoto(spool.id, { photo, sourceUrl: r.sourceUrl, query: r.query });
    return json(res, 200, { ok: true, spool: updated, query: r.query, sourceUrl: r.sourceUrl });
  }

  if (method === 'POST' && parts[0] === 'spools' && parts[1] === 'bulk') {
    const body = await readJsonBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return fail(res, 400, '缺少 items');
    if (items.length > 30) return fail(res, 400, '一次最多导入 30 盘');
    const created = store.bulkCreateSpools(items, { photoDataUrl: body.photoDataUrl || '' });
    queueProductImages(created.map((s) => s.id));
    return json(res, 201, { spools: created });
  }

  if (method === 'POST' && parts[0] === 'makerworld' && parts[1] === 'resolve') {
    const body = await readJsonBody(req);
    const parsed = parseMakerWorldUrl(body.url || '');
    if (!parsed.ok) return fail(res, 400, parsed.message);
    // 合规考虑：Cookie/clearance 不落盘，只接受进程环境变量临时注入
    const cookie = process.env.MAKERWORLD_COOKIE || '';
    const result = await resolveMakerWorld(body.url, { cookie });
    return json(res, result.ok ? 200 : 422, result);
  }

  if (method === 'POST' && parts[0] === 'import' && (parts[1] === '3mf' || parts[1] === 'page')) {
    if (parts[1] === '3mf') {
      const body = await readJsonBody(req);
      const b64 = String(body.base64 || body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!b64) return fail(res, 400, '缺少 base64 文件内容');
      let buffer;
      try {
        buffer = Buffer.from(b64, 'base64');
      } catch {
        return fail(res, 400, 'base64 解码失败');
      }
      if (buffer.subarray(0, 2).toString() !== 'PK') return fail(res, 400, '不是有效的 .3mf（zip）文件');
      let model;
      try {
        model = parse3mf(buffer, { filename: body.filename || 'model.3mf' });
      } catch (err) {
        return fail(res, 422, `解析 3mf 失败：${err.message}`);
      }
      const requirements = mergePlateRequirements(model.plates);
      return json(res, 200, {
        ok: true,
        source: '3mf',
        title: model.title,
        cover: '',
        plates: model.plates,
        project: { printerModel: model.project.printerModel, nozzle: model.project.nozzle },
        requirements,
        warnings: model.warnings,
      });
    }
    // 页面数据导入（浏览器油猴脚本把 __NEXT_DATA__/页面信息 POST 过来）
    const body = await readJsonBody(req);
    const parsedUrl = parseMakerWorldUrl(body.url || '');
    const page = extractFromPageHtml(body.html || '', { designId: parsedUrl.designId });
    const requirements = page.requirements;
    const payload = {
      ok: requirements.length > 0,
      source: 'makerworld+page',
      title: body.title || page.title,
      cover: body.cover || page.cover,
      sourceUrl: parsedUrl.url || body.url || '',
      requirements,
      plates: [],
      warnings: page.warnings,
      message: requirements.length ? '' : '页面里没有解析到材料需求',
    };
    const importId = storePendingImport(payload);
    return json(res, requirements.length ? 200 : 422, { ...payload, importId });
  }

  if (parts[0] === 'jobs') {
    if (method === 'GET') return json(res, 200, { jobs: store.listJobs() });
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.items) || !body.items.length) return fail(res, 400, '缺少扣减明细 items');
      const job = store.addJob({
        title: body.title,
        sourceUrl: body.sourceUrl,
        items: body.items,
        note: body.note,
      });
      return json(res, 201, { job, spools: store.listSpools() });
    }
  }

  if (parts[0] === 'settings') {
    if (method === 'GET') {
      const s = store.getSettings();
      return json(res, 200, {
        settings: { match: s.match || {}, vision: publicVisionSettings(s.vision || {}) },
      });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const patch = {};
      if (body.match && typeof body.match === 'object') patch.match = body.match;
      if (body.vision && typeof body.vision === 'object') {
        patch.vision = mergeVisionSettings(store.getSettings().vision || {}, body.vision);
      }
      const saved = store.updateSettings(patch);
      return json(res, 200, {
        settings: { match: saved.match || {}, vision: publicVisionSettings(saved.vision || {}) },
      });
    }
  }

  return fail(res, 404, `未知接口 ${method} ${url.pathname}`);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return fail(res, 400, '非法请求路径');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      const isPageImport = url.pathname === '/api/import/page';
      const isHealth = url.pathname === '/api/health';
      if (isHealth && origin) {
        // 只暴露 ok/version，允许从其它本地端口探测"新版服务是否在跑"
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
      }
      const allowedCross = Boolean(origin && ALLOWED_CROSS_ORIGIN.test(origin) && isPageImport);
      // 阻止任意网页跨域读写本地库存/打印记录（CSRF / 数据泄露）
      if (origin && !sameOrigin(req) && !allowedCross && !isHealth) {
        return fail(res, 403, '跨域请求被拒绝');
      }
      if (allowedCross) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Vary', 'Origin');
      } else if (!origin) {
        // 同源/本机命令行调用不需要 CORS 头
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      // 可选令牌校验（健康检查除外）
      if (!tokenAllowed(req, url)) {
        return fail(res, 401, '需要访问令牌：请在请求头带上 x-fm-token（或在客户端设置里填 FM_TOKEN）');
      }
      try {
        return await handleApi(req, res, url);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) {
          console.error('[api]', err);
          return fail(res, 500, '服务器内部错误（详情见服务端日志）');
        }
        return fail(res, status, err.message || '请求无效');
      }
    }

    if (url.pathname.startsWith('/data/photos/')) {
      return serveFile(res, PHOTO_DIR, url.pathname.replace('/data/photos/', ''), { cache: true });
    }
    if (url.pathname.startsWith('/lib/')) {
      // 前端直接复用颜色工具（/lib/color.mjs），避免算法两份实现
      return serveFile(res, path.join(ROOT, 'lib'), url.pathname.replace('/lib/', ''));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveFile(res, WEB_DIR, 'index.html');
    }
    return serveFile(res, WEB_DIR, url.pathname);
    } catch (err) {
      if (!res.headersSent) return fail(res, err.status || 500, err.message || '服务器错误');
      res.destroy();
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer();

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n启动失败：端口 ${PORT} 已被占用。`);
      let existing = false;
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
          signal: AbortSignal.timeout(1200),
        });
        const data = await res.json().catch(() => ({}));
        existing = res.ok && data.version === 1;
      } catch {
        /* 占用者不响应 HTTP，忽略 */
      }
      if (existing) {
        console.error(`检测到已有一个「耗材管家」在 http://127.0.0.1:${PORT} 运行（很可能是之前的窗口没关）。`);
        console.error('它默认只监听本机；要开局域网/手机访问，请先停掉旧实例，或者换个端口。');
      } else {
        console.error('占用该端口的进程不是「耗材管家」。');
      }
      console.error('  • 停止旧实例：pkill -f "node server.mjs"    （Windows：任务管理器里结束 node.exe）');
      console.error(`  • 或者换端口：node server.mjs --port ${PORT + 1}${process.argv.includes('--lan') ? ' --lan' : ''}`);
      console.error(`                （等价于 PORT=${PORT + 1} node server.mjs${process.argv.includes('--lan') ? ' --lan' : ''}）`);
      process.exit(1);
    }
    console.error('启动失败：', err.message);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    console.log(`耗材管家已启动：http://${shown}:${PORT}`);
    if (HOST === '0.0.0.0') {
      const lan = [];
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) lan.push(`http://${a.address}:${PORT}  (${name})`);
        }
      }
      if (lan.length) {
        console.log('局域网访问地址（手机需在同一 Wi-Fi）：');
        for (const url of lan) console.log(`  ${url}`);
      }
    }
    console.log(`数据目录：${store.DATA_DIR}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
