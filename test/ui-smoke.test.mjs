// UI 接线冒烟测试：用假 DOM 加载 web/app.js 的顶层代码，
// 校验所有 $('＃id') 绑定都能在 index.html 里找到对应元素（重构后最容易漏的就是这个）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

function makeElement(id = '') {
  const el = {
    id,
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    dataset: {},
    files: [],
    disabled: false,
    checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    prepend() {},
    remove() {},
    removeAttribute() {},
    setAttribute() {},
    closest: () => null,
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      canvas: { width: 1, height: 1 },
    }),
    naturalWidth: 100,
    naturalHeight: 100,
  };
  return el;
}

const elementCache = new Map();
function resolveSelector(sel) {
  const s = String(sel);
  const idMatch = s.match(/#([\w-]+)/);
  if (idMatch) {
    const id = idMatch[1];
    assert.ok(ids.has(id), `app.js 绑定了 index.html 中不存在的元素：${s}`);
    if (!elementCache.has(id)) elementCache.set(id, makeElement(id));
    return elementCache.get(id);
  }
  return makeElement();
}

globalThis.document = {
  querySelector: (sel) => resolveSelector(sel),
  querySelectorAll: () => [],
  createElement: () => makeElement(),
  addEventListener() {},
  documentElement: makeElement(),
};
globalThis.window = { confirm: () => false, prompt: () => null, open() {}, addEventListener() {} };
globalThis.location = {
  hash: '',
  origin: 'http://127.0.0.1:4174',
  pathname: '/',
  port: '4174',
  href: 'http://127.0.0.1:4174/',
  replace() {},
};
globalThis.history = { replaceState() {} };
globalThis.Image = class {
  constructor() {
    this.onload = null;
    this.onerror = null;
  }
  set src(v) { this._src = v; if (this.onload) setTimeout(() => this.onload(), 0); }
  get src() { return this._src || ''; }
  decode() { return Promise.resolve(); }
};
globalThis.FileReader = class {
  readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
};
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ spools: [], jobs: [], settings: { match: {}, vision: {} }, matchDefaults: {} }),
  text: async () => '{}',
});

const src = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8')
  .replace("from '/lib/color.mjs'", `from '${path.join(ROOT, 'lib/color.mjs').replace(/\\/g, '/')}'`);
const tmpFile = path.join(ROOT, 'test', '.ui-smoke-app.mjs');
fs.writeFileSync(tmpFile, src);

test.after(() => fs.rmSync(tmpFile, { force: true }));

test('app.js 顶层绑定与 index.html 元素一致', async () => {
  await import(`file://${tmpFile}?v=${Date.now()}`);
  await new Promise((r) => setTimeout(r, 30)); // 等 refreshState/checkBackendVersion 的 promise 走完
  assert.ok(ids.has('modalAdd'), '统一添加弹窗存在');
  assert.ok(ids.has('photoLightbox'), '图片放大浮层存在');
  for (const id of ['btnFetchImages', 'btnMergeDuplicates', 'viewSeg', 'groupBy', 'filterBrand', 'filterType', 'searchSpools', 'invCount', 'imageQueueHint', 'splitCount', 'authBanner', 'authBannerOpen', 'setApiToken', 'addPhotoInput', 'addPhotoPickInput', 'photoInput', 'photoPickInput']) {
    assert.ok(ids.has(id), `库存视图控件 ${id} 存在`);
  }
  assert.ok(!ids.has('modalRecognize'), '旧的独立识别弹窗已移除');
  assert.ok(!ids.has('btnRecognizePhoto'), '旧的独立识别按钮已移除');
});
