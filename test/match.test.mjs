import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRequirements, evaluateCandidate, typesCompatible, typeFamily } from '../lib/match.mjs';

const spool = (id, opts = {}) => ({
  id,
  name: opts.name || id,
  type: opts.type || 'PLA',
  colorHex: opts.colorHex || '#17181A',
  totalGrams: opts.totalGrams ?? 1000,
  remainingGrams: opts.remainingGrams ?? 1000,
});

const req = (opts = {}) => ({
  index: opts.index ?? 1,
  type: opts.type || 'PLA',
  colorHex: opts.colorHex || '#17181A',
  grams: 'grams' in opts ? opts.grams : 100,
});

test('材料类型家族判定', () => {
  assert.equal(typeFamily('PLA+'), 'PLA');
  assert.equal(typeFamily('pla-cf'), 'PLA');
  assert.equal(typeFamily('PETG-CF'), 'PETG');
  assert.equal(typeFamily('TPE'), 'TPU');
  assert.ok(typesCompatible('PLA', 'PLA+'));
  assert.ok(!typesCompatible('PLA', 'PETG'));
  assert.ok(typesCompatible('', 'PETG'));
});

test('精确匹配：颜色/类型都对', () => {
  const spools = [spool('a', { colorHex: '#17181A', remainingGrams: 900 })];
  const { assignments, summary } = matchRequirements([req({ grams: 120 })], spools);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].status, 'ok');
  assert.equal(assignments[0].spool.id, 'a');
  assert.ok(assignments[0].deltaE < 0.5);
  assert.equal(summary.okCount, 1);
});

test('同色多盘时优先选"刚好够用"的料盘', () => {
  const spools = [
    spool('big', { remainingGrams: 950 }),
    spool('fit', { remainingGrams: 320 }),
    spool('small', { remainingGrams: 150 }),
  ];
  const { assignments } = matchRequirements([req({ grams: 300 })], spools);
  assert.equal(assignments[0].spool.id, 'fit');
});

test('单盘不够时给出同色拼盘方案', () => {
  const spools = [
    spool('w1', { colorHex: '#F2F2EE', remainingGrams: 300 }),
    spool('w2', { colorHex: '#F2F2EE', remainingGrams: 400 }),
  ];
  const { assignments } = matchRequirements([req({ colorHex: '#F2F2EE', grams: 600 })], spools);
  const a = assignments[0];
  assert.equal(a.status, 'combine');
  assert.equal(a.parts.length, 2);
  const total = a.parts.reduce((s, p) => s + p.grams, 0);
  assert.ok(total >= 600 * 0.98);
  assert.deepEqual(new Set(a.parts.map((p) => p.spool.id)), new Set(['w1', 'w2']));
});

test('严格覆盖：588 g 料盘不能顶 600 g 需求', () => {
  const spools = [spool('w', { colorHex: '#F2F2EE', remainingGrams: 588 })];
  const { assignments } = matchRequirements([req({ colorHex: '#F2F2EE', grams: 600 })], spools);
  assert.equal(assignments[0].status, 'insufficient');
  assert.equal(assignments[0].shortfallGrams, 12);
});

test('颜色差异大的建议项不占用库存（后续需求仍可匹配）', () => {
  const spools = [
    spool('blue', { type: 'PETG', colorHex: '#1E5FBF', remainingGrams: 700 }),
    spool('white', { type: 'PETG', colorHex: '#F2F2EE', remainingGrams: 200 }),
  ];
  const reqs = [
    req({ index: 1, type: 'PETG', colorHex: '#E0A030', grams: 60 }), // 琥珀：只有蓝色可选 → color_far
    req({ index: 2, type: 'PETG', colorHex: '#1E5FBF', grams: 700 }), // 蓝色：应能用满 700 g
  ];
  const { assignments } = matchRequirements(reqs, spools);
  assert.equal(assignments[0].status, 'color_far');
  assert.equal(assignments[1].status, 'ok');
  assert.equal(assignments[1].spool.id, 'blue');
});

