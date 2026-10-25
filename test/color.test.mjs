import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, rgbToHex, hexToLab, deltaE2000, deltaEHex, colorName } from '../lib/color.mjs';

// 参考数据：Sharma, Wu & Dalal (2005) CIEDE2000 测试集
const SHARMA = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
  [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
  [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
];

test('deltaE2000 与 Sharma 参考数据一致', () => {
  for (const [a, b, expected] of SHARMA) {
    const [L1, a1, b1] = a;
    const [L2, a2, b2] = b;
    const got = deltaE2000(
      { L: L1, a: a1, b: b1 },
      { L: L2, a: a2, b: b2 },
    );
    assert.ok(Math.abs(got - expected) < 1e-3, `ΔE(${a}, ${b}) = ${got}, 期望 ${expected}`);
  }
});

test('hex/rgb/lab 转换', () => {
  assert.deepEqual(hexToRgb('#FF8000'), { r: 255, g: 128, b: 0 });
  assert.deepEqual(hexToRgb('#f80'), { r: 255, g: 136, b: 0 });
  assert.equal(hexToRgb('nope'), null);
  assert.equal(rgbToHex({ r: 255, g: 128, b: 0 }), '#FF8000');
  assert.equal(rgbToHex({ r: 300, g: -5, b: 128.4 }), '#FF0080');
  const white = hexToLab('#FFFFFF');
  assert.ok(Math.abs(white.L - 100) < 1e-3);
  assert.ok(Math.abs(white.a) < 0.01 && Math.abs(white.b) < 0.01);
  const black = hexToLab('#000000');
  assert.ok(Math.abs(black.L) < 1e-6);
});

test('同色/不同色色差', () => {
  assert.ok(deltaEHex('#C62828', '#C62828') < 1e-9);
  assert.ok(deltaEHex('#17181A', '#F2F2EE') > 80);
  assert.ok(deltaEHex('#C62828', '#C62A2A') < 3);
});

test('颜色命名', () => {
  assert.equal(colorName('#17181A').name, '黑色');
  assert.equal(colorName('#F2F2EE').name, '白色');
  assert.equal(colorName('#C62828').name, '红色');
  assert.equal(colorName('#1E5FBF').name, '蓝色');
  assert.ok(['金色', '琥珀', '黄色'].includes(colorName('#E0A030').name));
  assert.equal(colorName('#7F3FBF7F').name, '紫色'); // 8 位 hex 只取前 6 位
});
