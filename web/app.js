// 耗材管家前端（原生 ES Module，无构建步骤）。
// 复用 /lib/color.mjs 的色差与命名逻辑，匹配算法全部在服务端 /api/match。

import { colorName, deltaEHex } from '/lib/color.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  spools: [],
  jobs: [],
  settings: { match: {}, vision: {} },
  matchDefaults: {},
  model: null,
  requirements: [],
  activePlate: 'all',
  matches: null,
  overrides: new Map(),
  editingReqs: false,
  photo: { dataUrl: '', hex: '#808080' },
  inventory: { view: 'grid', group: 'brand', query: '', filterBrand: '', filterType: '', collapsed: {} },
  imageQueue: { pending: 0, running: false },
  apiToken: '',
  add: { dataUrl: '', mime: 'image/jpeg', items: [], activeIndex: 0, summary: '' },
  lightbox: null,
  visionReady: false,
  matchesKey: null,
  view: 'inventory',
};

const STATUS = {
  ok: { label: '匹配成功', cls: 'ok' },
  color_near: { label: '颜色相近', cls: 'warn' },
  combine: { label: '需同色拼盘', cls: 'warn' },
  color_far: { label: '颜色差异大', cls: 'bad' },
  insufficient: { label: '余量不足', cls: 'bad' },
  no_type: { label: '无同类型耗材', cls: 'bad' },
  type_mismatch: { label: '材料类型不符', cls: 'bad' },
  no_stock: { label: '库存为空', cls: 'bad' },
};

// ---------------- 通用 ----------------

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : '—');

const API_TOKEN_KEY = 'fm.apiToken';

