import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery,
  buildQueryVariants,
  parseBingResults,
  parseBingImageUrls,
  parseBaiduResults,
  scoreImageUrl,
  downloadImage,
  fetchProductImage,
  isSafeImageUrl,
  isOfficialHost,
} from '../lib/product-image.mjs';

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
function pngBuffer(size = 8000) {
  const buf = Buffer.alloc(size, 0x20);
  PNG_HEADER.copy(buf, 0);
  return buf;
}
const skipColor = async () => ({ ok: true, skipped: true });

function bingHtml(items) {
  return items
    .map((it) => `<a class="iusc" m="{&quot;murl&quot;:&quot;${it.murl}&quot;,&quot;purl&quot;:&quot;${it.purl || ''}&quot;,&quot;t&quot;:&quot;${it.title || ''}&quot;}"></a>`)
    .join('');
}

test('搜索词与候选解析（Bing / 百度）', () => {
  assert.match(buildQuery({ brand: 'Polymaker', colorName: 'Lava Red', type: 'PLA' }), /Polymaker/);
  assert.deepEqual(buildQueryVariants({ brand: 'Polymaker', colorName: 'Lava Red', type: 'PLA' })[0], 'Polymaker Lava Red PLA filament');

  const bing = bingHtml([
    { murl: 'https://shop.example/lava-red.jpg', purl: 'https://shop.example/p/1', title: 'Polymaker Panchroma Lava Red PLA' },
  ]);
  const parsed = parseBingResults(bing);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].murl, 'https://shop.example/lava-red.jpg');
  assert.match(parsed[0].title, /Lava Red/);
  assert.deepEqual(parseBingImageUrls(bing), ['https://shop.example/lava-red.jpg']);

  const baidu = JSON.stringify({ data: [{ middleURL: 'https://img.example/a.jpg', fromURL: 'https://p.example', fromPageTitleEnc: "lava red filament" }] });
  const b = parseBaiduResults(baidu);
  assert.equal(b.length, 1);
  assert.equal(b[0].murl, 'https://img.example/a.jpg');
});

test('相关性打分：标题命中 > URL；无关/垃圾词被压分', () => {
  const tokens = ['polymaker', 'lava', 'red'];
  const good = scoreImageUrl({ murl: 'https://shop.example/a.jpg', purl: 'https://shop.example/p', title: 'Polymaker Panchroma Lava Red PLA filament' }, tokens);
  const cat = scoreImageUrl({ murl: 'https://img.example/cat.jpg', purl: 'https://img.example/cute-cat', title: 'cute cat wallpaper' }, tokens);
  assert.ok(good.relevant);
  assert.ok(good.score >= 8);
  assert.equal(cat.relevant, false);
  assert.ok(good.score > cat.score);
});

test('官方域名识别与优先排序', () => {
  assert.equal(isOfficialHost('https://polymaker.com/products/a.jpg'), true);
  assert.equal(isOfficialHost('https://cdn.panchroma3d.com/a.png'), true);
  assert.equal(isOfficialHost('https://some-shop.example/a.jpg'), false);
  const tokens = ['polymaker', 'lava', 'red'];
  const official = scoreImageUrl({ murl: 'https://polymaker.com/lava-red.jpg', title: 'Polymaker Lava Red' }, tokens);
  const shop = scoreImageUrl({ murl: 'https://some-shop.example/lava-red.jpg', title: 'Polymaker Lava Red' }, tokens);
  assert.ok(official.score > shop.score);
});

test('图片地址安全限制：拒绝内网/非 http(s)', async () => {
  assert.equal(isSafeImageUrl('https://cdn.example.com/a.jpg'), true);
  assert.equal(isSafeImageUrl('http://127.0.0.1/a.jpg'), false);
  assert.equal(isSafeImageUrl('http://192.168.1.2/a.jpg'), false);
  assert.equal(isSafeImageUrl('http://172.20.0.5/a.jpg'), false);
  assert.equal(isSafeImageUrl('http://localhost:8080/a.jpg'), false);
  assert.equal(isSafeImageUrl('ftp://example.com/a.jpg'), false);
  await assert.rejects(
    () => downloadImage('http://127.0.0.1/secret.png', { fetchImpl: async () => new Response('x') }),
    /不允许的图片地址/,
  );
});

test('下载图片：识别类型/大小校验', async () => {
  const okFetch = async () => new Response(pngBuffer(), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '8000' } });
  const img = await downloadImage('https://cdn.shop/a.png', { fetchImpl: okFetch });
  assert.equal(img.ext, 'png');

  const htmlFetch = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => downloadImage('https://x/y', { fetchImpl: htmlFetch }), /不是图片/);

  const tinyFetch = async () => new Response(Buffer.from('abc'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  await assert.rejects(() => downloadImage('https://x/y', { fetchImpl: tinyFetch }), /太小/);
});

test('fetchProductImage：无关候选不下载，只取相关那张', async () => {
  const html = bingHtml([
    { murl: 'https://img.example/cute-cat.jpg', purl: 'https://img.example/cat', title: 'cute cat wallpaper 4k' },
    { murl: 'https://shop.example/panchroma-lava-red.png', purl: 'https://shop.example/p/1', title: 'Polymaker Panchroma Lava Red PLA filament 1kg' },
  ]);
  const downloads = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/images/async')) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.includes('image.baidu.com')) return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    downloads.push(u);
    return new Response(pngBuffer(), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '8000' } });
  };
  const result = await fetchProductImage(
    { brand: 'Polymaker', colorName: 'Lava Red', type: 'PLA', colorHex: '#DE1619' },
    { fetchImpl, colorVerifier: skipColor },
  );
  assert.equal(result.ok, true);
  assert.match(result.sourceUrl, /lava-red/);
  assert.equal(downloads.length, 1, '无关候选不应被下载');
});

test('fetchProductImage：颜色校验不通过时换下一张；全不通过则放弃', async () => {
  const html = bingHtml([
    { murl: 'https://shop.example/blue.png', title: 'Polymaker Panchroma Lava Red PLA blue variant' },
    { murl: 'https://shop.example/red.png', title: 'Polymaker Panchroma Lava Red PLA filament' },
  ]);
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/images/async')) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(pngBuffer(), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '8000' } });
  };
  const seen = [];
  const colorVerifier = async (buffer, hex) => {
    seen.push(hex);
    return { ok: !seen || seen.length > 1, skipped: false, deltaE: 50 };
  };
  const result = await fetchProductImage(
    { brand: 'Polymaker', colorName: 'Lava Red', type: 'PLA', colorHex: '#DE1619' },
    { fetchImpl, colorVerifier },
  );
  assert.equal(result.ok, true);
  assert.match(result.sourceUrl, /red\.png/);

  const alwaysFail = async () => ({ ok: false, skipped: false, deltaE: 90 });
  const failed = await fetchProductImage(
    { brand: 'Polymaker', colorName: 'Lava Red', type: 'PLA', colorHex: '#DE1619' },
    { fetchImpl, colorVerifier: alwaysFail },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'no_relevant_candidate');
});

test('fetchProductImage：没有相关候选时宁可不抓', async () => {
  const html = bingHtml([{ murl: 'https://img.example/cat.jpg', title: 'cute cat wallpaper' }]);
  const fetchImpl = async (url) => {
    if (String(url).includes('/images/async')) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(pngBuffer(), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const result = await fetchProductImage(
    { brand: 'Polymaker', colorName: 'Lava Red', type: 'PLA', colorHex: '#DE1619' },
    { fetchImpl, colorVerifier: skipColor },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_candidates');
});
