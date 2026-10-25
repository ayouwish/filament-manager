// 本地 JSON 数据存储：材料库存、打印记录、设置、照片文件。
// 零依赖；写入使用「临时文件 + rename」保证原子性。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { colorName } from './color.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.FM_DATA_DIR || path.join(ROOT, 'data'));
export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const now = () => new Date().toISOString();
const round1 = (n) => Math.round(Number(n) * 10) / 10;
const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

function ensureDirs() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

function emptyDb() {
  return {
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    spools: [],
    jobs: [],
    settings: {
      match: {},
      vision: {},
    },
  };
}

function seedDb() {
  const db = emptyDb();
  const mk = (name, brand, type, colorHex, remaining, total, note = '') => {
    const id = newId('s');
    return {
      id,
      name,
      brand,
      type,
      colorHex,
      colorName: colorName(colorHex).name,
      totalGrams: total,
      remainingGrams: remaining,
      photo: '',
      note,
      opened: remaining < total,
      createdAt: now(),
      updatedAt: now(),
    };
  };
  db.spools = [
    mk('黑武士 PLA', 'Bambu Lab', 'PLA', '#17181A', 900, 1000, '示例数据，可删除'),
    mk('象牙白 PLA', 'Bambu Lab', 'PLA', '#F2F2EE', 520, 1000, '示例数据，可删除'),
    mk('烈焰红 PLA', 'eSun', 'PLA', '#C62828', 180, 1000, '示例数据，可删除'),
    mk('宝蓝 PETG', 'Polymaker', 'PETG', '#1E5FBF', 700, 1000, '示例数据，可删除'),
    mk('天空蓝 PLA', 'eSun', 'PLA', '#4FA3D8', 260, 1000, '示例数据，可删除'),
    mk('透明 PETG', 'Polymaker', 'PETG', '#E9E9E2', 800, 1000, '示例数据，可删除'),
  ];
  db.jobs = [];
  return db;
}

export function readDb() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    const db = seedDb();
    writeDb(db);
    return db;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    const db = JSON.parse(raw);
    db.spools ||= [];
    db.jobs ||= [];
    db.settings ||= {};
    return db;
  } catch (err) {
    throw new Error(`数据文件损坏（${DB_FILE}）：${err.message}`);
  }
}

export function writeDb(db) {
  ensureDirs();
  db.updatedAt = now();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  return db;
}

// ---------- 材料 ----------

export function listSpools() {
  return readDb().spools;
}

