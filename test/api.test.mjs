import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 import server 前指定数据目录（store 在模块加载时读取环境变量）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'));
process.env.FM_DATA_DIR = TMP;
process.env.AUTO_PRODUCT_IMAGES = 'off'; // 测试里不联网抓商品图

const { createServer } = await import('../server.mjs');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const slicedB64 = fs.readFileSync(fileURLToPath(new URL('./fixtures/sliced.3mf', import.meta.url))).toString('base64');

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('健康检查与首页', async () => {
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  const home = await fetch(`${BASE}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /耗材管家/);
  const lib = await fetch(`${BASE}/lib/color.mjs`);
  assert.equal(lib.status, 200);
  assert.match(await lib.text(), /deltaE2000/);
});

test('初始数据：示例库存 + 空记录', async () => {
  const { data } = await call('/api/state');
  assert.equal(data.spools.length, 6);
  assert.deepEqual(data.jobs, []);
  assert.ok(data.matchDefaults.maxDeltaE > 0);
});

test('示例模型自动匹配：成功 / 缺料 / 颜色差异大', async () => {
  const sample = await call('/api/sample');
  const requirements = sample.data.model.requirements;
  assert.equal(requirements.length, 4);
  const match = await call('/api/match', { method: 'POST', body: { requirements } });
  assert.equal(match.status, 200);
  const byColor = Object.fromEntries(match.data.assignments.map((a) => [a.requirement.colorHex, a]));
  assert.equal(byColor['#17181A'].status, 'ok'); // 黑有库存
  assert.equal(byColor['#F2F2EE'].status, 'insufficient'); // 需要 600，只有 520
  assert.equal(byColor['#F2F2EE'].shortfallGrams, 80);
  assert.equal(byColor['#C62828'].status, 'ok');
  assert.equal(byColor['#E0A030'].status, 'color_far'); // PETG 有，但没有琥珀色
});

test('上传未切片 3mf：无克重 + 警告', async () => {
  const unslicedB64 = fs.readFileSync(fileURLToPath(new URL('./fixtures/unsliced.3mf', import.meta.url))).toString('base64');
  const { status, data } = await call('/api/import/3mf', { method: 'POST', body: { filename: 'project.3mf', base64: unslicedB64 } });
  assert.equal(status, 200);
  assert.equal(data.requirements.length, 2);
  assert.equal(data.requirements[0].grams, null);
  assert.ok(data.warnings.some((w) => w.includes('未切片')));
  const match = await call('/api/match', { method: 'POST', body: { requirements: data.requirements } });
  assert.equal(match.status, 200);
  assert.equal(match.data.summary.gramsKnown, false);
});

test('上传 3mf 解析出精确需求', async () => {
  const { status, data } = await call('/api/import/3mf', {
    method: 'POST',
    body: { filename: 'sample.3mf', base64: slicedB64 },
  });
  assert.equal(status, 200);
  assert.equal(data.requirements.length, 3);
  const black = data.requirements.find((r) => r.colorHex === '#17181A');
  assert.equal(black.grams, 120.4);
  assert.equal(data.plates.length, 2);
});

test('新增材料与手动扣减', async () => {
  const created = await call('/api/spools', {
    method: 'POST',
    body: { name: '测试灰', brand: 'Test', type: 'PLA', colorHex: '#8A8F98', totalGrams: 1000, remainingGrams: 800 },
  });
  assert.equal(created.status, 201);
  const spool = created.data.spool;
  assert.equal(spool.colorName, '灰色');

  const consumed = await call(`/api/spools/${spool.id}/consume`, { method: 'POST', body: { grams: 50 } });
  assert.equal(consumed.status, 200);
  assert.equal(consumed.data.spool.remainingGrams, 750);

  const updated = await call(`/api/spools/${spool.id}`, { method: 'PUT', body: { remainingGrams: 500 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.spool.remainingGrams, 500);

  const deleted = await call(`/api/spools/${spool.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
});

test('确认扣减生成打印记录并更新余量', async () => {
  const state = await call('/api/state');
  const black = state.data.spools.find((s) => s.colorHex === '#17181A');
  const before = black.remainingGrams;
  const job = await call('/api/jobs', {
    method: 'POST',
    body: { title: '三色小夜灯', sourceUrl: 'https://makerworld.com/zh/models/1', items: [{ spoolId: black.id, grams: 120 }] },
  });
  assert.equal(job.status, 201);
  assert.equal(job.data.job.totalGrams, 120);
  const after = job.data.spools.find((s) => s.id === black.id);
  assert.equal(after.remainingGrams, before - 120);
  const jobs = await call('/api/jobs');
  assert.equal(jobs.data.jobs.length, 1);
});

test('非法链接与非法请求被拒绝', async () => {
  const badUrl = await call('/api/makerworld/resolve', { method: 'POST', body: { url: 'https://example.com/x' } });
  assert.equal(badUrl.status, 400);
  const bad3mf = await call('/api/import/3mf', { method: 'POST', body: { base64: Buffer.from('hello').toString('base64') } });
  assert.equal(bad3mf.status, 400);
  const badMatch = await call('/api/match', { method: 'POST', body: { requirements: [] } });
  assert.equal(badMatch.status, 400);
  const badColor = await call('/api/match', { method: 'POST', body: { requirements: [{ index: 1, type: 'PLA', colorHex: 'red', grams: 10 }] } });
  assert.equal(badColor.status, 400);
});

test('扣减接口做二次校验：未知料盘 / 超量 / 重复', async () => {
  const state = await call('/api/state');
  const spoolA = state.data.spools[0];
  const unknown = await call('/api/jobs', { method: 'POST', body: { title: 'x', items: [{ spoolId: 's_nope', grams: 1 }] } });
  assert.equal(unknown.status, 404);

  const over = await call('/api/jobs', {
    method: 'POST',
    body: { title: 'x', items: [{ spoolId: spoolA.id, grams: spoolA.remainingGrams + 99999 }] },
  });
  assert.equal(over.status, 409);

  const dup = await call('/api/jobs', {
    method: 'POST',
    body: { title: 'x', items: [{ spoolId: spoolA.id, grams: 1 }, { spoolId: spoolA.id, grams: 1 }] },
  });
  assert.equal(dup.status, 400);
});

test('健康检查允许跨域探测（只暴露 ok/version）', async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: { Origin: 'http://127.0.0.1:4173' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const data = await res.json();
  assert.deepEqual(Object.keys(data).sort(), ['ok', 'version']);
});

test('CORS：陌生网页跨域读写被拒绝，MakerWorld 页面导入放行', async () => {
  const base = BASE;
  const evil = await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);

  const evilWrite = await fetch(`${base}/api/spools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'hack', colorHex: '#000000', totalGrams: 1000 }),
  });
  assert.equal(evilWrite.status, 403);

  const pageImport = await fetch(`${base}/api/import/page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://makerworld.com' },
    body: JSON.stringify({ url: 'https://makerworld.com/zh/models/123', title: 't', html: '<html></html>' }),
  });
  assert.equal(pageImport.status, 422); // 解析不到材料，但不是 CORS 拒绝
  assert.equal(pageImport.headers.get('access-control-allow-origin'), 'https://makerworld.com');
});