function loadApiToken() {
  try {
    return localStorage.getItem(API_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function persistApiToken(token) {
  try {
    if (token) localStorage.setItem(API_TOKEN_KEY, token);
    else localStorage.removeItem(API_TOKEN_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

function showAuthBanner() {
  const el = $('#authBanner');
  if (el) el.hidden = false;
}

function hideAuthBanner() {
  const el = $('#authBanner');
  if (el) el.hidden = true;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.apiToken) headers['x-fm-token'] = state.apiToken;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `响应不是 JSON（HTTP ${res.status}）` }));
  if (!res.ok) {
    if (res.status === 401) showAuthBanner();
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  hideAuthBanner();
  return data;
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function openModal(id) { $(`#${id}`).hidden = false; }
function closeModal(id) { $(`#${id}`).hidden = true; }

// ---------------- 初始化 ----------------

async function refreshState() {
  const data = await api('/api/state');
  state.spools = data.spools || [];
  state.jobs = data.jobs || [];
  state.settings = data.settings || { match: {}, vision: {} };
  state.matchDefaults = data.matchDefaults || {};
  state.imageQueue = data.productImageQueue || { pending: 0, running: false };
  renderInventory();
  renderJobs();
  updateQueueHint();
  if ((state.imageQueue.running || state.imageQueue.pending > 0) && !imagePollTimer) {
    startImagePolling(); // 入库后台拉图：自动刷新进度
  }
}

let imagePollTimer = null;

function updateQueueHint() {
  const el = $('#imageQueueHint');
  if (!el) return;
  const q = state.imageQueue || {};
  const pending = Number(q.pending) || 0;
  const total = pending + (q.running ? 1 : 0);
  el.textContent = total > 0 ? `🖼️ 正在拉取商品图（剩 ${total} 盘）…` : '';
}

/** 后台队列跑完后自动刷新库存，并把新出现的商品图提示出来。 */
function startImagePolling() {
  if (imagePollTimer) return;
  const before = state.spools.filter((s) => s.productPhoto).length;
  let rounds = 0;
  imagePollTimer = setInterval(async () => {
    rounds += 1;
    try {
      await refreshState();
    } catch {
      /* 网络抖动时下一轮再试 */
    }
    const q = state.imageQueue || {};
    if ((!q.running && !q.pending) || rounds > 24) {
      clearInterval(imagePollTimer);
      imagePollTimer = null;
      updateQueueHint();
      const after = state.spools.filter((s) => s.productPhoto).length;
      if (after > before) toast(`商品图已自动更新 ${after - before} 盘`);
    }
  }, 2500);
}

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  for (const name of ['inventory', 'match', 'jobs']) {
    $(`#view-${name}`).hidden = name !== view;
  }
  if (view === 'inventory') renderInventory();
  if (view === 'jobs') renderJobs();
}

// ---------------- 材料库 ----------------

const INVENTORY_PREFS_KEY = 'fm.inventory.prefs.v2'; // v2：默认按品牌分组，旧版 "不分组" 偏好不再沿用

function loadInventoryPrefs() {
  const groups = ['none', 'brand', 'type', 'color', 'brand+type'];
  try {
    const raw = JSON.parse(localStorage.getItem(INVENTORY_PREFS_KEY) || '{}');
    return {
      view: raw.view === 'list' ? 'list' : 'grid',
      // 默认按品牌分组，让"分品牌/分材质"开箱可见
      group: groups.includes(raw.group) ? raw.group : 'brand',
      query: '',
      filterBrand: '',
      filterType: '',
      collapsed: raw.collapsed && typeof raw.collapsed === 'object' ? raw.collapsed : {},
    };
  } catch {
    return { view: 'grid', group: 'brand', query: '', filterBrand: '', filterType: '', collapsed: {} };
  }
}

function saveInventoryPrefs() {
  try {
    const { view, group, collapsed } = state.inventory;
    localStorage.setItem(INVENTORY_PREFS_KEY, JSON.stringify({ view, group, collapsed }));
  } catch {
    /* 无 localStorage（隐私模式/测试环境）时忽略 */
  }
}

function spoolMediaHtml(spool, { thumb = false } = {}) {
  const src = spool.productPhoto || spool.photo || '';
  const badge = spool.productPhoto ? '商品图' : spool.photo ? '实拍' : '';
  if (!src) {
    return `<div class="${thumb ? 'row-thumb' : 'spool-photo'}" style="background:${escapeHtml(spool.colorHex)}22;display:flex;align-items:center;justify-content:center;font-size:${thumb ? 20 : 34}px">🧵</div>`;
  }
  if (thumb) return `<img class="row-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" />`;
  return `<div class="spool-photo"><img src="${escapeHtml(src)}" alt="${escapeHtml(spool.name)}" loading="lazy" />${badge ? `<span class="img-badge">${badge}</span>` : ''}</div>`;
}

function spoolCardHtml(s) {
  const pct = s.totalGrams > 0 ? Math.max(0, Math.min(100, (s.remainingGrams / s.totalGrams) * 100)) : 0;
  const lowCls = s.remainingGrams <= 0 ? 'empty' : s.remainingGrams < 100 ? 'low' : '';
  return `
      <article class="spool-card">
        ${spoolMediaHtml(s)}
        <div class="spool-body">
          <div class="spool-title">
            <span class="swatch" style="background:${escapeHtml(s.colorHex)}"></span>
            <span class="spool-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
            ${Number(s.count) > 1 ? `<span class="count-badge">×${Number(s.count)}</span>` : ''}
          </div>
          <div class="spool-meta">
            ${s.brand ? `<span class="tag">${escapeHtml(s.brand)}</span>` : ''}
            <span class="tag">${escapeHtml(s.type)}</span>
            <span class="tag">${escapeHtml(s.colorName || '')}</span>
          </div>
          <div class="remain ${lowCls}">
            <div class="nums"><span>剩余 <b>${fmt(s.remainingGrams)}</b> g</span><span>/ ${fmt(s.totalGrams)} g${Number(s.count) > 1 ? `（${Number(s.count)} 盘）` : ''}</span></div>
            <div class="bar"><i style="width:${pct}%"></i></div>
          </div>
          <div class="spool-foot">
            <button data-act="consume" data-id="${s.id}">扣减</button>
            <button data-act="edit" data-id="${s.id}">编辑</button>
            <button data-act="find-image" data-id="${s.id}">${s.productPhoto ? '换图' : '找图'}</button>
            ${s.productPhoto ? `<button data-act="clear-image" data-id="${s.id}">删图</button>` : ''}
            <button data-act="delete" data-id="${s.id}" class="danger">删除</button>
          </div>
        </div>
      </article>`;
}

function spoolRowHtml(s) {
  const pct = s.totalGrams > 0 ? Math.max(0, Math.min(100, (s.remainingGrams / s.totalGrams) * 100)) : 0;
  return `
      <div class="spool-row">
        ${spoolMediaHtml(s, { thumb: true })}
        <div class="row-main">
          <div class="row-name">${escapeHtml(s.name)}${Number(s.count) > 1 ? ` <span class="count-badge">×${Number(s.count)}</span>` : ''}</div>
          <div class="row-meta">
            ${s.brand ? `<span>${escapeHtml(s.brand)}</span>` : ''}
            <span>${escapeHtml(s.type)}</span>
            <span>${escapeHtml(s.colorName || '')}</span>
          </div>
        </div>
        <div class="row-remain">
          <div>${fmt(s.remainingGrams)} / ${fmt(s.totalGrams)} g${Number(s.count) > 1 ? ` · ${Number(s.count)} 盘` : ''}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </div>
        <div class="row-actions">
          <button data-act="consume" data-id="${s.id}">扣减</button>
          <button data-act="edit" data-id="${s.id}">编辑</button>
          <button data-act="find-image" data-id="${s.id}">${s.productPhoto ? '换图' : '找图'}</button>
          ${s.productPhoto ? `<button data-act="clear-image" data-id="${s.id}">删图</button>` : ''}
          <button data-act="delete" data-id="${s.id}">删除</button>
        </div>
      </div>`;
}

function groupSpools(spools, mode) {
  if (mode === 'none') return [{ key: '__all', label: '', items: spools }];
  const map = new Map();
  for (const s of spools) {
    let key;
    let label;
    if (mode === 'brand') {
      key = s.brand || '_';
      label = s.brand || '未填品牌';
    } else if (mode === 'type') {
      key = s.type || '_';
      label = s.type || '其他';
    } else if (mode === 'brand+type') {
      const brand = s.brand || '未填品牌';
      const type = s.type || '其他';
      key = `${brand}|${type}`;
      label = `${brand} · ${type}`;
    } else {
      key = s.colorName || s.colorHex || '_';
      label = s.colorName || s.colorHex || '未命名颜色';
    }
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key).items.push(s);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

function renderGroup(group, prefs) {
  const collapsed = Boolean(prefs.collapsed[group.key]);
  const body =
    prefs.view === 'list'
      ? `<div class="list">${group.items.map(spoolRowHtml).join('')}</div>`
      : `<div class="grid">${group.items.map(spoolCardHtml).join('')}</div>`;
  const head = group.label
    ? `<button class="group-head" data-group-toggle="${escapeHtml(group.key)}" type="button">
         <span class="group-title">${escapeHtml(group.label)}</span>
         <span class="group-meta">${group.items.length} 盘 · 剩 ${fmt(group.items.reduce((sum, s) => sum + (Number(s.remainingGrams) || 0), 0))} g</span>
         <span class="group-chev">${collapsed ? '▸' : '▾'}</span>
       </button>`
    : '';
  return `<section class="spool-group">${head}<div class="group-body ${collapsed ? 'collapsed' : ''}">${body}</div></section>`;
}

function renderInventory() {
  const spools = state.spools;
  const prefs = state.inventory;
  const totalRemain = spools.reduce((s, p) => s + (Number(p.remainingGrams) || 0), 0);
  const opened = spools.filter((p) => p.remainingGrams < p.totalGrams - 0.5).length;
  const colors = new Set(spools.map((p) => p.colorHex)).size;
  $('#invSummary').innerHTML = `
    <div class="stat"><div class="k">料盘数</div><div class="v">${spools.length}<small>盘</small></div></div>
    <div class="stat"><div class="k">剩余总量</div><div class="v">${fmt(totalRemain)}<small>g</small></div></div>
    <div class="stat"><div class="k">已开封</div><div class="v">${opened}<small>盘</small></div></div>
    <div class="stat"><div class="k">颜色种类</div><div class="v">${colors}<small>种</small></div></div>`;

  // 品牌/材质筛选下拉（选项从库存动态生成，保留当前选择）
  const brands = [...new Set(spools.map((s) => s.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const types = [...new Set(spools.map((s) => s.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const sortZh = (arr) => arr.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const brandSel = $('#filterBrand');
  brandSel.innerHTML = '<option value="">全部品牌</option>' + sortZh(brands).map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  brandSel.value = brands.includes(prefs.filterBrand) ? prefs.filterBrand : '';
  prefs.filterBrand = brandSel.value;
  const typeSel = $('#filterType');
  typeSel.innerHTML = '<option value="">全部材质</option>' + sortZh(types).map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  typeSel.value = types.includes(prefs.filterType) ? prefs.filterType : '';
  prefs.filterType = typeSel.value;

  const query = prefs.query.trim().toLowerCase();
  const filtered = spools.filter((s) => {
    if (prefs.filterBrand && s.brand !== prefs.filterBrand) return false;
    if (prefs.filterType && s.type !== prefs.filterType) return false;
    if (query && ![s.name, s.brand, s.type, s.colorName, s.note].join(' ').toLowerCase().includes(query)) return false;
    return true;
  });
  const groups = groupSpools(filtered, prefs.group);

  const grid = $('#spoolGrid');
  grid.innerHTML = filtered.length
    ? groups.map((g) => renderGroup(g, prefs)).join('')
    : `<div class="empty-inline">没有匹配的耗材${query ? `（搜索：${escapeHtml(prefs.query)}）` : ''}</div>`;
  $('#spoolEmpty').hidden = spools.length > 0;
  $('#invCount').textContent = `${filtered.length} / ${spools.length} 盘 · 剩 ${fmt(filtered.reduce((sum, s) => sum + (Number(s.remainingGrams) || 0), 0))} g`;
  $$('#viewSeg [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === prefs.view));
  $('#groupBy').value = prefs.group;
  const searchEl = $('#searchSpools');
  if (searchEl.value !== prefs.query) searchEl.value = prefs.query;

  grid.onclick = (e) => {
    const head = e.target.closest('[data-group-toggle]');
    if (head) {
      const key = head.dataset.groupToggle;
      state.inventory.collapsed[key] = !state.inventory.collapsed[key];
      saveInventoryPrefs();
      renderInventory();
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const spool = state.spools.find((s) => s.id === btn.dataset.id);
    if (!spool) return;
    if (btn.dataset.act === 'edit') openSpoolModal(spool);
    else if (btn.dataset.act === 'delete') deleteSpool(spool);
    else if (btn.dataset.act === 'consume') consumeSpool(spool);
    else if (btn.dataset.act === 'find-image') findSpoolImage(spool);
    else if (btn.dataset.act === 'clear-image') clearSpoolImage(spool);
  };
}

async function deleteSpool(spool) {
  if (!window.confirm(`删除「${spool.name}」？此操作不可恢复。`)) return;
  try {
    await api(`/api/spools/${spool.id}`, { method: 'DELETE' });
    await refreshState();
    toast('已删除');
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  }
}

async function consumeSpool(spool) {
  const input = window.prompt(`从「${spool.name}」扣减多少克？（当前剩余 ${spool.remainingGrams} g）`, '50');
  if (input === null) return;
  const grams = Number(input);
  if (!Number.isFinite(grams) || grams <= 0) return toast('请输入有效克重', true);
  try {
    await api(`/api/spools/${spool.id}/consume`, { method: 'POST', body: { grams } });
    await refreshState();
    toast(`已扣减 ${grams} g`);
  } catch (err) {
    toast(`扣减失败：${err.message}`, true);
  }
}

async function findSpoolImage(spool) {
  toast(`正在为「${spool.name}」搜索商品图…`);
  try {
    const data = await api(`/api/spools/${spool.id}/product-image`, { method: 'POST', body: { force: true } });
    await refreshState();
    toast(data.cached ? '已有商品图' : `已更新商品图${data.query ? `（${data.query}）` : ''}`);
  } catch (err) {
    toast(`找图失败：${err.message}`, true);
  }
}

async function clearSpoolImage(spool) {
  if (!window.confirm(`删除「${spool.name}」的商品图？（不影响你的实拍图）`)) return;
  try {
    await api(`/api/spools/${spool.id}/product-image`, { method: 'DELETE' });
    await refreshState();
    toast('已删除商品图');
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  }
}

async function mergeDuplicateSpools() {
  const dupes = state.spools.length - new Set(state.spools.map((s) => [s.brand, s.type, s.colorHex, s.name].join('|'))).size;
  if (dupes <= 0) return toast('没有发现同品牌/同材质/同色/同名的重复料盘');
  if (!window.confirm(`发现 ${dupes} 条重复料盘，将合并为同款一条（数量与余量相加、保留照片）。继续？`)) return;
  try {
    const data = await api('/api/spools/merge-duplicates', { method: 'POST', body: {} });
    await refreshState();
    toast(`已合并 ${data.mergedGroups} 组，移除 ${data.removed} 条重复记录`);
  } catch (err) {
    toast(`合并失败：${err.message}`, true);
  }
}

async function fetchMissingProductImages() {
  const missing = state.spools.filter((s) => !s.productPhoto).length;
  if (!missing) return toast('所有料盘都已有商品图');
  const n = Math.min(missing, 10);
  if (!window.confirm(`将为 ${n} 盘缺少商品图的耗材搜索对应颜色商品图（每次最多 10 盘，可再点一次继续），可能耗时几十秒。继续？`)) return;
  const btn = $('#btnFetchImages');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🔎 搜索中…';
  try {
    const data = await api('/api/spools/product-images', { method: 'POST', body: { limit: 10 } });
    await refreshState();
    toast(`商品图：成功 ${data.fetched} 盘，失败 ${data.failed} 盘`);
  } catch (err) {
    toast(`搜索商品图失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// ---------------- 材料弹窗 ----------------

function syncColorInputs(hex) {
  const colorEl = $('#spoolForm [name="colorHex"]');
  const textEl = $('#spoolForm [name="colorHexText"]');
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    colorEl.value = hex.toLowerCase();
    textEl.value = hex.toUpperCase();
    state.photo.hex = hex.toUpperCase();
  }
}

function openSpoolModal(spool) {
  if (!spool) return openAddModal(); // 新增统一走"拍照添加耗材"
  const form = $('#spoolForm');
  form.reset();
  state.photo = { dataUrl: '', hex: '#808080', cleared: false };
  const placeholder = $('.photo-placeholder');
  if (placeholder) placeholder.hidden = false;
  const img = $('#editPhotoImg');
  img.hidden = true;
  img.removeAttribute('src');
  $('#spoolModalTitle').textContent = '编辑耗材';
  form.id.value = spool.id;
  form.name.value = spool.name;
  form.brand.value = spool.brand || '';
  form.type.value = spool.type || 'PLA';
  form.totalGrams.value = spool.totalGrams;
  form.remainingGrams.value = spool.remainingGrams;
  form.note.value = spool.note || '';
  syncColorInputs(spool.colorHex);
  if (spool.photo) setEditPhoto(spool.photo);
  openModal('modalSpool');
}

function setEditPhoto(src) {
  const img = $('#editPhotoImg');
  const placeholder = $('.photo-placeholder');
  img.src = src;
  img.hidden = false;
  if (placeholder) placeholder.hidden = true;
  img.onclick = () => openLightbox(src, (hex) => syncColorInputs(hex));
}

// 取邻域中位色：比平均值更抗高光/阴影（调研建议剔除明度极端像素）
function sampleMedian(ctx, cx, cy, radius) {
  const size = radius * 2 + 1;
  const x0 = Math.max(0, cx - radius);
  const y0 = Math.max(0, cy - radius);
  const w = Math.min(size, ctx.canvas.width - x0);
  const h = Math.min(size, ctx.canvas.height - y0);
  if (w <= 0 || h <= 0) return null;
  let data;
  try {
    data = ctx.getImageData(x0, y0, w, h).data;
  } catch {
    return null;
  }
  const rs = [];
  const gs = [];
  const bs = [];
  for (let i = 0; i < data.length; i += 4) {
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  }
  const median = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const rgb = { r: median(rs), g: median(gs), b: median(bs) };
  return `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function downscaleDataUrl(dataUrl, maxSize = 1100) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
      if (scale === 1 && dataUrl.length < 900_000) return resolve(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function onPhotoPicked(file) {
  if (!file) return;
  try {
    const raw = await fileToDataUrl(file);
    const dataUrl = await downscaleDataUrl(raw);
    state.photo = { dataUrl, hex: state.photo.hex || '#808080', cleared: false };
    setEditPhoto(dataUrl);
    $('#photoInput').value = ''; // 允许再次选择同一文件
    toast('照片已载入：点图片可放大 / 取色');
  } catch (err) {
    toast(`照片读取失败：${err.message}`, true);
  }
}

async function autoFillFromPhoto() {
  if (!state.photo.dataUrl) return toast('请先拍照或选择照片', true);
  toast('正在识别照片…');
  const b64 = String(state.photo.dataUrl).replace(/^data:[^;]+;base64,/, '');
  try {
    const data = await api('/api/recognize', { method: 'POST', body: { base64: b64 } });
    const items = data.items || [];
    if (!items.length) return toast('没有识别到耗材，可换张更清晰的照片', true);
    if (items.length === 1) {
      const it = items[0];
      const form = $('#spoolForm');
      form.name.value = it.name || [it.colorName || it.productLine || '耗材', it.material].filter(Boolean).join(' ');
      form.brand.value = it.brand || '';
      if (['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', '其他'].includes(it.material)) form.type.value = it.material;
      if (it.colorHex) syncColorInputs(it.colorHex);
      const grams = Number(it.spoolWeightG) || 1000;
      form.totalGrams.value = grams;
      form.remainingGrams.value = grams;
      form.note.value = [it.sku ? `SKU ${it.sku}` : '', it.productLine].filter(Boolean).join(' · ').slice(0, 300);
      toast(`已识别：${it.colorName || '耗材'} / ${it.material}，请核对后保存`);
      return;
    }
    // 多盒照片：转到统一的"拍照添加"批量列表
    closeModal('modalSpool');
    openAddModal({ dataUrl: state.photo.dataUrl, items, summary: data.summary });
  } catch (err) {
    toast(`识别失败：${err.message}`, true);
  }
}

async function saveSpool() {
  const form = $('#spoolForm');
  const payload = {
    name: form.name.value.trim(),
    brand: form.brand.value.trim(),
    type: form.type.value,
    colorHex: form.colorHexText.value.trim(),
    totalGrams: Number(form.totalGrams.value),
    remainingGrams: Number(form.remainingGrams.value),
    note: form.note.value.trim(),
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(payload.colorHex)) return toast('颜色格式应为 #RRGGBB', true);
  if (!Number.isFinite(payload.totalGrams) || payload.totalGrams <= 0) return toast('总重需大于 0', true);
  if (payload.remainingGrams > payload.totalGrams) return toast('剩余量不能大于总重', true);
  if (state.photo.cleared) payload.photo = '';
  else if (state.photo.dataUrl) payload.photoDataUrl = state.photo.dataUrl;
  const id = form.id.value;
  try {
    if (id) await api(`/api/spools/${id}`, { method: 'PUT', body: payload });
    else await api('/api/spools', { method: 'POST', body: payload });
    closeModal('modalSpool');
    await refreshState();
    toast(id ? '已保存修改' : '已添加耗材');
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

// ---------------- 智能选料 ----------------

function setStatus(text, kind = '') {
  const el = $('#resolveStatus');
  el.hidden = !text;
  el.className = `status ${kind}`;
  el.textContent = text || '';
}

function makeReq(partial = {}) {
  const colorHex = partial.colorHex || '#17181A';
  return {
    index: partial.index,
    type: partial.type || 'PLA',
    colorHex,
    colorName: partial.colorName || colorName(colorHex).name,
    grams: partial.grams ?? null,
    display: partial.display || `${partial.colorName || colorName(colorHex).name} / ${partial.type || 'PLA'}`,
  };
}

function applyModel(model) {
  state.model = model;
  state.activePlate = 'all';
  state.overrides.clear();
  state.editingReqs = false;
  state.requirements = (model.requirements || []).map((r, i) => makeReq({ ...r, index: r.index ?? i + 1 }));
  if (!state.requirements.length) state.editingReqs = true;
  $('#modelCard').hidden = false;
  $('#matchCard').hidden = true;
  renderModelCard();
  if (state.requirements.length) runMatch();
  else renderRequirementEditor();
}

function renderModelCard() {
  const m = state.model;
  if (!m) return;
  $('#modelTitle').textContent = m.title || '模型';
  const sourceText = m.source === '3mf' ? `来源：${m.filename || '本地 3mf'}（克重精确）`
    : m.source === 'makerworld+3mf' ? '来源：MakerWorld 打印配置（克重精确）'
    : m.source === 'makerworld+api' ? '来源：MakerWorld 接口（建议核对）'
    : m.source === 'makerworld+metadata' ? '来源：MakerWorld 模型信息（匿名接口不含材料克重，请上传 .3mf）'
    : m.source === 'makerworld+page' ? '来源：MakerWorld 页面数据（建议核对）'
    : m.source === 'sample' ? '内置示例需求'
    : m.source === 'manual' ? '手动录入'
    : '来源：未知';
  const extra = [];
  if (m.author) extra.push(`作者：${m.author}`);
  if ((m.instances || []).length > 1) extra.push(`共 ${m.instances.length} 个打印配置`);
  $('#modelSource').textContent = [sourceText, ...extra, m.sourceUrl].filter(Boolean).join(' · ');
  const coverEl = $('#modelCover');
  if (m.cover) {
    coverEl.src = m.cover;
    coverEl.hidden = false;
    coverEl.onerror = () => { coverEl.hidden = true; };
  } else {
    coverEl.hidden = true;
    coverEl.removeAttribute('src');
  }
  const badge = $('#modelBadge');
  const exact = m.source === '3mf' || m.source === 'makerworld+3mf';
  const needs3mf = m.source === 'makerworld+metadata';
  badge.className = `badge ${exact ? 'ok' : m.source === 'sample' || needs3mf ? 'warn' : ''}`;
  badge.textContent = exact ? '克重精确' : needs3mf ? '需 3mf' : m.source === 'sample' ? '示例' : '估算';

  const warnBox = $('#modelWarnings');
  const warnings = m.warnings || [];
  warnBox.hidden = warnings.length === 0;
  warnBox.innerHTML = warnings.map((w) => `<p>⚠ ${escapeHtml(w)}</p>`).join('');

  const chips = $('#plateChips');
  if (m.plates && m.plates.length > 1) {
    chips.hidden = false;
    chips.innerHTML = [
      `<button class="chip ${state.activePlate === 'all' ? 'active' : ''}" data-plate="all">全部平台（${m.plates.length}）</button>`,
      ...m.plates.map((p) => `<button class="chip ${state.activePlate === p.index ? 'active' : ''}" data-plate="${p.index}">平台 ${p.index}${Number.isFinite(p.totalGrams) ? ` · ${fmt(p.totalGrams, 1)} g` : ''}</button>`),
    ].join('');
    chips.onclick = (e) => {
      const btn = e.target.closest('[data-plate]');
      if (!btn) return;
      const val = btn.dataset.plate;
      state.activePlate = val === 'all' ? 'all' : Number(val);
      state.overrides.clear();
      state.requirements = state.activePlate === 'all'
        ? (m.requirements || []).map((r, i) => makeReq({ ...r, index: i + 1 }))
        : mergePlates(m.plates, state.activePlate);
      renderModelCard();
      runMatch();
    };
  } else {
    chips.hidden = true;
    chips.innerHTML = '';
  }

  $('#btnEditReqs').textContent = state.editingReqs ? '完成' : '编辑';
  const reqView = $('#reqView');
  const reqEdit = $('#reqEdit');
  reqEdit.hidden = !state.editingReqs;
  reqView.hidden = state.editingReqs;
  if (state.editingReqs) renderRequirementEditor();
  else {
    reqView.innerHTML = state.requirements.map((r) => `
      <div class="req-row">
        <span class="swatch" style="background:${escapeHtml(r.colorHex)}"></span>
        <span class="req-name">${escapeHtml(r.colorName || colorName(r.colorHex).name)} / ${escapeHtml(r.type)}</span>
        <span class="req-grams">${Number.isFinite(Number(r.grams)) ? `<b>${fmt(r.grams, 1)}</b> g` : '<b>克重未知</b>'}</span>
      </div>`).join('') || '<p class="hint">没有材料需求，点「编辑」手动添加。</p>';
  }
}

function mergePlates(plates, plateIndex) {
  const map = new Map();
  for (const plate of plates) {
    if (plate.index !== plateIndex) continue;
    for (const f of plate.filaments) {
      const key = `${String(f.type || '').toUpperCase()}|${f.colorHex}`;
      const cur = map.get(key) || {
        type: f.type,
        colorHex: f.colorHex,
        grams: 0,
        known: true,
        name: f.colorName || colorName(f.colorHex).name,
      };
      if (!Number.isFinite(f.grams)) cur.known = false;
      else cur.grams += f.grams;
      map.set(key, cur);
    }
  }
  return [...map.values()].map((r, i) => makeReq({
    index: i + 1,
    type: r.type,
    colorHex: r.colorHex,
    colorName: r.name,
    grams: r.known ? Math.round(r.grams * 10) / 10 : null,
  }));
}

function renderRequirementEditor() {
  const box = $('#reqEdit');
  box.innerHTML = `
    <table>
      <thead><tr><th>颜色</th><th>类型</th><th>克重 g</th><th></th></tr></thead>
      <tbody>
        ${state.requirements.map((r, i) => `
          <tr>
            <td><input type="color" value="${escapeHtml(r.colorHex)}" data-req="${i}" data-field="colorHex" /></td>
            <td>
              <select data-req="${i}" data-field="type">
                ${['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', '其他'].map((t) => `<option ${r.type === t ? 'selected' : ''}>${t}</option>`).join('')}
              </select>
            </td>
            <td><input type="number" min="0" step="1" value="${Number.isFinite(Number(r.grams)) ? Number(r.grams) : ''}" data-req="${i}" data-field="grams" placeholder="未知" /></td>
            <td><button class="del" data-del="${i}" title="删除">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="row">
      <button class="ghost" id="btnAddReq">＋ 添加需求</button>
      <span class="hint">克重留空表示未知（只按颜色/类型匹配，扣减时会提示补充）。</span>
    </div>`;

  box.oninput = (e) => {
    const el = e.target.closest('[data-req]');
    if (!el) return;
    invalidateMatches();
    const i = Number(el.dataset.req);
    const field = el.dataset.field;
    const req = state.requirements[i];
    if (!req) return;
    if (field === 'grams') req.grams = el.value === '' ? null : Number(el.value);
    else if (field === 'colorHex') {
      req.colorHex = el.value.toUpperCase();
      req.colorName = colorName(req.colorHex).name;
      req.display = `${req.colorName} / ${req.type}`;
    } else {
      req[field] = el.value;
      req.display = `${req.colorName} / ${req.type}`;
    }
  };
  box.onclick = (e) => {
    if (e.target.closest('#btnAddReq')) {
      state.requirements.push(makeReq({ index: state.requirements.length + 1, type: 'PLA', colorHex: '#4FA3D8', grams: 50 }));
      invalidateMatches();
      renderRequirementEditor();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      state.requirements.splice(Number(del.dataset.del), 1);
      state.requirements.forEach((r, i) => { r.index = i + 1; });
      invalidateMatches();
      renderRequirementEditor();
    }
  };
}

function currentReqKey() {
  return JSON.stringify(state.requirements.filter((r) => r.colorHex && r.type));
}

async function runMatch() {
  if (!state.model) return;
  const reqs = state.requirements.filter((r) => r.colorHex && r.type);
  if (!reqs.length) {
    state.matches = null;
    state.matchesKey = null;
    $('#matchCard').hidden = true;
    $('#btnConfirm').disabled = true;
    setStatus('没有可匹配的材料需求，请先导入模型或手动添加需求。', 'error');
    return;
  }
  // 发请求前先让旧结果失效，避免"匹配失败还能按旧结果扣减"
  state.matches = null;
  state.matchesKey = null;
  state.overrides.clear();
  $('#matchCard').hidden = false;
  $('#matchList').innerHTML = '<p class="hint">正在从库存里挑料…</p>';
  $('#btnConfirm').disabled = true;
  try {
    const data = await api('/api/match', {
      method: 'POST',
      body: { requirements: reqs, options: state.settings.match || {} },
    });
    state.matches = data;
    state.matchesKey = currentReqKey();
    renderMatches();
    setStatus('', '');
  } catch (err) {
    state.matches = null;
    state.matchesKey = null;
    $('#matchCard').hidden = true;
    setStatus(`匹配失败：${err.message}`, 'error');
  }
}

/** 需求被编辑后，让之前的匹配结果失效。 */
function invalidateMatches() {
  state.matches = null;
  state.matchesKey = null;
  state.overrides.clear();
  if (state.model) $('#matchCard').hidden = true;
  $('#btnConfirm').disabled = true;
}

function effectiveAssignment(a) {
  const override = state.overrides.get(a.requirement.index);
  if (!override) return a;
  const spool = state.spools.find((s) => s.id === override);
  if (!spool) return a;
  const dE = deltaEHex(a.requirement.colorHex, spool.colorHex);
  const opts = state.settings.match || {};
  const good = opts.goodDeltaE ?? state.matchDefaults.goodDeltaE ?? 5;
  const max = opts.maxDeltaE ?? state.matchDefaults.maxDeltaE ?? 12;
  const grams = Number(a.requirement.grams);
  const shortfall = Number.isFinite(grams) ? Math.max(0, grams - spool.remainingGrams) : 0;
  let status = dE <= good ? 'ok' : dE <= max ? 'color_near' : 'color_far';
  if (shortfall > 0 && status !== 'color_far') status = 'insufficient';
  return {
    ...a,
    spool,
    deltaE: Math.round(dE * 10) / 10,
    status,
    overridden: true,
    parts: [],
    shortfallGrams: Math.round(shortfall * 10) / 10,
    message: '手动指定',
  };
}

function statusPill(status) {
  const s = STATUS[status] || { label: status, cls: 'warn' };
  return `<span class="status-pill ${s.cls}">${escapeHtml(s.label)}</span>`;
}

function renderMatches() {
  if (!state.matches) return;
  const { assignments, summary } = state.matches;
  const total = summary?.totalGrams ?? 0;
  const ok = assignments.filter((a) => ['ok', 'color_near', 'combine'].includes(a.status)).length;
  const problems = assignments.filter((a) => ['no_stock', 'no_type', 'insufficient', 'type_mismatch', 'color_far'].includes(a.status)).length;
  $('#matchSummary').innerHTML = `
    <div class="stat"><div class="k">需求项</div><div class="v">${assignments.length}</div></div>
    <div class="stat"><div class="k">总需求</div><div class="v">${summary?.gramsKnown === false ? '部分未知' : fmt(total, 1)}<small>${summary?.gramsKnown === false ? '' : 'g'}</small></div></div>
    <div class="stat"><div class="k">可自动选料</div><div class="v">${ok}</div></div>
    <div class="stat"><div class="k">需要处理</div><div class="v">${problems}</div></div>`;

  $('#matchList').innerHTML = assignments.map((a) => {
    const eff = effectiveAssignment(a);
    const s = STATUS[eff.status] || { cls: 'warn' };
    const bad = s.cls === 'bad';
    const warn = s.cls === 'warn';
    const req = eff.requirement;
    const grams = Number(req.grams);
    const spool = eff.spool;
    const remainAfter = spool && Number.isFinite(grams) && !eff.parts?.length
      ? Math.max(0, Math.round((spool.remainingGrams - grams) * 10) / 10)
      : null;
    const chosenId = state.overrides.get(req.index) || '';
    const selectOptions = state.spools.map((s) => `<option value="${s.id}" ${s.id === chosenId ? 'selected' : ''}>${escapeHtml(s.name)}（${escapeHtml(s.type)} · ${escapeHtml(s.colorName || '')} · 剩 ${fmt(s.remainingGrams)}g）</option>`).join('');
    const partsHtml = eff.parts?.length
      ? `<div class="parts"><span class="hint">拼盘方案：</span>${eff.parts.map((p) => `<span>${escapeHtml(p.spool.name)} · 取 ${fmt(p.grams, 1)} g（剩 ${fmt(p.spool.remainingGrams)} g）</span>`).join('')}</div>`
      : '';
    return `
      <div class="match-item ${bad ? 'problem' : warn ? 'warn' : ''}">
        <div class="match-top">
          <span class="swatch" style="background:${escapeHtml(req.colorHex)}"></span>
          <span class="req">${escapeHtml(req.colorName || colorName(req.colorHex).name)} / ${escapeHtml(req.type)}</span>
          <span class="hint">${Number.isFinite(grams) ? fmt(grams, 1) + ' g' : '克重未知'}</span>
          <span class="arrow">→</span>
          ${spool ? `<span class="picked">${spool.photo ? `<img src="${escapeHtml(spool.photo)}" alt="" />` : `<span class="swatch" style="background:${escapeHtml(spool.colorHex)}"></span>`}<b>${escapeHtml(spool.name)}</b></span>` : '<span class="hint">未选中</span>'}
          ${statusPill(eff.status)}
        </div>
        ${spool ? `<div class="detail">
            <span>色差 ΔE <b>${fmt(eff.deltaE, 1)}</b></span>
            <span>可用 <b>${fmt(eff.parts?.length ? eff.parts.reduce((x, p) => x + p.grams, 0) : spool.remainingGrams)} g</b></span>
            ${remainAfter !== null ? `<span>扣减后 <b>${fmt(remainAfter)} g</b></span>` : ''}
            ${eff.shortfallGrams > 0 ? `<span>缺口 <b>${fmt(eff.shortfallGrams)} g</b></span>` : ''}
          </div>` : ''}
        ${eff.message && !eff.overridden ? `<div class="msg">${escapeHtml(eff.message)}</div>` : ''}
        ${partsHtml}
        <div class="actions">
          <select data-override="${req.index}">
            <option value="" ${chosenId ? '' : 'selected'}>按自动匹配结果</option>
            ${selectOptions}
          </select>
          ${spool && (eff.overridden || ['ok', 'color_near', 'combine', 'type_mismatch'].includes(eff.status)) ? '<span class="hint">也可直接按上方结果扣减</span>' : ''}
        </div>
      </div>`;
  }).join('');

  $('#matchList').onchange = (e) => {
    const sel = e.target.closest('[data-override]');
    if (!sel) return;
    const idx = Number(sel.dataset.override);
    if (sel.value) state.overrides.set(idx, sel.value);
    else state.overrides.delete(idx);
    renderMatches();
  };

  updateConfirmState();
}

function buildItems() {
  const assignments = state.matches?.assignments || [];
  const items = new Map();
  const skipped = [];
  let missingGrams = 0;
  for (const raw of assignments) {
    const a = effectiveAssignment(raw);
    const grams = Number(a.requirement.grams);
    if (!Number.isFinite(grams) || grams <= 0) {
      missingGrams++;
      continue;
    }
    if (a.parts?.length) {
      for (const p of a.parts) {
        items.set(p.spool.id, (items.get(p.spool.id) || 0) + p.grams);
      }
      continue;
    }
    if (
      !a.spool ||
      ['no_stock', 'no_type', 'insufficient'].includes(a.status) ||
      (a.status === 'color_far' && !a.overridden)
    ) {
      skipped.push(a.requirement);
      continue;
    }
    items.set(a.spool.id, (items.get(a.spool.id) || 0) + grams);
  }
  return { items: [...items.entries()].map(([spoolId, grams]) => ({ spoolId, grams: Math.round(grams * 10) / 10 })), skipped, missingGrams };
}

function updateConfirmState() {
  const btn = $('#btnConfirm');
  const hint = $('#confirmHint');
  if (!state.matches || state.matchesKey !== currentReqKey()) {
    btn.disabled = true;
    btn.textContent = '确认并扣减余量';
    hint.textContent = state.matches ? '需求已修改，请重新匹配' : '';
    return;
  }
  const { items, skipped, missingGrams } = buildItems();
  const done = state.matches.done;
  btn.disabled = done || missingGrams > 0 || !items.length;
  btn.textContent = done ? '已扣减 ✓' : '确认并扣减余量';
  if (done) hint.textContent = '已写入打印记录';
  else if (missingGrams) hint.textContent = `有 ${missingGrams} 项缺少克重，请点「编辑」补全后再扣减`;
  else if (!items.length) hint.textContent = '没有可扣减的匹配项';
  else hint.textContent = `共 ${items.length} 盘、${fmt(items.reduce((s, i) => s + i.grams, 0), 1)} g${skipped.length ? `；${skipped.length} 项未匹配将被跳过` : ''}`;
}

async function confirmJob() {
  if (!state.matches || state.matches.done) return;
  if (state.matchesKey !== currentReqKey()) {
    return toast('需求已修改，请重新匹配后再扣减', true);
  }
  const { items, missingGrams } = buildItems();
  if (missingGrams > 0) return toast('还有需求缺少克重，请补全后再扣减', true);
  if (!items.length) return toast('没有可扣减的匹配项', true);
  const btn = $('#btnConfirm');
  btn.disabled = true;
  try {
    await api('/api/jobs', {
      method: 'POST',
      body: {
        title: state.model?.title || '未命名打印',
        sourceUrl: state.model?.sourceUrl || '',
        items,
      },
    });
    state.matches.done = true;
    await refreshState();
    renderMatches();
    toast(`已扣减 ${fmt(items.reduce((s, i) => s + i.grams, 0), 1)} g，库存已更新`);
  } catch (err) {
    btn.disabled = false;
    toast(`扣减失败：${err.message}`, true);
  }
}

// ---------------- 拍照添加（识别 / 手动 二合一） ----------------

let visionStatusCache = { at: 0, ready: false, label: '' };

async function ensureVisionStatus(force = false) {
  if (!force && Date.now() - visionStatusCache.at < 30000) return visionStatusCache;
  try {
    const st = await api('/api/vision/status');
    visionStatusCache = {
      at: Date.now(),
      ready: Boolean(st.ready),
      label: st.ready ? `${st.provider} · ${st.model}` : '',
    };
  } catch (err) {
    visionStatusCache = {
      at: Date.now(),
      ready: false,
      label:
        err.status === 404
          ? `当前页面（${location.origin}）连的是旧版服务，请改用 http://127.0.0.1:4174`
          : '',
    };
  }
  state.visionReady = visionStatusCache.ready;
  return visionStatusCache;
}

function updateEngineHint() {
  ensureVisionStatus(true).then((st) => {
    $('#recognizeEngineHint').textContent = st.ready
      ? `识别引擎：${st.label}`
      : st.label || '未配置识别引擎：可手动填写，或在 ⚙ 设置里配置视觉模型';
    $('#btnRunRecognize').disabled = !state.add.dataUrl || !st.ready;
  });
}

function setAddStatus(text, kind = '') {
  const el = $('#addStatus');
  el.hidden = !text;
  el.className = `status ${kind}`;
  el.textContent = text || '';
}

function emptyAddItem(partial = {}) {
  return {
    ...partial,
    name: partial.name || '',
    brand: partial.brand || '',
    material: partial.material || 'PLA',
    colorName: partial.colorName || '',
    colorHex: partial.colorHex || '#808080',
    sku: partial.sku || '',
    spoolWeightG: Number(partial.spoolWeightG) || 1000,
    count: Number(partial.count) || 1,
  };
}

function recogStatusLabel(item) {
  if (item.hexSource === 'catalog') return '官方色卡';
  if (item.hexSource === 'dictionary') return '色名字典';
  if (item.hexSource === 'model') return '模型估算';
  return '';
}

function openAddModal(prefill = null) {
  state.add = {
    dataUrl: prefill?.dataUrl || '',
    mime: /^data:(image\/[a-z+]+)/i.exec(String(prefill?.dataUrl || ''))?.[1] || 'image/jpeg',
    items: [],
    activeIndex: 0,
    summary: prefill?.summary || '',
  };
  $('#addPhotoInput').value = '';
  $('#addSummary').textContent = '';
  setAddStatus('', '');
  renderAddPhoto();
  if (prefill?.items?.length) {
    state.add.items = prefill.items.map((it) => emptyAddItem(it));
    setAddStatus(`已识别 ${state.add.items.length} 项，核对后可入库`, 'ok');
  }
  renderAddItems();
  updateEngineHint();
  openModal('modalAdd');
}

function renderAddPhoto() {
  const wrap = $('#photoWrap');
  const img = $('#addPhotoImg');
  if (!state.add.dataUrl) {
    wrap.hidden = true;
    img.removeAttribute('src');
    return;
  }
  img.src = state.add.dataUrl;
  wrap.hidden = false;
}

function pickColorForActiveItem(hex) {
  const items = state.add.items;
  if (!items.length) return;
  const i = Math.min(Math.max(0, state.add.activeIndex), items.length - 1);
  items[i].colorHex = String(hex).toUpperCase();
  renderAddItems();
}

async function onAddPhotoPicked(file) {
  if (!file) return;
  try {
    const raw = await fileToDataUrl(file);
    const dataUrl = await downscaleDataUrl(raw, 1400);
    state.add.dataUrl = dataUrl;
    state.add.mime = /^data:(image\/[a-z+]+)/i.exec(String(dataUrl))?.[1] || 'image/jpeg';
    $('#addPhotoInput').value = '';
    renderAddPhoto();
    const st = await ensureVisionStatus();
    $('#btnRunRecognize').disabled = !st.ready;
    if (st.ready) {
      setAddStatus('照片已载入，正在自动识别…（识别不了也可以直接手动填）', 'loading');
      runAddRecognition();
    } else {
      setAddStatus(st.label || '照片已载入；未配置识别引擎，可直接手动填写或点图片放大取色', '');
      if (!state.add.items.length) addAddItem(true);
    }
  } catch (err) {
    setAddStatus(`照片读取失败：${err.message}`, 'error');
  }
}

function addAddItem(render = true) {
  state.add.items.push(emptyAddItem({}));
  state.add.activeIndex = state.add.items.length - 1;
  if (render) renderAddItems();
}

async function runAddRecognition() {
  if (!state.add.dataUrl) return toast('请先拍照或选择照片', true);
  setAddStatus('正在识别…（本地视觉模型首次加载可能较慢）', 'loading');
  $('#btnRunRecognize').disabled = true;
  try {
    const data = await api('/api/recognize', {
      method: 'POST',
      body: {
        base64: String(state.add.dataUrl).replace(/^data:[^;]+;base64,/, ''),
        mimeType: state.add.mime,
      },
    });
    const items = (data.items || []).map((it) => emptyAddItem(it));
    state.add.items = items;
    state.add.activeIndex = 0;
    state.add.summary = data.summary || '';
    renderAddItems();
    if (items.length) {
      const warn = data.warnings && data.warnings.length ? `（${data.warnings.join('；')}）` : '';
      setAddStatus(`识别完成：${data.summary || `${items.length} 项耗材`}${warn}`, 'ok');
    } else {
      setAddStatus('没有识别到耗材，可手动添加一行或换张照片', 'error');
      if (!state.add.items.length) addAddItem(true);
    }
  } catch (err) {
    const msg =
      err.status === 404 || /未知接口/.test(err.message || '')
        ? `当前页面（${location.origin}）连接的是旧版服务，请改用 http://127.0.0.1:4174`
        : `识别失败：${err.message}（可手动填写）`;
    setAddStatus(msg, 'error');
    if (!state.add.items.length) addAddItem(true);
  } finally {
    $('#btnRunRecognize').disabled = !state.add.dataUrl || !state.visionReady;
  }
}

function renderAddItems() {
  const box = $('#addItems');
  const items = state.add.items;
  if (!items.length) {
    box.innerHTML = '<p class="hint">还没有条目：点上方「识别照片」自动识别，或点「＋ 手动添加一行」。</p>';
    updateAddSummary();
    return;
  }
  const materialOptions = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', '其他']
    .map((t) => `<option value="${t}">${t}</option>`)
    .join('');
  box.innerHTML = items
    .map((it, i) => {
      const conf = Math.round((Number(it.confidence) || 0) * 100);
      return `
      <div class="recog-item ${i === state.add.activeIndex ? 'active' : ''}" data-item="${i}">
        <div class="recog-top">
          <span class="swatch" data-swatch="${i}" style="background:${escapeHtml(it.colorHex || '#CCCCCC')}"></span>
          <span class="recog-title">${escapeHtml(it.name || it.colorName || '新耗材')}</span>
          ${it.confidence !== undefined ? `<span class="conf ${conf < 70 ? 'low' : ''}">置信度 ${conf}%</span>` : ''}
          ${it.hexSource ? `<span class="hint">${escapeHtml(recogStatusLabel(it))}</span>` : ''}
          ${i === state.add.activeIndex ? '<span class="conf">取色目标</span>' : ''}
          <button class="recog-del" data-del="${i}" title="移除此项">✕</button>
        </div>
        <div class="recog-grid">
          <label class="wide">名称<input value="${escapeHtml(it.name || '')}" data-add="${i}" data-field="name" placeholder="留空则用 颜色名+材料" /></label>
          <label>颜色<input type="color" value="${escapeHtml(it.colorHex || '#999999')}" data-add="${i}" data-field="colorHex" /></label>
          <label>品牌<input value="${escapeHtml(it.brand || '')}" data-add="${i}" data-field="brand" /></label>
          <label>材料<select data-add="${i}" data-field="material">${materialOptions}</select></label>
          <label>颜色名<input value="${escapeHtml(it.colorName || '')}" data-add="${i}" data-field="colorName" /></label>
          <label>SKU<input value="${escapeHtml(it.sku || '')}" data-add="${i}" data-field="sku" /></label>
          <label>单盘克重<input type="number" min="1" step="10" value="${Number(it.spoolWeightG) || 1000}" data-add="${i}" data-field="spoolWeightG" /></label>
          <label>数量<input type="number" min="1" max="20" value="${Number(it.count) || 1}" data-add="${i}" data-field="count" /></label>
        </div>
      </div>`;
    })
    .join('');
  items.forEach((it, i) => {
    const sel = box.querySelector(`select[data-add="${i}"][data-field="material"]`);
    if (sel) sel.value = it.material || 'PLA';
  });
  box.onclick = (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      state.add.items.splice(Number(del.dataset.del), 1);
      state.add.activeIndex = Math.max(0, Math.min(state.add.activeIndex, state.add.items.length - 1));
      renderAddItems();
      return;
    }
    const card = e.target.closest('[data-item]');
    if (card && !e.target.closest('input,select,button')) {
      state.add.activeIndex = Number(card.dataset.item);
      renderAddItems();
      toast(`取色目标：第 ${state.add.activeIndex + 1} 项（在放大的图片上点一下即可取色）`);
    }
  };
  box.oninput = (e) => {
    const el = e.target.closest('[data-add]');
    if (!el) return;
    const i = Number(el.dataset.add);
    const field = el.dataset.field;
    const item = state.add.items[i];
    if (!item) return;
    if (field === 'spoolWeightG' || field === 'count') item[field] = Number(el.value);
    else item[field] = el.value;
    if (field === 'colorHex') {
      const sw = box.querySelector(`[data-swatch="${i}"]`);
      if (sw) sw.style.background = el.value;
    }
    if (field === 'name' || field === 'colorName') {
      const t = box.querySelector(`[data-item="${i}"] .recog-title`);
      if (t) t.textContent = item.name || item.colorName || '新耗材';
    }
  };
  updateAddSummary();
}

function updateAddSummary() {
  const items = state.add.items;
  const total = items.reduce((s, it) => s + Math.min(20, Math.max(1, Math.round(Number(it.count) || 1))), 0);
  $('#btnSaveItems').disabled = !items.length;
  $('#addSummary').textContent = items.length ? `共 ${items.length} 项 / ${total} 盘` : '';
}

async function saveAddItems() {
  const items = state.add.items;
  if (!items.length) return toast('没有可添加的耗材', true);
  const splitCount = Boolean($('#splitCount') && $('#splitCount').checked);
  const spools = [];
  for (const it of items) {
    const colorHex = /^#[0-9a-fA-F]{6}$/.test(String(it.colorHex || '')) ? String(it.colorHex).toUpperCase() : '';
    if (!colorHex) return toast('有条目的颜色格式不对，请修正', true);
    const count = Math.min(20, Math.max(1, Math.round(Number(it.count) || 1)));
    const grams = Math.min(5000, Math.max(50, Math.round(Number(it.spoolWeightG) || 1000)));
    const material = it.material || 'PLA';
    const colorName = it.colorName || '';
    const name = it.name || [colorName, material].filter(Boolean).join(' ') || `${material} 耗材`;
    const note = [it.sku ? `SKU ${it.sku}` : '', it.productLine || it.labelText || ''].filter(Boolean).join(' · ').slice(0, 300);
    const base = { name, brand: it.brand || '', type: material, colorHex, colorName, spoolWeightG: grams, note };
    if (splitCount) {
      for (let k = 0; k < count; k++) {
        spools.push({ ...base, count: 1, totalGrams: grams, remainingGrams: grams });
      }
    } else {
      // 默认：同款多盒合并成一条（×N 盘），总重/余量按合计
      spools.push({ ...base, count, totalGrams: Math.round(grams * count * 10) / 10, remainingGrams: Math.round(grams * count * 10) / 10 });
    }
  }
  $('#btnSaveItems').disabled = true;
  try {
    const data = await api('/api/spools/bulk', {
      method: 'POST',
      body: { items: spools, photoDataUrl: state.add.dataUrl || '' },
    });
    closeModal('modalAdd');
    await refreshState();
    switchView('inventory');
    const queued = state.imageQueue && (state.imageQueue.running || state.imageQueue.pending > 0);
    toast(queued ? `已加入 ${data.spools.length} 盘，正在自动拉取商品图…` : `已加入 ${data.spools.length} 盘耗材`);
  } catch (err) {
    $('#btnSaveItems').disabled = false;
    toast(`添加失败：${err.message}`, true);
  }
}

async function loadLanInfo() {
  const input = $('#lanUrl');
  const hint = $('#lanHint');
  try {
    const info = await api('/api/net');
    const url = info.urls?.find((u) => /^(192|10|172)\./.test(u.address))?.url || info.urls?.[0]?.url || '';
    input.value = url;
    hint.textContent = info.lanEnabled
      ? url
        ? '手机连同一个 Wi-Fi，用浏览器打开上面的地址即可拍照录入；可「添加到主屏幕」当 App 用。'
        : '没有检测到局域网地址，请检查网络。'
      : '当前只监听 127.0.0.1：请用 node server.mjs --lan 重启（Docker 用 -p 映射端口），手机才能访问。';
  } catch (err) {
    input.value = '';
    hint.textContent = `获取手机访问地址失败：${err.message}`;
  }
}

function copyLanUrl() {
  const input = $('#lanUrl');
  const value = input.value;
  if (!value) return toast('还没有可复制的地址：请用 --lan 启动', true);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(
      () => toast('地址已复制，发到手机上打开即可'),
      () => toast('复制失败，请手动选择复制', true),
    );
  } else {
    input.select?.();
    toast('已选中地址，请手动复制');
  }
}

async function testVisionService() {
  const el = $('#visionStatusText');
  el.textContent = '检测中…';
  try {
    const st = await api('/api/vision/status');
    el.textContent = st.ready
      ? `✅ 可用：${st.provider} · ${st.model}`
      : `⚠️ 不可用：${st.reason || '未配置'}${st.availableModels?.length ? `（现有模型：${st.availableModels.join(', ')}）` : ''}`;
  } catch (err) {
    el.textContent =
      err.status === 404
        ? `检测失败：当前页面（${location.origin}）连的是旧版服务，请改用 http://127.0.0.1:4174`
        : `检测失败：${err.message}`;
  }
}

// ---------------- 图片放大 / 取色 ----------------

function openLightbox(src, onPick) {
  if (!src) return;
  state.lightbox = { src, onPick, zoom: 0, canvas: null, moved: false, downX: 0, downY: 0, scrollLeft: 0, scrollTop: 0 };
  const img = $('#lightboxImg');
  img.src = src;
  img.className = 'fit';
  img.style.width = '';
  $('#photoLightbox').hidden = false;
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    if (state.lightbox) state.lightbox.canvas = ctx;
  };
}

function closeLightbox() {
  $('#photoLightbox').hidden = true;
  $('#lightboxImg').removeAttribute('src');
  state.lightbox = null;
}

function setLightboxZoom(zoom) {
  if (!state.lightbox) return;
  const img = $('#lightboxImg');
  if (!zoom) {
    state.lightbox.zoom = 0;
    img.className = 'fit';
    img.style.width = '';
    return;
  }
  state.lightbox.zoom = Math.min(8, Math.max(0.2, zoom));
  img.className = '';
  img.style.width = `${Math.round(img.naturalWidth * state.lightbox.zoom)}px`;
}

function bindLightboxControls() {
  const stage = $('#lightboxStage');
  const img = $('#lightboxImg');

  img.addEventListener('click', (e) => {
    const lb = state.lightbox;
    if (!lb || !lb.canvas || lb.moved) return;
    const rect = img.getBoundingClientRect();
    const scale = rect.width / img.naturalWidth;
    const x = Math.round((e.clientX - rect.left) / scale);
    const y = Math.round((e.clientY - rect.top) / scale);
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return;
    const hex = sampleMedian(lb.canvas, x, y, 6);
    if (!hex) return;
    if (lb.onPick) lb.onPick(hex);
    toast(`已取色 ${hex}（${colorName(hex).name}）`);
  });

  img.addEventListener('pointerdown', (e) => {
    const lb = state.lightbox;
    if (!lb || !lb.zoom) return;
    lb.moved = false;
    lb.downX = e.clientX;
    lb.downY = e.clientY;
    lb.scrollLeft = stage.scrollLeft;
    lb.scrollTop = stage.scrollTop;
    try { img.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  });
  img.addEventListener('pointermove', (e) => {
    const lb = state.lightbox;
    if (!lb || !lb.zoom || !lb.downX) return;
    const dx = e.clientX - lb.downX;
    const dy = e.clientY - lb.downY;
    if (Math.abs(dx) + Math.abs(dy) > 6) lb.moved = true;
    stage.scrollLeft = lb.scrollLeft - dx;
    stage.scrollTop = lb.scrollTop - dy;
  });
  img.addEventListener('pointerup', () => {
    setTimeout(() => {
      if (state.lightbox) state.lightbox.moved = false;
    }, 0);
  });
  stage.addEventListener('wheel', (e) => {
    if (!state.lightbox) return;
    e.preventDefault();
    const base = state.lightbox.zoom || 1;
    setLightboxZoom(base * (e.deltaY < 0 ? 1.25 : 0.8));
  }, { passive: false });

  $$('[data-lb]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const act = btn.dataset.lb;
      if (act === 'close') return closeLightbox();
      if (!state.lightbox) return;
      if (act === 'zoomin') setLightboxZoom((state.lightbox.zoom || 0.8) * 1.5);
      else if (act === 'zoomout') setLightboxZoom((state.lightbox.zoom || 1.5) / 1.5);
      else setLightboxZoom(1);
    }),
  );
}

// ---------------- 打印记录 ----------------

function renderJobs() {
  const jobs = state.jobs;
  $('#jobsHint').textContent = jobs.length ? `共 ${jobs.length} 条` : '';
  $('#jobList').innerHTML = jobs.map((j) => {
    const date = new Date(j.createdAt);
    const dateStr = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `
      <div class="job">
        <div class="job-head">
          <span class="t">${escapeHtml(j.title)}</span>
          <span class="d">${dateStr} · 合计 ${fmt(j.totalGrams, 1)} g</span>
        </div>
        <div class="job-items">
          ${j.items.map((it) => `<span class="job-item"><span class="swatch" style="background:${escapeHtml(it.colorHex)}"></span>${escapeHtml(it.spoolName || '已删除材料')} · ${fmt(it.grams, 1)} g</span>`).join('')}
        </div>
      </div>`;
  }).join('');
  $('#jobsEmpty').hidden = jobs.length > 0;
}

// ---------------- 设置 ----------------

function openSettings() {
  const m = state.settings.match || {};
  const defaults = state.matchDefaults || {};
  $('#setMaxDeltaE').value = m.maxDeltaE ?? defaults.maxDeltaE ?? 12;
  $('#setGoodDeltaE').value = m.goodDeltaE ?? defaults.goodDeltaE ?? 5;
  $('#setAllowTypeMismatch').checked = Boolean(m.allowTypeMismatch);
  $('#setPreferOpened').checked = m.preferOpened !== undefined ? Boolean(m.preferOpened) : defaults.preferOpened !== false;
  const v = state.settings.vision || {};
  $('#setVisionProvider').value = v.provider || '';
  $('#setVisionModel').value = v.model || '';
  $('#setVisionBaseUrl').value = v.baseUrl || '';
  $('#setVisionApiKey').value = '';
  $('#setVisionApiKey').placeholder = v.hasApiKey ? '已保存 API Key（留空不修改）' : 'sk-…（只保存在本地）';
  $('#visionStatusText').textContent = '';
  const tokenEl = $('#setApiToken');
  if (tokenEl) tokenEl.value = state.apiToken;
  loadLanInfo();
  updateSettingsLabels();
  openModal('modalSettings');
}

function updateSettingsLabels() {
  $('#maxDeltaELabel').textContent = $('#setMaxDeltaE').value;
  $('#goodDeltaELabel').textContent = $('#setGoodDeltaE').value;
}

async function saveSettings() {
  // 令牌只存浏览器本地；先保存，后续请求才会带上
  const token = ($('#setApiToken')?.value || '').trim();
  state.apiToken = token;
  persistApiToken(token);
  const match = {
    maxDeltaE: Number($('#setMaxDeltaE').value),
    goodDeltaE: Number($('#setGoodDeltaE').value),
    allowTypeMismatch: $('#setAllowTypeMismatch').checked,
    preferOpened: $('#setPreferOpened').checked,
  };
  const vision = {
    provider: $('#setVisionProvider').value,
    model: $('#setVisionModel').value.trim(),
    baseUrl: $('#setVisionBaseUrl').value.trim(),
  };
  const apiKey = $('#setVisionApiKey').value.trim();
  if (apiKey) vision.apiKey = apiKey;
  try {
    await api('/api/settings', { method: 'POST', body: { match, vision } });
    closeModal('modalSettings');
    await refreshState();
    toast('设置已保存');
  } catch (err) {
    toast(`保存设置失败：${err.message}`, true);
  }
}

// ---------------- 事件绑定 ----------------

function bindEvents() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $('#btnAdd').addEventListener('click', () => openAddModal());
  $('#btnAddEmpty').addEventListener('click', () => openAddModal());
  $('#btnFetchImages').addEventListener('click', fetchMissingProductImages);
  $('#btnMergeDuplicates').addEventListener('click', mergeDuplicateSpools);
  $('#viewSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.inventory.view = btn.dataset.view;
    saveInventoryPrefs();
    renderInventory();
  });
  $('#groupBy').addEventListener('change', () => {
    state.inventory.group = $('#groupBy').value;
    saveInventoryPrefs();
    renderInventory();
  });
  $('#filterBrand').addEventListener('change', () => {
    state.inventory.filterBrand = $('#filterBrand').value;
    renderInventory();
  });
  $('#filterType').addEventListener('change', () => {
    state.inventory.filterType = $('#filterType').value;
    renderInventory();
  });
  $('#searchSpools').addEventListener('input', () => {
    state.inventory.query = $('#searchSpools').value;
    renderInventory();
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#authBannerOpen').addEventListener('click', (e) => {
    e.preventDefault();
    openSettings();
  });
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#addPhotoInput').addEventListener('change', (e) => onAddPhotoPicked(e.target.files?.[0]));
  $('#btnRunRecognize').addEventListener('click', runAddRecognition);
  $('#btnAddManualItem').addEventListener('click', () => addAddItem(true));
  $('#btnSaveItems').addEventListener('click', saveAddItems);
  $('#addPhotoImg').addEventListener('click', () => openLightbox(state.add.dataUrl, pickColorForActiveItem));
  $('#btnZoomPhoto').addEventListener('click', () => openLightbox(state.add.dataUrl, pickColorForActiveItem));
  bindLightboxControls();
  $('#btnTestVision').addEventListener('click', testVisionService);
  $('#btnCopyLan').addEventListener('click', copyLanUrl);
  for (const id of ['setMaxDeltaE', 'setGoodDeltaE']) $(`#${id}`).addEventListener('input', updateSettingsLabels);

  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  $$('.modal').forEach((modal) => modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.lightbox) return closeLightbox();
    $$('.modal').forEach((m) => { m.hidden = true; });
  });

  $('#photoInput').addEventListener('change', (e) => onPhotoPicked(e.target.files?.[0]));
  $('#btnAutoFillFromPhoto').addEventListener('click', autoFillFromPhoto);
  $('#btnClearPhoto').addEventListener('click', () => {
    state.photo.dataUrl = '';
    state.photo.cleared = true;
    const img = $('#editPhotoImg');
    img.hidden = true;
    img.removeAttribute('src');
    $('.photo-placeholder').hidden = false;
  });
  const colorEl = $('#spoolForm [name="colorHex"]');
  const textEl = $('#spoolForm [name="colorHexText"]');
  colorEl.addEventListener('input', () => syncColorInputs(colorEl.value));
  textEl.addEventListener('change', () => {
    const v = textEl.value.trim().startsWith('#') ? textEl.value.trim() : `#${textEl.value.trim()}`;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) syncColorInputs(v.toUpperCase());
  });
  $('#btnSaveSpool').addEventListener('click', saveSpool);

  // 选料
  $('#btnResolve').addEventListener('click', resolveLink);
  $('#mwUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') resolveLink(); });
  $('#btnSample').addEventListener('click', async () => {
    try {
      const { model } = await api('/api/sample');
      setStatus('已载入内置示例', 'ok');
      applyModel(model);
    } catch (err) {
      setStatus(`载入示例失败：${err.message}`, 'error');
    }
  });
  $('#btnManual').addEventListener('click', () => {
    setStatus('手动录入模式：填写颜色/材料/克重后点「自动匹配库存」', '');
    applyModel({
      title: '手动录入的打印需求',
      source: 'manual',
      sourceUrl: '',
      requirements: [makeReq({ type: 'PLA', colorHex: '#17181A', grams: 50 })],
      plates: [],
      warnings: [],
    });
  });
  $('#file3mf').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`正在解析 ${file.name}…`, 'loading');
    try {
      const dataUrl = await fileToDataUrl(file);
      const base64 = String(dataUrl).replace(/^data:[^;]+;base64,/, '');
      const data = await api('/api/import/3mf', { method: 'POST', body: { filename: file.name, base64 } });
      setStatus(`已解析 ${file.name}`, 'ok');
      applyModel({ ...data, sourceUrl: '' });
    } catch (err) {
      setStatus(`解析失败：${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });
  $('#btnEditReqs').addEventListener('click', () => {
    state.editingReqs = !state.editingReqs;
    renderModelCard();
    if (!state.editingReqs) runMatch();
  });
  $('#btnMatch').addEventListener('click', runMatch);
  $('#btnConfirm').addEventListener('click', confirmJob);
}

async function resolveLink() {
  const url = $('#mwUrl').value.trim();
  if (!url) return toast('请先粘贴 MakerWorld 链接', true);
  setStatus('正在向 MakerWorld 请求模型数据…（可能需要几秒）', 'loading');
  try {
    const data = await api('/api/makerworld/resolve', { method: 'POST', body: { url } });
    if (data.needs3mf) {
      setStatus(
        `已识别模型《${data.title || 'MakerWorld 模型'}》。匿名接口拿不到材料克重：请在该模型页点「下载打印配置」，再把 .3mf 上传到这里（或手动录入需求）。`,
        '',
      );
    } else {
      setStatus(`解析成功：${data.title || '模型'}`, 'ok');
    }
    applyModel({ ...data, sourceUrl: url });
  } catch (err) {
    const fallbacks = err.payload?.fallbacks || [];
    const tips = fallbacks.includes('upload_3mf')
      ? ' 可以点上方「上传打印配置 .3mf」，或直接「手动录入需求」。'
      : '';
    setStatus(`解析失败：${err.message}${tips}`, 'error');
  }
}

// ---------------- 启动 ----------------

// 油猴脚本导入后通过 #import=<id> 回到本页面
function showVersionBanner(text) {
  const banner = $('#versionBanner');
  $('#bannerOrigin').textContent = location.origin;
  banner.firstChild.textContent = text;
  banner.hidden = false;
}

async function checkBackendVersion() {
  let stale = false;
  try {
    await api('/api/vision/status');
  } catch (err) {
    if (err.status === 404) stale = true;
  }
  if (!stale) return;

  // 旧实例（常见是之前遗留的 4173）：探测新版 4174 是否在跑，在跑就自动切过去
  let newer = false;
  try {
    const res = await fetch('http://127.0.0.1:4174/api/health', { cache: 'no-store' });
    newer = res.ok;
  } catch {
    newer = false;
  }
  if (newer && location.port !== '4174') {
    showVersionBanner('检测到新版服务在 http://127.0.0.1:4174，正在自动切换… ');
    setTimeout(() => location.replace('http://127.0.0.1:4174/'), 1200);
  } else {
    showVersionBanner('当前页面连接的是旧版服务（没有图片识别接口）。请改用新版地址： ');
  }
}

async function handleImportHash() {
  const m = location.hash.match(/^#import=([a-z0-9]+)$/i);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  try {
    const { payload } = await api(`/api/pending/${m[1]}`);
    switchView('match');
    const hasReqs = (payload.requirements || []).length > 0;
    setStatus(`已从 MakerWorld 页面导入「${payload.title || '模型'}」${hasReqs ? '' : '，未解析到材料，请手动补充需求'}`, hasReqs ? 'ok' : 'error');
    applyModel(payload);
  } catch (err) {
    toast(`导入失败：${err.message}`, true);
  }
}

bindEvents();
state.inventory = loadInventoryPrefs();
state.apiToken = loadApiToken();
refreshState()
  .then(checkBackendVersion)
  .then(handleImportHash)
  .catch((err) => {
    setStatus(`无法连接本地服务：${err.message}`, 'error');
    toast('无法连接本地服务，请确认 node server.mjs 正在运行', true);
  });
