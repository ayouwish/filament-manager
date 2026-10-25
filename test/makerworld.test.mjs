import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMakerWorldUrl,
  extractFromDesignJson,
  mapInstanceFilaments,
  extractFromPageHtml,
  resolveMakerWorld,
} from '../lib/makerworld.mjs';

test('MakerWorld 链接解析', () => {
  const a = parseMakerWorldUrl('https://makerworld.com/zh/models/1400373-self-watering-seed-starter#profileId-1452154');
  assert.equal(a.ok, true);
  assert.equal(a.designId, '1400373');
  assert.equal(a.profileId, '1452154');
  assert.equal(a.canonicalUrl, 'https://makerworld.com/zh/models/1400373');

  const b = parseMakerWorldUrl('https://makerworld.com/en/models/1400373');
  assert.equal(b.ok, true);
  assert.equal(b.profileId, null);

  const c = parseMakerWorldUrl('https://makerworld.com/models/123?profileId=999');
  assert.equal(c.profileId, '999');

  for (const bad of ['https://example.com/models/1', 'http://makerworld.com/models/1', 'https://makerworld.com/x/1', 'not a url']) {
    assert.equal(parseMakerWorldUrl(bad).ok, false, bad);
  }
});

test('design/instances payload 解析与配置选择', () => {
  const design = {
    id: 1400373,
    title: 'Self Watering Seed Starter',
    coverUrl: 'https://makerworld.bblmw.com/cover.png',
    designCreator: { name: 'Meyui' },
    summary: '<h2>hello</h2><p>world</p>',
    defaultInstanceId: 1452154,
  };
  const instances = {
    total: 2,
    hits: [
      { id: 1452154, profileId: 298919107, title: '9 Cells', cover: 'https://x/1.png', detail: { prediction: 0, weight: 0 } },
      {
        id: 1452155,
        profileId: 298919108,
        title: '6 Cells',
        detail: {
          prediction: 3600,
          weight: 88.8,
          materialCnt: 2,
          needAms: true,
          instanceFilaments: [{ type: 'PLA', color: '#FF0000', weight: 50.5 }],
          extention: { modelInfo: { f3mf: { url: 'https://cdn/example.3mf' }, compatibility: { devModelName: 'Bambu Lab A1' } } },
        },
      },
    ],
  };

  const meta = extractFromDesignJson(design, instances);
  assert.equal(meta.title, 'Self Watering Seed Starter');
  assert.equal(meta.author, 'Meyui');
  assert.equal(meta.cover, 'https://makerworld.bblmw.com/cover.png');
  assert.match(meta.summary, /hello world/);
  assert.equal(meta.instances.length, 2);
  // 未指定 profileId 时优先选有实际数据（克重/f3mf 链接）的配置
  assert.equal(meta.chosen.id, 1452155);
  assert.equal(meta.instances[1].grams, 88.8);
  assert.equal(meta.instances[1].f3mfUrl, 'https://cdn/example.3mf');

  const byProfile = extractFromDesignJson(design, instances, { profileId: '298919108' });
  assert.equal(byProfile.chosen.id, 1452155);

  const withData = extractFromDesignJson(design, { hits: [instances.hits[0], instances.hits[1]] }, {});
  assert.equal(withData.instances[1].needAms, true);
  assert.equal(withData.instances[1].printer, 'Bambu Lab A1');
  assert.equal(withData.chosen.id, 1452155);
});

test('instanceFilaments 映射（字段缺失时防御式处理）', () => {
  const mapped = mapInstanceFilaments([
    { type: 'PLA', color: '#FF0000', weight: 10 },
    { filamentType: 'PLA', filamentColor: '#FF0000', usedG: 5 },
    { material: 'PETG', colour: '#00FF00' },
    { type: 'PLA', color: 'not-a-color' },
  ]);
  assert.equal(mapped.length, 2);
  const red = mapped.find((r) => r.colorHex === '#FF0000');
  assert.equal(red.type, 'PLA');
  assert.equal(red.grams, 15);
  const green = mapped.find((r) => r.colorHex === '#00FF00');
  assert.equal(green.grams, null);
});

test('页面 __NEXT_DATA__ 兜底提取', () => {
  const data = {
    props: {
      pageProps: {
        design: { id: 123, title: '页面模型', coverUrl: 'https://x/cover.png' },
        filaments: [
          { filament_type: 'PLA', color: '#17181A', used_g: 120.4 },
          { filament_type: 'PETG', color: '#E0A030', used_g: 60 },
        ],
      },
    },
  };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const page = extractFromPageHtml(html, { designId: '123' });
  assert.equal(page.title, '页面模型');
  assert.equal(page.cover, 'https://x/cover.png');
  assert.equal(page.requirements.length, 2);
  const black = page.requirements.find((r) => r.colorHex === '#17181A');
  assert.equal(black.grams, 120.4);
  assert.equal(black.type, 'PLA');

  const empty = extractFromPageHtml('<html><body>no data</body></html>', {});
  assert.equal(empty.requirements.length, 0);
  assert.ok(empty.warnings.length > 0);
});

test('resolveMakerWorld：匿名态返回模型信息并标记 needs3mf', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes('/design/1400373/instances')) {
      return new Response(
        JSON.stringify({
          total: 1,
          hits: [
            {
              id: 1452154,
              profileId: 298919107,
              title: '9 Cells',
              cover: 'https://x/cover.png',
              detail: {
                prediction: 0,
                weight: 0,
                instanceFilaments: null,
                extention: { modelInfo: { f3mf: { url: '' } } },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/design/1400373')) {
      return new Response(
        JSON.stringify({ id: 1400373, title: '匿名可读模型', coverUrl: 'https://x/cover.png', designCreator: { name: '作者A' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('<html></html>', { status: 404 });
  };
  try {
    const result = await resolveMakerWorld('https://makerworld.com/zh/models/1400373');
    assert.equal(result.ok, true);
    assert.equal(result.source, 'makerworld+metadata');
    assert.equal(result.needs3mf, true);
    assert.equal(result.title, '匿名可读模型');
    assert.equal(result.author, '作者A');
    assert.equal(result.requirements.length, 0);
    assert.ok(result.warnings.some((w) => w.includes('拿不到材料克重')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('resolveMakerWorld：全部被 Cloudflare 拦时返回 upstream_blocked', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<html><title>Just a moment...</title>cloudflare</html>', {
      status: 403,
      headers: { 'content-type': 'text/html' },
    });
  try {
    const result = await resolveMakerWorld('https://makerworld.com/zh/models/1400373');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'upstream_blocked');
    assert.ok(result.fallbacks.includes('upload_3mf'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
