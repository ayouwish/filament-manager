import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 令牌模式独立进程：设置 FM_TOKEN 后再加载 server
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-token-'));
process.env.FM_DATA_DIR = TMP;
process.env.AUTO_PRODUCT_IMAGES = 'off'; // 测试里不联网抓商品图
process.env.FM_TOKEN = 'secret-token-123';

const { createServer } = await import('../server.mjs');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('设置 FM_TOKEN 后：健康检查开放，其余接口要求令牌', async () => {
  const health = await fetch(`${BASE}/api/health`);
  assert.equal(health.status, 200);

  const noToken = await fetch(`${BASE}/api/state`);
  assert.equal(noToken.status, 401);

  const wrong = await fetch(`${BASE}/api/state`, { headers: { 'x-fm-token': 'nope' } });
  assert.equal(wrong.status, 401);

  const withHeader = await fetch(`${BASE}/api/state`, { headers: { 'x-fm-token': 'secret-token-123' } });
  assert.equal(withHeader.status, 200);
  assert.ok(Array.isArray((await withHeader.json()).spools));

  const withQuery = await fetch(`${BASE}/api/state?token=secret-token-123`);
  assert.equal(withQuery.status, 200);

  const post = await fetch(`${BASE}/api/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirements: [{ index: 1, type: 'PLA', colorHex: '#17181A', grams: 10 }] }),
  });
  assert.equal(post.status, 401);
});
