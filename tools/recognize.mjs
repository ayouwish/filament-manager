#!/usr/bin/env node
// 命令行测试图片识别（不需要启动服务）。
// 用法：
//   VISION_PROVIDER=openai VISION_BASE_URL=http://.../v1 VISION_API_KEY=sk-xxx VISION_MODEL=glm-5.3-flash-g \
//     node tools/recognize.mjs 图片路径
// 也支持本地 Ollama（VISION_PROVIDER=ollama VISION_MODEL=qwen2.5vl:3b）。

import fs from 'node:fs';
import { recognizeFilaments } from '../lib/vision.mjs';

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('用法: node tools/recognize.mjs <图片路径>');
  process.exit(2);
}
const settings = {
  vision: {
    provider: process.env.VISION_PROVIDER || '',
    baseUrl: process.env.VISION_BASE_URL || '',
    model: process.env.VISION_MODEL || '',
    apiKey: process.env.VISION_API_KEY || process.env.NEW_API_KEY || '',
    debug: process.env.VISION_DEBUG === '1',
  },
};
const imageBase64 = fs.readFileSync(imagePath).toString('base64');
const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
const started = Date.now();
const result = await recognizeFilaments({ imageBase64, mime, settings });
if (process.env.OUT_JSON) fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(result, null, 2));
if (process.env.OUT_RAW && result.rawText) fs.writeFileSync(process.env.OUT_RAW, result.rawText);
const printable = { ...result };
delete printable.rawText;
console.log(JSON.stringify(printable, null, 2));
console.error(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
