export interface PreparedNutritionPhoto {
  dataUrl: string;
  blob: Blob;
  width: number;
  height: number;
}

/** All runtime dependencies stay inside this function for safe inline embedding. */
export async function prepareNutritionPhoto(file: File): Promise<PreparedNutritionPhoto> {
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const MAX_PIXELS = 32000000;
  const MAX_SOURCE_SIDE = 20000;
  const MAX_OUTPUT_SIDE = 1600;
  const unsupported = '无法读取这张照片。请换用 JPG、PNG 或 WebP；HEIC／HEIF 可先在手机中导出为 JPG。';
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('请选择一张非空的食物照片。');
  if (file.size > MAX_FILE_BYTES) throw new Error('原始照片最多 20 MiB，请先缩小图片后再选择。');
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  const extension = /\.(?:jpe?g|png|webp|hei[cf])$/i.test(file.name || '');
  if (file.type && !allowed.includes(file.type.toLowerCase()) && !(file.type === 'application/octet-stream' && extension)) throw new Error('请选择 JPG、PNG、WebP 或手机 HEIC／HEIF 照片，暂不支持动图和其他文件。');
  let header: Uint8Array;
  try { header = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()); }
  catch { throw new Error('无法读取照片文件，请重新选择。'); }
  const ascii = (offset: number, value: string) => [...value].every((char, index) => header[offset + index] === char.charCodeAt(0));
  const be16 = (offset: number) => header[offset] * 256 + header[offset + 1];
  const be32 = (offset: number) => header[offset] * 16777216 + header[offset + 1] * 65536 + header[offset + 2] * 256 + header[offset + 3];
  const le24 = (offset: number) => header[offset] + header[offset + 1] * 256 + header[offset + 2] * 65536;
  let dimensions: { width: number; height: number } | null = null;
  if (header.length >= 24 && header[0] === 137 && ascii(1, 'PNG\r\n\x1a\n') && ascii(12, 'IHDR')) {
    dimensions = { width: be32(16), height: be32(20) };
  } else if (header.length >= 4 && header[0] === 255 && header[1] === 216) {
    let offset = 2;
    while (offset + 3 < header.length) {
      if (header[offset++] !== 255) throw new Error(unsupported);
      while (header[offset] === 255) offset++;
      const marker = header[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = be16(offset);
      if (length < 2 || offset + length > header.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw new Error(unsupported);
        dimensions = { width: be16(offset + 5), height: be16(offset + 3) };
        break;
      }
      offset += length;
    }
  } else if (header.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X')) dimensions = { width: le24(24) + 1, height: le24(27) + 1 };
    else if (ascii(12, 'VP8L') && header[20] === 47) dimensions = {
      width: 1 + header[21] + ((header[22] & 63) << 8),
      height: 1 + (header[22] >> 6) + (header[23] << 2) + ((header[24] & 15) << 10),
    };
    else if (ascii(12, 'VP8 ') && header[23] === 157 && header[24] === 1 && header[25] === 42) dimensions = {
      width: (header[26] + header[27] * 256) & 16383,
      height: (header[28] + header[29] * 256) & 16383,
    };
  } else if (header.length >= 28 && ascii(4, 'ftyp')) {
    const headerEnd = Math.min(header.length, be32(0));
    let heif = false;
    for (let offset = 8; offset + 4 <= headerEnd; offset += 4) if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].some((brand) => ascii(offset, brand))) heif = true;
    if (heif) for (let offset = 4; offset + 16 <= header.length; offset++) {
      if (!ascii(offset, 'ispe') || be32(offset - 4) < 20) continue;
      const candidate = { width: be32(offset + 8), height: be32(offset + 12) };
      if (!dimensions || candidate.width * candidate.height > dimensions.width * dimensions.height) dimensions = candidate;
    }
  }
  const bounded = (size: { width: number; height: number }) => Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
    && size.width > 0 && size.height > 0 && size.width <= MAX_SOURCE_SIDE && size.height <= MAX_SOURCE_SIDE && size.width * size.height <= MAX_PIXELS;
  if (!dimensions) throw new Error(unsupported);
  if (!bounded(dimensions)) throw new Error('照片像素过大，请选择不超过 3200 万像素的版本，或先缩小图片。');
  let bitmap: ImageBitmap | null = null, image: HTMLImageElement | null = null, sourceUrl = '';
  try {
    if (typeof createImageBitmap === 'function') {
      try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch { /* Safari can decode some phone formats through Image instead. */ }
    }
    if (!bitmap) {
      if (typeof Image !== 'function') throw new Error(unsupported);
      sourceUrl = URL.createObjectURL(file);
      image = new Image();
      image.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        image!.onload = () => resolve();
        image!.onerror = () => reject(new Error(unsupported));
        image!.src = sourceUrl;
      });
    }
    const source = bitmap || image!;
    const width = bitmap ? bitmap.width : image!.naturalWidth, height = bitmap ? bitmap.height : image!.naturalHeight;
    if (!bounded({ width, height })) throw new Error('照片像素过大或尺寸无效，请缩小图片后重试。');
    const scale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context || typeof canvas.toBlob !== 'function') throw new Error('当前浏览器无法处理照片，请更新浏览器或换用 JPG 照片。');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    for (const quality of [0.86, 0.76, 0.66, 0.56, 0.46]) {
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('照片压缩失败，请重新选择 JPG 照片。')), 'image/jpeg', quality));
      if (blob.type !== 'image/jpeg') throw new Error('当前浏览器无法生成 JPG 图片，请换用其他浏览器。');
      if (blob.size <= MAX_IMAGE_BYTES) break;
    }
    if (!blob || blob.size <= 0 || blob.size > MAX_IMAGE_BYTES) throw new Error('照片压缩后仍超过 2 MiB，请先裁剪或缩小图片。');
    const encoded = new Uint8Array(await blob.arrayBuffer());
    if (encoded.length < 4 || encoded[0] !== 255 || encoded[1] !== 216 || encoded[encoded.length - 2] !== 255 || encoded[encoded.length - 1] !== 217) throw new Error('照片处理结果无效，请换一张 JPG 照片。');
    let binary = '';
    for (let offset = 0; offset < encoded.length; offset += 8192) binary += String.fromCharCode(...encoded.subarray(offset, offset + 8192));
    return { dataUrl: 'data:image/jpeg;base64,' + btoa(binary), blob, width: canvas.width, height: canvas.height };
  } catch (error) {
    if (error instanceof Error && /照片|图片|浏览器|JPG|HEIC|像素/.test(error.message)) throw error;
    throw new Error(unsupported);
  } finally {
    bitmap?.close();
    if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}
