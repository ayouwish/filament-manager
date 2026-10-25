// 解析 Bambu Studio / Orca Slicer 的 .3mf 打印配置文件。
// 精确克重来自 Metadata/slice_info.config（每个平台每种耗材的 used_g）；
// 未切片的工程文件退化到 Metadata/project_settings.config（只有颜色/类型，没有克重）。

import { readZip, readZipText } from './zip.mjs';
import { colorName } from './color.mjs';

function parseAttrs(tagText) {
  const out = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tagText))) out[m[1]] = m[2];
  return out;
}

/** 兼容 "#RRGGBB" / "#RRGGBBAA" / "RRGGBB"。 */
export function normalizeHexColor(value, fallback = '#808080') {
  const s = String(value || '').trim();
  const m = s.match(/^#?([0-9a-fA-F]{6})/);
  if (!m) return fallback;
  return `#${m[1].toUpperCase()}`;
}

const toNum = (v, d = 0) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

/** 解析 slice_info.config（XML，切片后才有）。 */
export function parseSliceInfoXml(xml) {
  const plates = [];
  const plateRe = /<plate\b[^>]*>([\s\S]*?)<\/plate>/g;
  let pm;
  while ((pm = plateRe.exec(xml))) {
    const body = pm[1];
    const meta = {};
    const metaRe = /<metadata\b([^>]*?)\/?>/g;
    let mm;
    while ((mm = metaRe.exec(body))) {
      const a = parseAttrs(mm[1]);
      if (a.key) meta[a.key] = a.value ?? '';
    }
    const filaments = [];
    const filRe = /<filament\b([^>]*?)\/?>/g;
    let fm;
    while ((fm = filRe.exec(body))) {
      const a = parseAttrs(fm[1]);
      if (!a.id) continue;
      filaments.push({
        slot: Number.parseInt(a.id, 10) || filaments.length + 1,
        type: (a.type || '').trim(),
        colorHex: normalizeHexColor(a.color),
        grams: toNum(a.used_g, 0),
        meters: toNum(a.used_m, 0),
        trayInfoIdx: a.tray_info_idx || '',
      });
    }
    filaments.sort((x, y) => x.slot - y.slot);
    plates.push({
      index: Number.parseInt(meta.index, 10) || plates.length + 1,
      predictionSeconds: meta.prediction ? toNum(meta.prediction) : null,
      totalGrams: meta.weight ? toNum(meta.weight) : null,
      filaments,
      estimated: false,
    });
  }
  return plates;
}

/** 解析 project_settings.config（JSON，切片前后都有）。 */
export function parseProjectSettings(jsonText) {
  const project = {
    printerModel: '',
    nozzle: '',
    filaments: [],
    density: {},
    raw: null,
  };
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return project;
  }
  project.raw = raw;
  project.printerModel = raw.printer_model || '';
  project.nozzle = raw.printer_variant || '';
  const types = Array.isArray(raw.filament_type) ? raw.filament_type : [];
  const colors = Array.isArray(raw.filament_colour) ? raw.filament_colour : [];
  const ids = Array.isArray(raw.filament_ids) ? raw.filament_ids : [];
  const settingsIds = Array.isArray(raw.filament_settings_id) ? raw.filament_settings_id : [];
  const densities = Array.isArray(raw.filament_density) ? raw.filament_density : [];
  const count = Math.max(types.length, colors.length);
  for (let i = 0; i < count; i++) {
    project.filaments.push({
      slot: i + 1,
      type: String(types[i] || '').trim(),
      colorHex: normalizeHexColor(colors[i]),
      trayInfoIdx: String(ids[i] || ''),
      settingsId: String(settingsIds[i] || ''),
      density: toNum(densities[i], 1.24) || 1.24,
    });
  }
  return project;
}

