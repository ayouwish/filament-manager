// 颜色工具：sRGB ↔ CIELAB(D65)、CIEDE2000 色差、常见耗材颜色命名。
// 零依赖，浏览器/Node 通用（纯 ESM）。

const D65 = { x: 0.95047, y: 1.0, z: 1.08883 };

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6); // #RRGGBBAA：忽略 alpha
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function srgbToLinear(v) {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function rgbToLab(rgb) {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  // sRGB -> XYZ (D65)
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const fx = labF(x / D65.x);
  const fy = labF(y / D65.y);
  const fz = labF(z / D65.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function labF(t) {
  const d = 6 / 29;
  return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
}

export function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToLab(rgb) : null;
}

/** CIEDE2000 色差（kL=kC=kH=1）。返回 0~100 量级，越小越接近。 */
export function deltaE2000(lab1, lab2) {
  if (!lab1 || !lab2) return Infinity;
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const rad = Math.PI / 180;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) / rad + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);

  const Lbar = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbar - 50, 2)) / Math.sqrt(20 + Math.pow(Lbar - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  const tL = dLp / SL;
  const tC = dCp / SC;
  const tH = dHp / SH;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

export function deltaEHex(hex1, hex2) {
  return deltaE2000(hexToLab(hex1), hexToLab(hex2));
}

/** 常见耗材颜色名（中文），用 ΔE 最近邻命名。 */
export const NAMED_COLORS = [
  { name: '黑色', hex: '#17181A' },
  { name: '炭灰', hex: '#2B2E33' },
  { name: '灰色', hex: '#8A8F98' },
  { name: '银灰', hex: '#B9BEC6' },
  { name: '白色', hex: '#F2F2EE' },
  { name: '米白', hex: '#EFE8D8' },
  { name: '红色', hex: '#C62828' },
  { name: '酒红', hex: '#7B1F2B' },
  { name: '橙色', hex: '#E8622A' },
  { name: '琥珀', hex: '#E0A030' },
  { name: '黄色', hex: '#F2C200' },
  { name: '柠檬黄', hex: '#E8E337' },
  { name: '草绿', hex: '#6FA83C' },
  { name: '墨绿', hex: '#1F5C3A' },
  { name: '青色', hex: '#2AA7A0' },
  { name: '天蓝', hex: '#4FA3D8' },
  { name: '蓝色', hex: '#1E5FBF' },
  { name: '藏青', hex: '#1B2A5B' },
  { name: '紫色', hex: '#7B4FA3' },
  { name: '粉色', hex: '#E893A8' },
  { name: '玫红', hex: '#D4376B' },
  { name: '棕色', hex: '#6B4A32' },
  { name: '咖啡', hex: '#4A3428' },
  { name: '金色', hex: '#C9A227' },
  { name: '铜色', hex: '#B87333' },
  { name: '透明', hex: '#E9E9E2' },
];

export function colorName(hex, { maxDeltaE = 18 } = {}) {
  const lab = hexToLab(hex);
  if (!lab) return { name: '未知', hex: '#000000', deltaE: Infinity };
  let best = null;
  for (const c of NAMED_COLORS) {
    const d = deltaE2000(lab, hexToLab(c.hex));
    if (!best || d < best.deltaE) best = { ...c, deltaE: d };
  }
  if (best.deltaE > maxDeltaE) return { name: '自定义', hex, deltaE: best.deltaE };
  return best;
}

/** 判断两个颜色是否属于"同一视觉色系"（供匹配算法使用）。 */
export function sameColorFamily(hex1, hex2, threshold = 12) {
  return deltaEHex(hex1, hex2) <= threshold;
}