test('批量创建材料（图片识别导入）', async () => {
  const before = (await call('/api/state')).data.spools.length;
  const { status, data } = await call('/api/spools/bulk', {
    method: 'POST',
    body: {
      items: [
        { name: 'Forest Green PLA', type: 'PLA', colorHex: '#519F61', totalGrams: 1000, remainingGrams: 1000 },
        { name: 'Muted Blue PLA', type: 'PLA', colorHex: '#4E6A84', totalGrams: 1000, remainingGrams: 1000 },
      ],
    },
  });
  assert.equal(status, 201);
  assert.equal(data.spools.length, 2);
  assert.equal((await call('/api/state')).data.spools.length, before + 2);
});

test('手机访问信息与 PWA 资源', async () => {
  const net = await call('/api/net');
  assert.equal(net.status, 200);
  assert.equal(typeof net.data.port, 'number');
  assert.equal(typeof net.data.lanEnabled, 'boolean');
  assert.ok(Array.isArray(net.data.urls));

  const manifest = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /manifest\+json/);
  const m = await manifest.json();
  assert.equal(m.short_name, '耗材管家');
  assert.ok(m.icons.length >= 2);

  for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
    const res = await fetch(`${BASE}${icon}`);
    assert.equal(res.status, 200, icon);
    assert.equal(res.headers.get('content-type'), 'image/png');
  }
});

test('商品图接口：关闭抓取时 422，删除接口可用', async () => {
  const state = await call('/api/state');
  const spool = state.data.spools[0];
  process.env.PRODUCT_IMAGES = 'off';
  try {
    const res = await call(`/api/spools/${spool.id}/product-image`, { method: 'POST', body: {} });
    assert.equal(res.status, 422);
    assert.equal(res.data.reason, 'disabled');
  } finally {
    delete process.env.PRODUCT_IMAGES;
  }
  const cleared = await call(`/api/spools/${spool.id}/product-image`, { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.spool.productPhoto, '');
});

test('入库自动拉图：state 暴露队列，关闭抓取时不入队', async () => {
  const state0 = await call('/api/state');
  assert.ok(state0.data.productImageQueue, 'state 应包含 productImageQueue');
  assert.equal(typeof state0.data.productImageQueue.pending, 'number');

  process.env.PRODUCT_IMAGES = 'off';
  try {
    const created = await call('/api/spools', {
      method: 'POST',
      body: { name: 'AutoQueue Test', brand: 'Polymaker', type: 'PLA', colorHex: '#123456', totalGrams: 1000, remainingGrams: 1000 },
    });
    assert.equal(created.status, 201);
    const st = await call('/api/state');
    assert.equal(st.data.productImageQueue.pending, 0);
    assert.equal(st.data.productImageQueue.running, false);
    await call(`/api/spools/${created.data.spool.id}`, { method: 'DELETE' });
  } finally {
    delete process.env.PRODUCT_IMAGES;
  }
});

test('同款多盒按 count 合并入库，并提供合并重复接口', async () => {
  const created = await call('/api/spools', {
    method: 'POST',
    body: { name: 'Merge Test PLA', brand: 'Panchroma', type: 'PLA', colorHex: '#DE1619', count: 2, spoolWeightG: 1000 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.spool.count, 2);
  assert.equal(created.data.spool.totalGrams, 2000);

  const second = await call('/api/spools', {
    method: 'POST',
    body: { name: 'Merge Test PLA', brand: 'Panchroma', type: 'PLA', colorHex: '#DE1619', count: 1, spoolWeightG: 1000 },
  });
  assert.equal(second.status, 201);

  const merged = await call('/api/spools/merge-duplicates', { method: 'POST', body: {} });
  assert.equal(merged.status, 200);
  assert.ok(merged.data.mergedGroups >= 1);
  const kept = merged.data.spools.filter((s) => s.name === 'Merge Test PLA');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].count, 3);
  assert.equal(kept[0].totalGrams, 3000);
});

test('设置可保存', async () => {
  const saved = await call('/api/settings', { method: 'POST', body: { match: { maxDeltaE: 10, goodDeltaE: 6 } } });
  assert.equal(saved.status, 200);
  const state = await call('/api/state');
  assert.equal(state.data.settings.match.maxDeltaE, 10);
});
