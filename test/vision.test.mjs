import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseRecognitionJson,
  normalizeRecognitionItems,
  recognizeFilaments,
  detectVisionProvider,
  buildRecognitionPrompt,
  matchCatalogColor,
  hintColorHex,
  inferMaterial,
  loadCatalog,
  resetVisionDetectionCache,
  mergeSimilarItems,
} from '../lib/vision.mjs';

const raw = fs.readFileSync(fileURLToPath(new URL('./fixtures/recognize-panchroma.raw.txt', import.meta.url)), 'utf8');
const expected = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('./fixtures/recognize-panchroma.expected.json', import.meta.url)), 'utf8'),
);

test('色卡与色名映射', () => {
  assert.ok(loadCatalog().length > 100);
  assert.equal(matchCatalogColor('Matte Forest Green'), '#519F61');
  assert.equal(matchCatalogColor('Forest Green'), '#519F61');
  assert.equal(matchCatalogColor('Matte Savannah Yellow'), '#F0BE02');
  assert.equal(matchCatalogColor('Army Beige'), '#CCA897');
  assert.equal(matchCatalogColor('Silk Water'), null); // 不在色卡里，交给模型/字典
  assert.equal(hintColorHex('Silk Water'), '#3E8ED0');
  assert.equal(inferMaterial('Panchroma PLA Matte'), 'PLA');
  assert.equal(inferMaterial('PETG-CF'), 'PETG');
  assert.equal(inferMaterial('Nylon PA12'), 'PA');
});

test('解析真实模型响应（Panchroma 10 盒照片）', () => {
  const parsed = parseRecognitionJson(raw);
  assert.equal(parsed.items.length, 10);
  const warnings = [];
  const items = normalizeRecognitionItems(parsed.items, { warnings });
  assert.equal(items.length, 10);
  assert.equal(warnings.length, 0);

  const byName = Object.fromEntries(items.map((i) => [i.colorName, i]));
  assert.ok(byName['Matte Forest Green']);
  assert.equal(byName['Matte Forest Green'].material, 'PLA');
  assert.equal(byName['Matte Forest Green'].colorHex, '#519F61');
  assert.equal(byName['Matte Forest Green'].hexSource, 'catalog');
  assert.equal(byName['Matte Forest Green'].brand, 'Panchroma');
  assert.equal(byName['Matte Forest Green'].spoolWeightG, 1000);
  assert.ok(byName['Matte Forest Green'].sku.startsWith('CA0'));
  // 与真实识别结果 fixture 对齐（颜色/名称）
  for (const exp of expected.items) {
    const got = items.find((i) => i.colorName === exp.colorName);
    assert.ok(got, `缺少 ${exp.colorName}`);
  }
});

test('JSON 解析容错：markdown / 前后废话 / 数组', () => {
  const fenced = '```json\n{"items":[{"brand":"X","colorName":"Black","material":"PLA"}],"summary":"ok"}\n```';
  assert.equal(parseRecognitionJson(fenced).items.length, 1);

  const chatty = '好的，识别结果如下：\n{"items":[{"brand":"Y","colorName":"Red","material":"PLA"}]}\n希望有帮助';
  assert.equal(parseRecognitionJson(chatty).items.length, 1);

  const arr = '[{"brand":"Z","colorName":"Blue","material":"PETG"}]';
  assert.equal(parseRecognitionJson(arr).items.length, 1);

  assert.throws(() => parseRecognitionJson('没有 JSON'), /JSON/);
});

test('被截断的模型输出可恢复已完整的 items', () => {
  const truncated =
    '{"items":[{"brand":"A","colorName":"Matte Forest Green","material":"PLA"},' +
    '{"brand":"B","colorName":"Matte Fossil Grey","material":"PLA"},' +
    '{"brand":"C","colorName":"Matte Muted';
  const parsed = parseRecognitionJson(truncated);
  assert.equal(parsed.partial, true);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].colorName, 'Matte Forest Green');
});

test('识别结果规范化：缺字段/数量/去重/颜色兜底', () => {
  const warnings = [];
  const items = normalizeRecognitionItems(
    [
      { brand: 'Polymaker', colorName: 'Charcoal Black', material: 'PLA' }, // 无 hex → 色卡
      { brand: 'Polymaker', colorName: 'Charcoal Black', material: 'PLA', count: 2 },
      { colorName: '未知色', material: 'PLA' }, // 无 hex/无匹配
      { brand: '', productLine: '', colorName: '' }, // 全空 → 丢弃
      { brand: 'eSun', colorName: 'Red', material: '', sku: 'ca-123', count: 99, spoolWeightG: 999999 },
    ],
    { warnings },
  );
  assert.equal(items.length, 3);
  const black = items.find((i) => i.colorName === 'Charcoal Black');
  assert.equal(black.count, 3); // 同 SKU/同颜色合并
  assert.equal(black.colorHex, '#1C1C1C');
  const esun = items.find((i) => i.brand === 'eSun');
  assert.equal(esun.material, 'PLA');
  assert.equal(esun.count, 20);
  assert.equal(esun.spoolWeightG, 5000);
  assert.equal(esun.sku, 'CA-123');
});

