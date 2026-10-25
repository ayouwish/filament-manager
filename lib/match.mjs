// 材料匹配算法：把 MakerWorld / 3mf 解析出的「需求」（材料类型 + 颜色 + 克重）
// 与本地库存（料盘）做一对一/多盘拼接匹配。
//
// 设计目标：
// 1. 颜色优先：CIEDE2000 色差在阈值内才算「同色」，否则不自动选中，只给建议。
// 2. 类型硬约束：PLA 需求默认不会自动选 PETG（可通过 allowTypeMismatch 放开）。
// 3. 余量感知：按「本次打印已预留」后的可用余量计算，支持同色多盘拼接。
// 4. 先清仓：优先使用已开封 / 剩余较少的料盘，避免浪费。

import { deltaE2000, hexToLab } from './color.mjs';

export const DEFAULT_MATCH_OPTIONS = {
  /** ΔE ≤ goodDeltaE 视为视觉同色（调研：2~5 可互换） */
  goodDeltaE: 5,
  /** ΔE ≤ maxDeltaE 视为可接受（相近）颜色；>10 通常肉眼可辨 */
  maxDeltaE: 12,
  /** 低于该余量不再参与匹配 */
  minRemainingGrams: 2,
  /** 是否允许材料类型不符（例如用 PETG 顶 PLA） */
  allowTypeMismatch: false,
  /** 是否允许同色多盘拼接 */
  allowCombine: true,
  /** 拼接时最多用几盘 */
  maxCombineParts: 3,
  /** 优先消耗已开封/剩余少的料盘 */
  preferOpened: true,
};

