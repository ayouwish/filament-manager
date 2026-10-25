import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-productimg-'));
process.env.FM_DATA_DIR = TMP;
const store = await import('../lib/store.mjs');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('同款多盒：count 与总量计算', () => {
  const one = store.createSpool({ name: 'Lava Red PLA', type: 'PLA', colorHex: '#DE1619', count: 2, spoolWeightG: 1000 });
  assert.equal(one.count, 2);
  assert.equal(one.spoolWeightG, 1000);
  assert.equal(one.totalGrams, 2000);
  assert.equal(one.remainingGrams, 2000);

  const [bulk] = store.bulkCreateSpools([{ name: 'Cotton White PLA', type: 'PLA', colorHex: '#E6DDDB', count: 3, spoolWeightG: 750 }]);
  assert.equal(bulk.count, 3);
  assert.equal(bulk.totalGrams, 2250);
  store.deleteSpool(one.id);
  store.deleteSpool(bulk.id);
});

test('合并重复料盘：数量/余量相加，共享照片不被误删', () => {
  const photoDataUrl = 'data:image/png;base64,' + Buffer.from('fake-photo-bytes').toString('base64');
  const created = store.bulkCreateSpools(
    [
      { name: 'Sapphire Blue PLA', brand: 'Panchroma', type: 'PLA', colorHex: '#005AA2', count: 2, spoolWeightG: 1000 },
      { name: 'Sapphire Blue PLA', brand: 'Panchroma', type: 'PLA', colorHex: '#005AA2', count: 2, spoolWeightG: 1000 },
    ],
    { photoDataUrl },
  );
  assert.equal(created.length, 2);
  const sharedPhoto = created[0].photo;
  assert.equal(created[1].photo, sharedPhoto, '批量入库共用一张照片');
  const photoPath = path.join(store.DATA_DIR, sharedPhoto.replace('/data/', ''));
  assert.ok(fs.existsSync(photoPath));

  const result = store.mergeDuplicateSpools();
  assert.equal(result.mergedGroups, 1);
  assert.equal(result.removed, 1);
  const merged = store.listSpools().find((s) => s.name === 'Sapphire Blue PLA');
  assert.equal(merged.count, 4);
  assert.equal(merged.totalGrams, 4000);
  assert.equal(merged.remainingGrams, 4000);
  assert.ok(fs.existsSync(photoPath), '共享照片在合并后仍应存在');
});

test('商品图落盘 / 替换 / 清除 / 删除料盘时清理', () => {
  const spool = store.createSpool({ name: 'Forest Green PLA', type: 'PLA', colorHex: '#519F61', totalGrams: 1000, remainingGrams: 1000 });
  const photo1 = store.saveProductImage(spool.id, Buffer.from('fake-image-1'), 'jpg');
  const updated = store.setProductPhoto(spool.id, { photo: photo1, sourceUrl: 'https://example.com/a.jpg', query: 'q' });
  assert.equal(updated.productPhoto, photo1);
  assert.equal(updated.productPhotoSource, 'https://example.com/a.jpg');
  assert.ok(fs.existsSync(path.join(store.DATA_DIR, photo1.replace('/data/', ''))));

  const photo2 = store.saveProductImage(spool.id, Buffer.from('fake-image-2'), 'png');
  const updated2 = store.setProductPhoto(spool.id, { photo: photo2, sourceUrl: 'https://example.com/b.png', query: 'q2' });
  assert.equal(updated2.productPhoto, photo2);
  assert.ok(!fs.existsSync(path.join(store.DATA_DIR, photo1.replace('/data/', ''))), '旧商品图应被删除');

  const cleared = store.clearProductPhoto(spool.id);
  assert.equal(cleared.productPhoto, '');
  assert.ok(!fs.existsSync(path.join(store.DATA_DIR, photo2.replace('/data/', ''))));

  const photo3 = store.saveProductImage(spool.id, Buffer.from('fake-image-3'), 'webp');
  store.setProductPhoto(spool.id, { photo: photo3, sourceUrl: '', query: '' });
  store.deleteSpool(spool.id);
  assert.ok(!fs.existsSync(path.join(store.DATA_DIR, photo3.replace('/data/', ''))), '删除料盘应清理商品图');
});
