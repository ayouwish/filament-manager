import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// 端到端：/api/recognize 路由 + 批量入库，用一个 mock 的 OpenAI 兼容视觉服务
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-vision-api-'));
const rawFixture = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/recognize-panchroma.raw.txt', import.meta.url)),
  'utf8',
);
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// mock 视觉服务
const seenSessions = [];
const mockProvider = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  seenSessions.push(req.headers['x-opencode-session'] || '');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: rawFixture } }],
    }),
  );
});
await new Promise((r) => mockProvider.listen(0, '127.0.0.1', r));
const mockPort = mockProvider.address().port;

// 写入带识别配置的数据库
fs.writeFileSync(
  path.join(TMP, 'db.json'),
  JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spools: [],
    jobs: [],
    settings: {
      match: {},
      vision: { provider: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'mock-vl', apiKey: 'test-key' },
    },
  }),
);
process.env.FM_DATA_DIR = TMP;

const { createServer } = await import('../server.mjs');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

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
  mockProvider.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('识别状态：已配置的视觉服务可用', async () => {
  const { status, data } = await call('/api/vision/status');
  assert.equal(status, 200);
  assert.equal(data.ready, true);
  assert.equal(data.provider, 'openai');
  assert.equal(data.model, 'mock-vl');
});

test('图片识别接口返回 10 项 Panchroma 耗材', async () => {
  const { status, data } = await call('/api/recognize', {
    method: 'POST',
    body: { base64: PNG_1PX, mimeType: 'image/png' },
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.items.length, 10);
  const forest = data.items.find((i) => i.colorName === 'Matte Forest Green');
  assert.equal(forest.colorHex, '#519F61');
  assert.equal(forest.material, 'PLA');
  assert.ok(seenSessions.length >= 1 && seenSessions[0].startsWith('fm-'));
});

test('识别结果可批量入库，且不泄漏 API Key', async () => {
  const recog = await call('/api/recognize', { method: 'POST', body: { base64: PNG_1PX } });
  const spools = recog.data.items.map((it) => ({
    name: `${it.colorName} ${it.material}`,
    brand: it.brand,
    type: it.material,
    colorHex: it.colorHex,
    totalGrams: it.spoolWeightG,
    remainingGrams: it.spoolWeightG,
    note: it.sku ? `SKU ${it.sku}` : '',
  }));
  const bulk = await call('/api/spools/bulk', { method: 'POST', body: { items: spools } });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.data.spools.length, 10);

  const state = await call('/api/state');
  assert.equal(state.data.spools.length, 10);
  assert.equal(state.data.settings.vision.hasApiKey, true);
  assert.equal(JSON.stringify(state.data).includes('test-key'), false);
});