test('Ollama 自动检测与调用（mock fetch）', async () => {
  resetVisionDetectionCache();
  const tags = { models: [{ name: 'llama3:8b' }, { name: 'qwen2.5vl:3b' }] };
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes('/api/tags')) {
      return new Response(JSON.stringify(tags), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('/api/chat')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'qwen2.5vl:3b');
      assert.ok(Array.isArray(body.messages[0].images));
      return new Response(
        JSON.stringify({ message: { content: JSON.stringify({ items: [{ brand: 'Bambu Lab', colorName: 'Matte Black', material: 'PLA', sku: 'GFA00' }] }) } }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  };
  const detected = await detectVisionProvider({ fetchImpl, env: {}, force: true });
  assert.equal(detected.ready, true);
  assert.equal(detected.provider, 'ollama');
  assert.equal(detected.model, 'qwen2.5vl:3b');

  const result = await recognizeFilaments({ imageBase64: 'aGVsbG8=', settings: {}, env: {}, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].colorHex, '#17181A'); // 'Matte Black' 命中色名字典
  assert.ok(seen.some((u) => u.includes('/api/chat')));
});

test('OpenAI 兼容接口调用（mock fetch，带 x-opencode-session）', async () => {
  let sawSession = false;
  const fetchImpl = async (url, opts) => {
    assert.match(String(url), /\/v1\/chat\/completions$/);
    assert.equal(opts.headers.authorization, 'Bearer test-key');
    sawSession = Boolean(opts.headers['x-opencode-session']);
    // 不少网关/上游对 response_format:json_object 会返回空 content，因此不发送该字段
    const sent = JSON.parse(opts.body);
    assert.equal(sent.response_format, undefined);
    assert.equal(sent.max_tokens, 3500); // 部分上游 >4k 会 400
    assert.equal(sent.messages[0].role, 'system');
    assert.match(sent.messages[0].content, /直接输出/);
    const content = JSON.stringify({ items: [{ brand: 'Panchroma', colorName: 'Matte Forest Green', material: 'PLA' }], summary: '1' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  const settings = { vision: { provider: 'openai', baseUrl: 'http://mock.local/v1', model: 'mock-vl', apiKey: 'test-key' } };
  const result = await recognizeFilaments({ imageBase64: 'aGVsbG8=', settings, env: {}, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(sawSession, true);
  assert.equal(result.items[0].colorHex, '#519F61'); // 色卡校正优先于模型
});

test('同一盒被识别两次时自动合并（不依赖 SKU 相同）', () => {
  const { items, mergedCount } = mergeSimilarItems([
    { brand: 'Polymaker', material: 'PLA', colorName: 'Forest Green', colorHex: '#519F61', sku: 'CA04078', count: 1, confidence: 0.9 },
    { brand: 'Polymaker', material: 'PLA', colorName: 'Matte Forest Green', colorHex: '#519F61', sku: 'CA09999', count: 1, confidence: 0.8 },
    { brand: 'Polymaker', material: 'PLA', colorName: 'Matte Fossil Grey', colorHex: '#6F727E', sku: 'CA04070', count: 1, confidence: 0.9 },
  ]);
  assert.equal(mergedCount, 1);
  assert.equal(items.length, 2);
  const forest = items.find((i) => i.colorName === 'Forest Green');
  assert.equal(forest.count, 2);
  assert.equal(forest.confidence, 0.9);
});

test('数量与模型自报盒数不一致时给出警告', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    brand: 'Polymaker',
    material: 'PLA',
    colorName: `Color ${i}`,
    colorHex: `#${(0x111111 + i * 0x111111).toString(16).slice(0, 6).toUpperCase()}`,
    sku: `CA0407${i}`,
  }));
  const fetchImpl = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ boxCount: 11, items, summary: '11' }) } }] }),
    { status: 200 },
  );
  const settings = { vision: { provider: 'openai', baseUrl: 'http://mock.local/v1', model: 'mock-vl', apiKey: 'k' } };
  const result = await recognizeFilaments({ imageBase64: 'aGVsbG8=', settings, env: {}, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 10);
  assert.ok(result.warnings.some((w) => w.includes('数出 11')));
});

test('模型首次返回空/坏 JSON 时会自动重试一次', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const content = calls === 1 ? '' : JSON.stringify({ items: [{ brand: 'Panchroma', colorName: 'Matte Forest Green', material: 'PLA' }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  const settings = { vision: { provider: 'openai', baseUrl: 'http://mock.local/v1', model: 'mock-vl', apiKey: 'k' } };
  const result = await recognizeFilaments({ imageBase64: 'aGVsbG8=', settings, env: {}, fetchImpl });
  assert.equal(result.ok, true);
  assert.ok(calls >= 2);
  assert.equal(result.items[0].colorHex, '#519F61');
});

test('未配置识别服务时给出配置提示', async () => {
  resetVisionDetectionCache();
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const result = await recognizeFilaments({ imageBase64: 'aGVsbG8=', settings: {}, env: {}, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ollama_unreachable');
  assert.match(result.message, /Ollama/);
});

test('提示词包含 JSON 结构与关键约束', () => {
  const prompt = buildRecognitionPrompt();
  assert.match(prompt, /"items"/);
  assert.match(prompt, /colorHex/);
  assert.match(prompt, /不要编造/);
});