test('余量不足且无法拼盘时报告缺口', () => {
  const spools = [spool('w', { colorHex: '#F2F2EE', remainingGrams: 200 })];
  const { assignments, summary } = matchRequirements([req({ colorHex: '#F2F2EE', grams: 600 })], spools);
  assert.equal(assignments[0].status, 'insufficient');
  assert.equal(assignments[0].shortfallGrams, 400);
  assert.equal(summary.problemCount, 1);
});

test('没有同类型耗材时不自动选料', () => {
  const spools = [spool('petg', { type: 'PETG', colorHex: '#17181A', remainingGrams: 800 })];
  const { assignments } = matchRequirements([req({ type: 'PLA', grams: 100 })], spools);
  assert.equal(assignments[0].status, 'no_type');
  assert.equal(assignments[0].spool, null);
});

test('允许类型不符时给 type_mismatch 并附建议', () => {
  const spools = [spool('petg', { type: 'PETG', colorHex: '#17181A', remainingGrams: 800 })];
  const { assignments } = matchRequirements([req({ type: 'PLA', grams: 100 })], spools, { allowTypeMismatch: true });
  assert.equal(assignments[0].status, 'type_mismatch');
  assert.equal(assignments[0].spool.id, 'petg');
});

test('颜色差异过大时只给建议不默认通过', () => {
  const spools = [spool('gold', { colorHex: '#E0A030', remainingGrams: 800 })];
  const { assignments } = matchRequirements([req({ colorHex: '#17181A', grams: 100 })], spools);
  assert.equal(assignments[0].status, 'color_far');
  assert.ok(assignments[0].deltaE > 14);
  assert.equal(assignments[0].spool.id, 'gold');
});

test('相近颜色标记为 color_near', () => {
  const spools = [spool('near', { colorHex: '#3A3D42', remainingGrams: 800 })];
  const { assignments } = matchRequirements([req({ colorHex: '#17181A', grams: 100 })], spools);
  assert.equal(assignments[0].status, 'color_near');
});

test('多需求共享库存会预留余量，不重复占用同一盘', () => {
  const spools = [spool('w1', { colorHex: '#F2F2EE', remainingGrams: 350 }), spool('w2', { colorHex: '#F2F2EE', remainingGrams: 280 })];
  const reqs = [
    req({ index: 1, colorHex: '#F2F2EE', grams: 300 }),
    req({ index: 2, colorHex: '#F2F2EE', grams: 300 }),
  ];
  const { assignments } = matchRequirements(reqs, spools);
  assert.notEqual(assignments[0].spool.id, assignments[1].spool.id);
  const statuses = assignments.map((a) => a.status).sort();
  assert.deepEqual(statuses, ['combine', 'ok']);
});

test('克重未知时只按颜色/类型匹配', () => {
  const spools = [spool('a', { colorHex: '#17181A', remainingGrams: 50 })];
  const { assignments, summary } = matchRequirements([req({ grams: null })], spools);
  assert.equal(assignments[0].status, 'ok');
  assert.equal(assignments[0].spool.id, 'a');
  assert.equal(summary.gramsKnown, false);
});

test('空库存返回 no_stock', () => {
  const { assignments } = matchRequirements([req()], []);
  assert.equal(assignments[0].status, 'no_stock');
});

test('evaluateCandidate 的评分/可达性', () => {
  const a = evaluateCandidate(req({ grams: 100 }), spool('x', { remainingGrams: 500 }), new Map());
  assert.ok(a.coverage);
  assert.ok(a.typeOk);
  const reserved = new Map([['x', 450]]);
  const b = evaluateCandidate(req({ grams: 100 }), spool('x', { remainingGrams: 500 }), reserved);
  assert.equal(b.available, 50);
  assert.equal(b.coverage, false);
});
