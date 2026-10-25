// 极简 ZIP 读取器：只依赖 node:zlib，用于解析 .3mf（本质是 zip）。
// 支持 stored(0) 与 deflate(8)；不支持 ZIP64 / 加密。

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readName(buf, offset, length) {
  return buf.toString('utf8', offset, offset + length);
}

/**
 * 读取 zip 为 Map<文件名, Buffer>。
 * @param {Buffer|Uint8Array} input
 * @param {{filter?: (name: string) => boolean}} [options] filter 可跳过不关心的条目（如 gcode）
 * @returns {Map<string, Buffer>}
 */
export function readZip(input, { filter = null } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip/3mf 文件（找不到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  if (count > 5000) throw new Error('zip 条目过多，拒绝解析（可能是恶意文件）');
  const cenOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cenOffset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('zip 中央目录损坏');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = readName(buf, p + 46, nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (filter && !filter(name)) continue;

    if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`zip 本地文件头损坏: ${name}`);
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (compSize > 128 * 1024 * 1024) throw new Error(`zip 条目过大: ${name}`);
    if (uncompSize > 256 * 1024 * 1024) throw new Error(`zip 解压后过大: ${name}`);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持 zip 压缩方式 ${method}: ${name}`);

    if (uncompSize && data.length !== uncompSize) {
      throw new Error(`zip 条目解压大小不一致: ${name}`);
    }
    entries.set(name.replace(/\\/g, '/'), data);
  }
  return entries;
}

/** 从 zip 中按文件名读取文本（容忍大小写差异）。 */
export function readZipText(entries, path) {
  const want = path.toLowerCase();
  for (const [name, data] of entries) {
    if (name.toLowerCase() === want) return data.toString('utf8');
  }
  return null;
}
