// 用假 DOM 加载 app.js，模拟切换「分组」下拉，验证分组渲染。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const elements = new Map();
function makeEl(id = '') {
  const listeners = {};
  return {
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
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event = {}) {
      for (const fn of listeners[type] || []) fn({ target: this, currentTarget: this, ...event });
    },
    appendChild() {},
    prepend() {},
    remove() {},
    removeAttribute() {},
    setAttribute() {},
    closest: () => null,
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }), canvas: { width: 1, height: 1 } }),
    naturalWidth: 100,
    naturalHeight: 100,
    select() {},
  };
}

function resolve(sel) {
  const idMatch = String(sel).match(/#([\w-]+)/);
  if (idMatch) {
    assert.ok(ids.has(idMatch[1]), `app.js 绑定到不存在的元素：${sel}`);
    if (!elements.has(idMatch[1])) elements.set(idMatch[1], makeEl(idMatch[1]));
    return elements.get(idMatch[1]);
  }
  return makeEl();
}

globalThis.document = {
  querySelector: resolve,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener() {},
  documentElement: makeEl(),
};
globalThis.window = { confirm: () => true, prompt: () => '50', open() {}, addEventListener() {} };
globalThis.location = { hash: '', origin: 'http://127.0.0.1:4174', pathname: '/', port: '4174', href: 'http://127.0.0.1:4174/', replace() {} };
globalThis.history = { replaceState() {} };
globalThis.localStorage = {
  _v: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; },
};
globalThis.Image = class {
  constructor() { this.onload = null; this.onerror = null; }
  set src(v) { this._src = v; if (this.onload) setTimeout(() => this.onload(), 0); }
  get src() { return this._src || ''; }
  decode() { return Promise.resolve(); }
};
globalThis.FileReader = class {
  readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
};

const spools = [
  { id: 's1', name: 'Matte Forest Green PLA', brand: 'Panchroma', type: 'PLA', colorHex: '#519F61', colorName: 'Matte Forest Green', totalGrams: 1000, remainingGrams: 800, photo: '', productPhoto: '' },
  { id: 's2', name: 'Gold PLA', brand: 'Bambu Lab', type: 'PLA', colorHex: '#C9A227', colorName: 'Gold', totalGrams: 1000, remainingGrams: 600, photo: '', productPhoto: '' },
  { id: 's3', name: '宝蓝 PETG', brand: 'Polymaker', type: 'PETG', colorHex: '#1E5FBF', colorName: '宝蓝', totalGrams: 1000, remainingGrams: 300, photo: '', productPhoto: '' },
];
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ spools, jobs: [], settings: { match: {}, vision: {} }, matchDefaults: {} }),
  text: async () => '{}',
});

const src = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8')
  .replace("from '/lib/color.mjs'", `from '${path.join(ROOT, 'lib/color.mjs').replace(/\\/g, '/')}'`);
const tmpFile = path.join(ROOT, 'test', '.inventory-view-app.mjs');
fs.writeFileSync(tmpFile, src);
test.after(() => fs.rmSync(tmpFile, { force: true }));

test('切换分组下拉后，按品牌/材质/颜色渲染分组', async () => {
  await import(`file://${tmpFile}?v=${Date.now()}`);
  await new Promise((r) => setTimeout(r, 50));

  const grid = elements.get('spoolGrid');
  const groupBy = elements.get('groupBy');
  assert.ok(grid, 'spoolGrid 存在');
  assert.match(grid.innerHTML, /Matte Forest Green PLA/);
  // 默认就按品牌分组，开箱可见
  assert.match(grid.innerHTML, /group-head/);
  assert.match(grid.innerHTML, /Panchroma/);
  assert.match(grid.innerHTML, /Bambu Lab/);

  groupBy.value = 'brand';
  groupBy.dispatch('change');
  assert.match(grid.innerHTML, /group-head/, '按品牌应出现组头');
  assert.match(grid.innerHTML, /Panchroma/);
  assert.match(grid.innerHTML, /Bambu Lab/);

  groupBy.value = 'type';
  groupBy.dispatch('change');
  assert.match(grid.innerHTML, /group-head/);
  assert.match(grid.innerHTML, /PETG/);

  groupBy.value = 'brand+type';
  groupBy.dispatch('change');
  assert.match(grid.innerHTML, /Panchroma · PLA/);
  assert.match(grid.innerHTML, /Bambu Lab · PLA/);

  groupBy.value = 'color';
  groupBy.dispatch('change');
  assert.match(grid.innerHTML, /group-head/);
  assert.match(grid.innerHTML, /Matte Forest Green/);

  groupBy.value = 'none';
  groupBy.dispatch('change');
  assert.doesNotMatch(grid.innerHTML, /group-head/, '不分组时不应有组头');

  // 品牌/材质筛选
  const brandFilter = elements.get('filterBrand');
  const typeFilter = elements.get('filterType');
  brandFilter.value = 'Bambu Lab';
  brandFilter.dispatch('change');
  assert.match(grid.innerHTML, /Gold PLA/);
  assert.doesNotMatch(grid.innerHTML, /Matte Forest Green PLA/);

  brandFilter.value = '';
  brandFilter.dispatch('change');
  typeFilter.value = 'PETG';
  typeFilter.dispatch('change');
  assert.match(grid.innerHTML, /宝蓝 PETG/);
  assert.doesNotMatch(grid.innerHTML, /Gold PLA/);
});
