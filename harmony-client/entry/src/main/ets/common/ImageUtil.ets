import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';

/** 把照片压到最长边 maxSize、JPEG 质量 72，返回 base64（不含 data: 前缀）。 */
export async function uriToJpegBase64(uri: string, maxSize: number = 1400): Promise<string> {
  const helper = new util.Base64Helper();
  try {
    const src = image.createImageSource(uri);
    const info = await src.getImageInfo();
    const w: number = info.size.width;
    const h: number = info.size.height;
    const scale: number = Math.min(1, maxSize / Math.max(w, h));
    const pixelMap = await src.createPixelMap({
      desiredSize: { width: Math.round(w * scale), height: Math.round(h * scale) },
    });
    const packer = image.createImagePacker();
    const buf: ArrayBuffer = await packer.packToData(pixelMap, { format: 'image/jpeg', quality: 72 });
    return helper.encodeToStringSync(new Uint8Array(buf));
  } catch (err) {
    // 压缩失败（不支持的格式等）时回退到原图
    const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    try {
      const stat = fs.statSync(uri);
      const buf = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buf);
      return helper.encodeToStringSync(new Uint8Array(buf));
    } finally {
      fs.closeSync(file);
    }
  }
}