export function normalizeType(type) {
  return String(type || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** PLA+ / PLA-CF / PLA Silk 都归到 PLA 家族，用于判断能否互换。 */
export function typeFamily(type) {
  const t = normalizeType(type);
  if (!t) return '';
  const m = t.match(/^(PETG|PLA|ABS|ASA|TPU|TPE|PA|PC|PVA|HIPS|PET|PP|NYLON)/);
  if (m) return m[1] === 'TPE' ? 'TPU' : m[1] === 'PET' ? 'PETG' : m[1];
  return t;
}

export function typesCompatible(reqType, spoolType) {
  if (!reqType || !spoolType) return true;
  return typeFamily(reqType) === typeFamily(spoolType);
}

const round1 = (n) => Math.round(n * 10) / 10;

function availableOf(spool, reserved) {
  const base = Number(spool.remainingGrams ?? spool.grams ?? 0);
  return Math.max(0, base - (reserved.get(spool.id) || 0));
}

/**
 * 评估候选料盘针对单个需求的匹配度（纯函数，便于测试）。
 * @returns {{spool, deltaE, typeOk, available, coverage, score}}
 */
export function evaluateCandidate(requirement, spool, reserved = new Map(), options = {}) {
  const opts = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const reqLab = hexToLab(requirement.colorHex);
  const spoolLab = hexToLab(spool.colorHex);
  const deltaE = deltaE2000(reqLab, spoolLab);
  const typeOk = typesCompatible(requirement.type, spool.type);
  const available = availableOf(spool, reserved);
  const needed = Number(requirement.grams);
  const gramsKnown = Number.isFinite(needed) && needed > 0;
  // 严格覆盖：只有可用量 ≥ 需求量（0.5g 容差）才算够；不允许"588g 顶 600g"的静默缺口
  const coverage = !gramsKnown || available >= needed - 0.5;

  let score = deltaE * 5;
  if (!typeOk) score += opts.allowTypeMismatch ? 30 : 10000;
  if (!coverage) score += 60 + (needed ? ((needed - available) / needed) * 40 : 0);
  if (coverage && gramsKnown) {
    // 余量刚好够用的料盘优先（少留零头）；最多加 3 分，避免压过颜色项
    score += Math.min(3, (available - needed) / Math.max(needed, 1) * 3);
  }
  if (opts.preferOpened && isOpened(spool)) score -= 2;

  return { spool, deltaE, typeOk, available, coverage, gramsKnown, score };
}

export function isOpened(spool) {
  const total = Number(spool.totalGrams ?? 0);
  const remaining = Number(spool.remainingGrams ?? total);
  return Boolean(spool.opened) || (total > 0 && remaining < total - 0.5);
}

/**
 * 主匹配函数。
 * @param {Array<{type:string,colorHex:string,grams:number|null,display?:string}>} requirements
 * @param {Array<object>} spools
 * @param {object} [options]
 */
export function matchRequirements(requirements, spools, options = {}) {
  const opts = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const reserved = new Map();
  const assignments = [];

  const reqs = requirements.map((r, i) => ({ ...r, index: r.index ?? i + 1 }));
  // 克重大的先分配，避免小件先占掉大料盘
  const ordered = [...reqs].sort((a, b) => (Number(b.grams) || 0) - (Number(a.grams) || 0));

  for (const req of ordered) {
    const candidates = spools
      .filter((s) => availableOf(s, reserved) > 0)
      .map((s) => evaluateCandidate(req, s, reserved, opts))
      .sort((a, b) => a.score - b.score);

    // 允许跨类型时，类型不符的料盘也进入候选池（评分里已加惩罚），最终标记为 type_mismatch
    const compatible = opts.allowTypeMismatch ? candidates : candidates.filter((c) => c.typeOk);
    const colorOk = compatible.filter(
      (c) => c.deltaE <= (opts.allowTypeMismatch ? Math.min(opts.maxDeltaE, opts.goodDeltaE) : opts.maxDeltaE) &&
        c.available >= opts.minRemainingGrams,
    );
    const picked = (colorOk.length ? colorOk : compatible)[0] || null;

    if (!picked) {
      assignments.push({
        requirement: req,
        status: candidates.length ? 'no_type' : 'no_stock',
        spool: null,
        deltaE: null,
        alternatives: candidates.slice(0, 3),
        parts: [],
        shortfallGrams: Number(req.grams) || 0,
        message: candidates.length
          ? `没有与 ${req.type || '该材料'} 类型相符的料盘`
          : '库存为空，请先添加耗材',
      });
      continue;
    }

    const alternatives = compatible.filter((c) => c !== picked).slice(0, 3);
    let status = 'ok';
    let message = '';

    if (!picked.typeOk) {
      status = 'type_mismatch';
      message = `材料类型不符：需要 ${req.type}，现有 ${picked.spool.type}`;
    } else if (picked.deltaE > opts.maxDeltaE) {
      status = 'color_far';
      message = `没有足够接近 ${req.colorHex} 的颜色（最接近 ΔE=${round1(picked.deltaE)}）`;
    } else if (picked.deltaE > opts.goodDeltaE) {
      status = 'color_near';
      message = `颜色相近但不完全一致（ΔE=${round1(picked.deltaE)}）`;
    }

    let parts = [];
    let shortfallGrams = 0;
    if (!picked.coverage) {
      const combined = opts.allowCombine ? combineSpools(req, picked, compatible, availableOf, reserved, opts) : null;
      if (combined) {
        parts = combined.parts;
        status = 'combine';
        message = `单盘不够，需拼接 ${parts.length} 盘同色耗材`;
      } else {
        status = 'insufficient';
        shortfallGrams = round1(Math.max(0, (Number(req.grams) || 0) - picked.available));
        message = `库存不足：还差约 ${shortfallGrams} g`;
      }
    }

    const totalNeeded = Number(req.grams);
    // 只有真正可用的方案才预留库存；颜色差异过大的建议方案不占用后续匹配
    const usable = parts.length > 0 || status === 'ok' || status === 'color_near' || status === 'type_mismatch';
    if (usable) {
      if (parts.length) {
        for (const p of parts) reserved.set(p.spool.id, (reserved.get(p.spool.id) || 0) + p.grams);
      } else if (Number.isFinite(totalNeeded) && totalNeeded > 0) {
        reserved.set(picked.spool.id, (reserved.get(picked.spool.id) || 0) + totalNeeded);
      }
    }

    assignments.push({
      requirement: req,
      status,
      spool: picked.spool,
      deltaE: round1(picked.deltaE),
      alternatives: alternatives.map((c) => ({ ...c, deltaE: round1(c.deltaE) })),
      parts: parts.map((p) => ({ ...p, spool: p.spool })),
      shortfallGrams,
      message,
    });
  }

  // 按需求原始顺序返回
  assignments.sort((a, b) => a.requirement.index - b.requirement.index);

  const knownReqs = reqs.filter((r) => Number.isFinite(Number(r.grams)) && Number(r.grams) > 0);
  return {
    assignments,
    summary: {
      requirementCount: reqs.length,
      totalGrams: round1(knownReqs.reduce((s, r) => s + Number(r.grams), 0)),
      gramsKnown: knownReqs.length === reqs.length,
      okCount: assignments.filter((a) => ['ok', 'color_near', 'combine'].includes(a.status)).length,
      warnCount: assignments.filter((a) => ['color_near', 'combine', 'color_far'].includes(a.status)).length,
      problemCount: assignments.filter((a) => ['no_type', 'no_stock', 'insufficient', 'type_mismatch', 'color_far'].includes(a.status)).length,
      spoolsUsed: new Set(assignments.flatMap((a) => (a.parts.length ? a.parts.map((p) => p.spool.id) : a.spool ? [a.spool.id] : []))).size,
    },
  };
}

function combineSpools(req, primary, compatible, availableOf, reserved, opts) {
  const needed = Number(req.grams);
  if (!Number.isFinite(needed) || needed <= 0) return null;
  const picked = [{ spool: primary.spool, grams: primary.available }];
  let sum = primary.available;
  const pool = compatible
    .filter((c) => c !== primary && c.spool.id !== primary.spool.id)
    .filter((c) => c.deltaE <= opts.maxDeltaE && c.available >= opts.minRemainingGrams)
    // 拼盘必须同材料类型，不能借 allowTypeMismatch 混入异类型
    .filter((c) => !req.type || !c.spool.type || typesCompatible(req.type, c.spool.type))
    .sort((a, b) => a.deltaE - b.deltaE || b.available - a.available);
  for (const c of pool) {
    if (picked.length >= opts.maxCombineParts) break;
    const take = Math.min(c.available, needed - sum);
    picked.push({ spool: c.spool, grams: take });
    sum += take;
    if (sum >= needed - 0.5) break;
  }
  if (sum < needed - 0.5) return null;
  return { parts: picked };
}
