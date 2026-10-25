import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readZip, readZipText } from '../lib/zip.mjs';
import {
  parse3mf,
  parseSliceInfoXml,
  parseProjectSettings,
  mergePlateRequirements,
  normalizeHexColor,
  modelTitleFromFilename,
} from '../lib/threemf.mjs';

const sliced = fs.readFileSync(fileURLToPath(new URL('./fixtures/sliced.3mf', import.meta.url)));
const unsliced = fs.readFileSync(fileURLToPath(new URL('./fixtures/unsliced.3mf', import.meta.url)));

test('zip 读取 3mf', () => {
  const entries = readZip(sliced);
  assert.ok(entries.has('Metadata/slice_info.config'));
  assert.ok(entries.has('Metadata/project_settings.config'));
  assert.ok(readZipText(entries, 'metadata/slice_info.config').includes('<plate>'));
  assert.throws(() => readZip(Buffer.from('not a zip')), /zip|EOCD/);
});

test('解析已切片 3mf：精确克重与多平台', () => {
  const model = parse3mf(sliced, { filename: '多色小夜灯.3mf' });
  assert.equal(model.sliced, true);
  assert.equal(model.title, '多色小夜灯');
  assert.equal(model.plates.length, 2);
  const p1 = model.plates[0];
  assert.equal(p1.index, 1);
  assert.equal(p1.predictionSeconds, 4823);
  assert.equal(p1.filaments.length, 2);
  assert.equal(p1.filaments[0].type, 'PLA');
  assert.equal(p1.filaments[0].colorHex, '#17181A');
  assert.equal(p1.filaments[0].grams, 120.4);
  assert.equal(p1.filaments[1].colorHex, '#F2F2EE'); // 8 位 hex 归一化
  assert.equal(p1.totalGrams, 165.6);
  assert.deepEqual(model.warnings, []);
});

test('合并平台需求', () => {
  const model = parse3mf(sliced);
  const merged = mergePlateRequirements(model.plates);
  assert.equal(merged.length, 3);
  const black = merged.find((r) => r.colorHex === '#17181A');
  assert.equal(black.grams, 120.4);
  assert.equal(black.colorName, '黑色');
  const plate2 = mergePlateRequirements(model.plates, { plateIndexes: [2] });
  assert.equal(plate2.length, 1);
  assert.equal(plate2[0].colorHex, '#E0A030');
  assert.equal(plate2[0].grams, 60.3);
});

test('未切片 3mf 退化：无克重 + 警告', () => {
  const model = parse3mf(unsliced, { filename: 'project.3mf' });
  assert.equal(model.sliced, false);
  assert.equal(model.plates.length, 1);
  assert.equal(model.plates[0].estimated, true);
  assert.equal(model.plates[0].filaments[0].grams, null);
  assert.ok(model.warnings.some((w) => w.includes('未切片')));
  const merged = mergePlateRequirements(model.plates);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].grams, null);
});

test('解析切片 XML 的容错性', () => {
  const xml = `<config><plate><metadata key="index" value="3"/>
    <filament id="2" type="PETG" color="#ff0000ff" used_m="1.2" used_g="3.5"/>
  </plate></config>`;
  const plates = parseSliceInfoXml(xml);
  assert.equal(plates.length, 1);
  assert.equal(plates[0].index, 3);
  assert.equal(plates[0].filaments[0].colorHex, '#FF0000');
  assert.equal(plates[0].filaments[0].grams, 3.5);
});

test('工程设置与标题工具函数', () => {
  const project = parseProjectSettings(
    JSON.stringify({ printer_model: 'Bambu Lab A1', filament_type: ['PLA', 'PETG'], filament_colour: ['#000000', '#FFFFFF'] }),
  );
  assert.equal(project.printerModel, 'Bambu Lab A1');
  assert.equal(project.filaments[0].type, 'PLA');
  assert.equal(project.filaments[1].colorHex, '#FFFFFF');
  assert.equal(normalizeHexColor('#abcDEF'), '#ABCDEF');
  assert.equal(normalizeHexColor(''), '#808080');
  assert.equal(modelTitleFromFilename('my-model_v2.gcode.3mf'), 'my model v2');
});