export function getSpool(id) {
  return readDb().spools.find((s) => s.id === id) || null;
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function clampText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function clampNumber(value, lo, hi, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;
}

function pickSpoolFields(input = {}, prev = {}) {
  const out = { ...prev };
  if (input.name !== undefined) out.name = clampText(input.name, 60);
  if (input.brand !== undefined) out.brand = clampText(input.brand, 40);
  if (input.type !== undefined) out.type = clampText(input.type, 20) || 'PLA';
  if (input.colorHex !== undefined) {
    const hex = String(input.colorHex).trim().toUpperCase();
    const m = hex.match(/^#?([0-9A-F]{6})$/);
    if (!m) throw badRequest('颜色格式应为 #RRGGBB');
    out.colorHex = `#${m[1]}`;
  }
  if (input.note !== undefined) out.note = clampText(input.note, 300);
  if (input.totalGrams !== undefined) out.totalGrams = clampNumber(input.totalGrams, 0, 1e6, out.totalGrams ?? 0);
  if (input.remainingGrams !== undefined) out.remainingGrams = clampNumber(input.remainingGrams, 0, 1e6, out.remainingGrams ?? 0);
  if (input.count !== undefined) out.count = Math.min(99, Math.max(1, Math.round(Number(input.count) || 1)));
  if (input.spoolWeightG !== undefined) out.spoolWeightG = clampNumber(input.spoolWeightG, 10, 5000, out.spoolWeightG ?? 1000);
  out.colorName = input.colorName ? clampText(input.colorName, 20) : colorName(out.colorHex).name;
  if (out.remainingGrams !== undefined && out.totalGrams !== undefined) {
    out.remainingGrams = Math.min(out.remainingGrams, out.totalGrams);
    out.opened = out.remainingGrams < out.totalGrams - 0.5;
  }
  return out;
}

/** 新增材料；photoDataUrl 形如 "data:image/jpeg;base64,..."（可选）。 */
export function createSpool(input) {
  const db = readDb();
  const spool = pickSpoolFields(input, {
    id: newId('s'),
    name: '',
    brand: '',
    type: 'PLA',
    colorHex: '#808080',
    colorName: '灰色',
    totalGrams: 1000,
    remainingGrams: 1000,
    count: 1,
    spoolWeightG: 1000,
    photo: '',
    productPhoto: '',
    productPhotoSource: '',
    note: '',
    opened: false,
    createdAt: now(),
    updatedAt: now(),
  });
  if (!spool.name) spool.name = `${spool.colorName} ${spool.type}`.trim();
  // 同款多盒：给了 count 但没给总量时，按 单盘克重 × 数量 计算
  if (input.count !== undefined && input.totalGrams === undefined) {
    spool.totalGrams = round1(spool.spoolWeightG * spool.count);
  }
  if (input.count !== undefined && input.remainingGrams === undefined) {
    spool.remainingGrams = spool.totalGrams;
  }
  if (input.photoDataUrl) spool.photo = savePhotoDataUrl(spool.id, input.photoDataUrl);
  db.spools.push(spool);
  writeDb(db);
  return spool;
}

export function updateSpool(id, input) {
  const db = readDb();
  const idx = db.spools.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const prev = db.spools[idx];
  const spool = pickSpoolFields(input, prev);
  spool.updatedAt = now();
  if (input.photoDataUrl) {
    const old = spool.photo;
    spool.photo = savePhotoDataUrl(spool.id, input.photoDataUrl);
    if (old && old !== spool.photo) removePhoto(old);
  }
  if (input.photo === '') {
    removePhoto(spool.photo);
    spool.photo = '';
  }
  db.spools[idx] = spool;
  writeDb(db);
  return spool;
}

function removePhotoIfUnused(db, photoPath) {
  if (!photoPath) return;
  const used = db.spools.some((s) => s.photo === photoPath || s.productPhoto === photoPath);
  if (!used) removePhoto(photoPath);
}

export function deleteSpool(id) {
  const db = readDb();
  const idx = db.spools.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const [spool] = db.spools.splice(idx, 1);
  writeDb(db);
  // 批量入库的料盘共用一张照片：只有没人引用时才删文件
  removePhotoIfUnused(db, spool.photo);
  removePhotoIfUnused(db, spool.productPhoto);
  return true;
}

/** 合并"同品牌+同材质+同色+同名"的重复料盘：数量/余量相加，保留一份照片与商品图。 */
export function mergeDuplicateSpools() {
  const db = readDb();
  const keyOf = (s) =>
    [s.brand || '', s.type || '', String(s.colorHex || '').toUpperCase(), String(s.name || '').trim().toLowerCase()].join('|');
  const groups = new Map();
  for (const s of db.spools) {
    const k = keyOf(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const removed = [];
  let mergedGroups = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list[0];
    for (const s of list.slice(1)) {
      keep.count = Math.min(99, (keep.count || 1) + (s.count || 1));
      keep.totalGrams = round1((keep.totalGrams || 0) + (s.totalGrams || 0));
      keep.remainingGrams = round1((keep.remainingGrams || 0) + (s.remainingGrams || 0));
      keep.spoolWeightG = keep.spoolWeightG || s.spoolWeightG || 1000;
      if (!keep.photo && s.photo) keep.photo = s.photo;
      if (!keep.productPhoto && s.productPhoto) {
        keep.productPhoto = s.productPhoto;
        keep.productPhotoSource = s.productPhotoSource || '';
      }
      keep.note = [keep.note, s.note].filter(Boolean).join(' · ').slice(0, 300);
      keep.opened = keep.remainingGrams < keep.totalGrams - 0.5;
      keep.updatedAt = now();
      removed.push(s);
    }
    mergedGroups += 1;
  }
  if (removed.length) {
    const ids = new Set(removed.map((s) => s.id));
    db.spools = db.spools.filter((s) => !ids.has(s.id));
    writeDb(db);
    for (const s of removed) {
      removePhotoIfUnused(db, s.photo);
      removePhotoIfUnused(db, s.productPhoto);
    }
  }
  return { mergedGroups, removed: removed.length, spools: db.spools };
}

export function consumeSpool(id, grams) {
  const db = readDb();
  const spool = db.spools.find((s) => s.id === id);
  if (!spool) return null;
  const g = Math.max(0, Number(grams) || 0);
  spool.remainingGrams = Math.max(0, Math.round((spool.remainingGrams - g) * 10) / 10);
  spool.opened = spool.remainingGrams < spool.totalGrams - 0.5;
  spool.updatedAt = now();
  writeDb(db);
  return spool;
}

/**
 * 批量创建材料（图片识别导入用）：所有材料共用同一张照片。
 * @param {Array<object>} items 形如 {name, brand, type, colorHex, colorName, totalGrams, remainingGrams, note}
 * @param {{photoDataUrl?: string}} [opts]
 */
export function bulkCreateSpools(items, { photoDataUrl = '' } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, 30);
  if (!list.length) throw badRequest('没有可导入的材料');
  const db = readDb();
  let sharedPhoto = '';
  if (photoDataUrl) sharedPhoto = savePhotoDataUrl(`batch_${Date.now()}`, photoDataUrl);

  const created = [];
  for (const input of list) {
    const spool = pickSpoolFields(input, {
      id: newId('s'),
      name: '',
      brand: '',
      type: 'PLA',
      colorHex: '#808080',
      colorName: '灰色',
      totalGrams: 1000,
      remainingGrams: 1000,
      count: 1,
      spoolWeightG: 1000,
      photo: '',
      productPhoto: '',
      productPhotoSource: '',
      note: '',
      opened: false,
      createdAt: now(),
      updatedAt: now(),
    });
    if (!spool.name) spool.name = `${spool.colorName} ${spool.type}`.trim();
    if (input.count !== undefined && input.totalGrams === undefined) {
      spool.totalGrams = round1(spool.spoolWeightG * spool.count);
    }
    if (input.count !== undefined && input.remainingGrams === undefined) {
      spool.remainingGrams = spool.totalGrams;
    }
    if (!spool.photo) spool.photo = sharedPhoto;
    spool.source = 'image-recognition';
    db.spools.push(spool);
    created.push(spool);
  }
  writeDb(db);
  return created;
}

// ---------- 打印记录 ----------

export function listJobs() {
  return readDb().jobs;
}

export function addJob({ title, sourceUrl, items, note = '' }) {
  const db = readDb();
  const seen = new Set();
  const cleanItems = [];
  for (const it of Array.isArray(items) ? items : []) {
    const spool = db.spools.find((s) => s.id === it?.spoolId);
    if (!spool) throw Object.assign(new Error(`材料不存在：${it?.spoolId || '(空)'}`), { status: 404 });
    if (seen.has(spool.id)) {
      throw Object.assign(new Error(`同一盘材料在扣减明细里重复出现：${spool.name}`), { status: 400 });
    }
    seen.add(spool.id);
    const grams = Number(it.grams);
    if (!Number.isFinite(grams) || grams <= 0) {
      throw Object.assign(new Error(`扣减克重无效：${it.grams}`), { status: 400 });
    }
    if (grams > spool.remainingGrams + 0.5) {
      throw Object.assign(
        new Error(`「${spool.name}」剩余 ${spool.remainingGrams} g，不够扣 ${grams} g`),
        { status: 409 },
      );
    }
    cleanItems.push({
      spoolId: spool.id,
      spoolName: spool.name,
      colorHex: spool.colorHex,
      grams: Math.round(grams * 10) / 10,
    });
  }
  if (!cleanItems.length) throw Object.assign(new Error('没有可扣减的材料'), { status: 400 });
  const job = {
    id: newId('j'),
    title: String(title || '未命名打印').trim(),
    sourceUrl: String(sourceUrl || ''),
    items: cleanItems,
    totalGrams: Math.round(cleanItems.reduce((s, it) => s + it.grams, 0) * 10) / 10,
    note: String(note),
    createdAt: now(),
  };
  // 先扣减再保存，避免出现"记录成功但没扣"的半状态
  for (const it of cleanItems) {
    const spool = db.spools.find((s) => s.id === it.spoolId);
    if (spool) {
      spool.remainingGrams = Math.max(0, Math.round((spool.remainingGrams - it.grams) * 10) / 10);
      spool.opened = spool.remainingGrams < spool.totalGrams - 0.5;
      spool.updatedAt = now();
    }
  }
  db.jobs.unshift(job);
  writeDb(db);
  return job;
}

// ---------- 设置 ----------

export function getSettings() {
  const db = readDb();
  return db.settings || {};
}

export function updateSettings(patch = {}) {
  const db = readDb();
  db.settings = { ...(db.settings || {}), ...patch };
  writeDb(db);
  return db.settings;
}

// ---------- 商品图（从网上抓取，与用户实拍 photo 分开存） ----------

export function saveProductImage(id, buffer, ext) {
  if (!['jpg', 'png', 'webp'].includes(ext)) throw new Error(`不支持的图片格式：${ext}`);
  ensureDirs();
  const filename = `product-${id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, filename), buffer);
  return `/data/photos/${filename}`;
}

export function setProductPhoto(id, { photo, sourceUrl = '', query = '' }) {
  const db = readDb();
  const spool = db.spools.find((s) => s.id === id);
  if (!spool) return null;
  const old = spool.productPhoto;
  spool.productPhoto = photo;
  spool.productPhotoSource = sourceUrl;
  spool.productImageQuery = query;
  spool.updatedAt = now();
  writeDb(db);
  if (old && old !== photo) removePhotoIfUnused(db, old);
  return spool;
}

export function clearProductPhoto(id) {
  const db = readDb();
  const spool = db.spools.find((s) => s.id === id);
  if (!spool) return null;
  const old = spool.productPhoto;
  spool.productPhoto = '';
  spool.productPhotoSource = '';
  spool.productImageQuery = '';
  spool.updatedAt = now();
  writeDb(db);
  removePhotoIfUnused(db, old);
  return spool;
}

// ---------- 照片 ----------

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function savePhotoDataUrl(id, dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);
  if (!m) throw new Error('照片格式不支持（需要 jpeg/png/webp 的 data URL）');
  const [, mime, b64] = m;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new Error('照片过大（上限 8 MB）');
  ensureDirs();
  const filename = `${id}-${Date.now()}.${MIME_EXT[mime]}`;
  fs.writeFileSync(path.join(PHOTO_DIR, filename), buf);
  return `/data/photos/${filename}`;
}

export function removePhoto(photoPath) {
  if (!photoPath || !photoPath.startsWith('/data/photos/')) return;
  const file = path.join(PHOTO_DIR, path.basename(photoPath));
  if (file.startsWith(PHOTO_DIR) && fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 忽略 */
    }
  }
}

export const PATHS = { DB_FILE };