export function modelTitleFromFilename(filename = '') {
  return String(filename)
    .replace(/\.(gcode\.)?3mf$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/**
 * 解析 .3mf 为统一的模型需求结构。
 * @param {Buffer} buffer
 * @param {{filename?: string}} [opts]
 */
export function parse3mf(buffer, opts = {}) {
  const filename = opts.filename || 'model.3mf';
  let entries;
  try {
    entries = readZip(buffer, {
      filter: (name) => /^metadata\/(slice_info\.config|project_settings\.config)$/i.test(name.replace(/\\/g, '/')),
    });
  } catch (err) {
    throw new Error(`无法读取 3mf：${err.message}`);
  }

  const sliceText = readZipText(entries, 'Metadata/slice_info.config');
  const settingsText = readZipText(entries, 'Metadata/project_settings.config');
  const project = settingsText ? parseProjectSettings(settingsText) : parseProjectSettings('{}');

  const warnings = [];
  let plates = [];
  let sliced = false;

  if (sliceText && sliceText.trim().startsWith('<')) {
    plates = parseSliceInfoXml(sliceText).filter((p) => p.filaments.length > 0);
    sliced = plates.length > 0;
  }
  if (!sliced && sliceText) {
    warnings.push('slice_info.config 存在但未解析出耗材信息，已退化到工程设置。');
  }
  if (settingsText && !project.raw) {
    warnings.push('project_settings.config 不是合法 JSON，无法读取颜色/材料类型。');
  }

  if (!sliced) {
    const filaments = project.filaments.map((f) => ({
      slot: f.slot,
      type: f.type,
      colorHex: f.colorHex,
      grams: null,
      meters: null,
      trayInfoIdx: f.trayInfoIdx,
    }));
    if (filaments.length > 0) {
      plates = [{ index: 1, predictionSeconds: null, totalGrams: null, filaments, estimated: true }];
      warnings.push('该 3mf 未切片（没有切片数据），无法得到克重；匹配只按颜色和材料类型，扣减前请确认用量。');
    } else {
      warnings.push('3mf 里没有找到任何耗材信息（slice_info.config / project_settings.config 均缺失）。');
    }
  }

  for (const plate of plates) {
    for (const f of plate.filaments) {
      f.colorName = colorName(f.colorHex).name;
      f.display = `${f.colorName}${f.type ? ' / ' + f.type : ''}`;
    }
    plate.totalGrams =
      plate.totalGrams ??
      (plate.filaments.every((f) => Number.isFinite(f.grams))
        ? plate.filaments.reduce((s, f) => s + f.grams, 0)
        : null);
  }

  return {
    title: opts.title || modelTitleFromFilename(filename),
    filename,
    sliced,
    plates,
    project,
    warnings,
  };
}

/** 把多个平台的需求按「材料类型 + 颜色」合并（用于整单选料）。 */
export function mergePlateRequirements(plates, { plateIndexes } = {}) {
  const want = plateIndexes ? new Set(plateIndexes) : null;
  const map = new Map();
  for (const plate of plates) {
    if (want && !want.has(plate.index)) continue;
    for (const f of plate.filaments) {
      const key = `${f.type.toUpperCase()}|${f.colorHex.toUpperCase()}`;
      const cur = map.get(key) || {
        type: f.type,
        colorHex: f.colorHex,
        grams: 0,
        gramsKnown: true,
        colorName: f.colorName,
        trayInfoIdx: f.trayInfoIdx,
        plates: [],
      };
      if (!Number.isFinite(f.grams)) cur.gramsKnown = false;
      else cur.grams += f.grams;
      if (!cur.plates.includes(plate.index)) cur.plates.push(plate.index);
      map.set(key, cur);
    }
  }
  return [...map.values()]
    .sort((a, b) => (b.grams || 0) - (a.grams || 0))
    .map((r, i) => ({
      index: i + 1,
      type: r.type,
      colorHex: r.colorHex,
      grams: r.gramsKnown ? Math.round(r.grams * 10) / 10 : null,
      colorName: r.colorName,
      trayInfoIdx: r.trayInfoIdx,
      plates: r.plates,
      display: `${r.colorName}${r.type ? ' / ' + r.type : ''}`,
    }));
}
