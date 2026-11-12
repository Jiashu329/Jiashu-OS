export const MAX_NUTRITION_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 2048;
const MAX_PIXELS = 4 * 1024 * 1024;
const PREFIX = 'data:image/jpeg;base64,';

export class NutritionPhotoImageError extends Error {
  readonly status: 400 | 413;
  readonly code: 'INVALID_NUTRITION_PHOTO' | 'NUTRITION_PHOTO_TOO_LARGE';
  constructor(tooLarge = false) {
    super(tooLarge ? '处理后的图片不能超过 2 MiB，请缩小图片后重试。' : '图片格式无法读取，请重新选择清晰的食物照片。');
    this.name = 'NutritionPhotoImageError';
    this.status = tooLarge ? 413 : 400;
    this.code = tooLarge ? 'NUTRITION_PHOTO_TOO_LARGE' : 'INVALID_NUTRITION_PHOTO';
  }
}

function invalid(): never { throw new NutritionPhotoImageError(); }
const isApp = (marker: number) => marker >= 0xe0 && marker <= 0xef;

/** Validate a standalone Huffman JPEG without decoding pixels or fetching URLs.
 * Structural markers are bounded independently of provider decoding. Only an
 * exact, thumbnail-free JFIF APP0 survives; all other application/comment data
 * (including EXIF, XMP, IPTC and ICC metadata) is removed before transmission.
 */
export function validateNutritionPhotoDataUrl(value: unknown): { dataUrl: string; width: number; height: number; byteLength: number } {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return invalid();
  const encoded = value.slice(PREFIX.length);
  if (encoded.length > Math.ceil(MAX_NUTRITION_PHOTO_BYTES / 3) * 4) throw new NutritionPhotoImageError(true);
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return invalid();
  let binary: string;
  try { binary = atob(encoded); } catch { return invalid(); }
  if (binary.length > MAX_NUTRITION_PHOTO_BYTES) throw new NutritionPhotoImageError(true);
  if (btoa(binary) !== encoded) return invalid();
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  const components = new Map<number, number>(), quantization = new Set<number>(), huffman = new Set<number>(), initialized = new Set<number>();
  let width = 0, height = 0, position = 2, frame = 0, scans = 0, finished = false;
  while (position < bytes.length) {
    const markerStart = position;
    if (bytes[position++] !== 0xff) return invalid();
    while (position < bytes.length && bytes[position] === 0xff) position++;
    if (position >= bytes.length) return invalid();
    const marker = bytes[position++];
    if (marker === 0xd9) {
      if (!frame || !scans || initialized.size !== components.size || position !== bytes.length) return invalid();
      kept.push(bytes.subarray(markerStart, position)); finished = true; break;
    }
    if (marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return invalid();
    if (position + 2 > bytes.length) return invalid();
    const length = bytes[position] * 256 + bytes[position + 1], end = position + length, payload = position + 2;
    if (length < 2 || end > bytes.length) return invalid();
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length < 8 || bytes[payload] !== 8) return invalid();
      height = bytes[payload + 1] * 256 + bytes[payload + 2]; width = bytes[payload + 3] * 256 + bytes[payload + 4];
      const count = bytes[payload + 5];
      if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS || ![1, 3].includes(count) || length !== 8 + count * 3) return invalid();
      for (let cursor = payload + 6; cursor < end; cursor += 3) {
        const id = bytes[cursor], sampling = bytes[cursor + 1], table = bytes[cursor + 2];
        if (components.has(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4 || (sampling & 15) < 1 || (sampling & 15) > 4 || table > 3) return invalid();
        components.set(id, table);
      }
      frame = marker;
    } else if (marker === 0xdb) {
      for (let cursor = payload; cursor < end;) {
        const table = bytes[cursor++], precision = table >> 4;
        if (precision > 1 || (table & 15) > 3) return invalid();
        const next = cursor + 64 * (precision + 1); if (next > end) return invalid();
        for (let index = cursor; index < next; index += precision + 1) if (precision === 0 ? bytes[index] === 0 : bytes[index] === 0 && bytes[index + 1] === 0) return invalid();
        cursor = next;
        quantization.add(table & 15);
      }
      if (length === 2) return invalid();
    } else if (marker === 0xc4) {
      for (let cursor = payload; cursor < end;) {
        const table = bytes[cursor++];
        if ((table >> 4) > 1 || (table & 15) > 3 || cursor + 16 > end) return invalid();
        let symbols = 0, available = 1;
        for (let index = 0; index < 16; index++) {
          const count = bytes[cursor + index]; symbols += count; available = available * 2 - count;
          if (available < 0) return invalid();
        }
        if (!symbols || symbols > 256 || available === 0) return invalid();
        cursor += 16 + symbols; if (cursor > end) return invalid(); huffman.add(table);
      }
      if (length === 2) return invalid();
    } else if (marker === 0xdd) {
      if (length !== 4) return invalid();
    } else if (marker === 0xda) {
      if (!frame || length < 6 || ++scans > 256) return invalid();
      const count = bytes[payload], selectors = new Set<number>();
      if (!count || count > components.size || length !== 6 + count * 2) return invalid();
      const spectralStart = bytes[end - 3], spectralEnd = bytes[end - 2], approximation = bytes[end - 1];
      if (spectralStart > spectralEnd || spectralEnd > 63 || (approximation >> 4) > 13 || (approximation & 15) > 13 || (frame === 0xc0 && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0))
        || (frame === 0xc2 && ((spectralStart > 0 && count !== 1) || (spectralStart === 0 && spectralEnd !== 0) || ((approximation >> 4) > 0 && (approximation & 15) !== (approximation >> 4) - 1)))) return invalid();
      for (let cursor = payload + 1; cursor < end - 3; cursor += 2) {
        const id = bytes[cursor], table = bytes[cursor + 1], quant = components.get(id);
        if (quant === undefined || selectors.has(id) || (table >> 4) > 3 || (table & 15) > 3 || !quantization.has(quant)) return invalid();
        if (spectralStart === 0 && (approximation >> 4) === 0 && !huffman.has(table >> 4)) return invalid();
        if (spectralEnd > 0 && !huffman.has(0x10 | (table & 15))) return invalid();
        if (frame === 0xc0 || (spectralStart === 0 && (approximation >> 4) === 0)) initialized.add(id);
        selectors.add(id);
      }
      kept.push(bytes.subarray(markerStart, end));
      let cursor = end, entropyBytes = 0;
      while (cursor < bytes.length) {
        if (bytes[cursor] !== 0xff) { entropyBytes++; cursor++; continue; }
        if (cursor + 1 >= bytes.length) return invalid();
        const next = bytes[cursor + 1];
        if (next === 0) { entropyBytes++; cursor += 2; continue; }
        if (next >= 0xd0 && next <= 0xd7) { cursor += 2; continue; }
        break;
      }
      if (!entropyBytes || cursor >= bytes.length) return invalid();
      kept.push(bytes.subarray(end, cursor)); position = cursor; continue;
    } else if (!isApp(marker) && marker !== 0xfe) return invalid();
    const safeJfif = marker === 0xe0 && length === 16
      && bytes[payload] === 0x4a && bytes[payload + 1] === 0x46 && bytes[payload + 2] === 0x49 && bytes[payload + 3] === 0x46 && bytes[payload + 4] === 0
      && bytes[end - 2] === 0 && bytes[end - 1] === 0;
    if ((!isApp(marker) && marker !== 0xfe) || safeJfif) kept.push(bytes.subarray(markerStart, end));
    position = end;
  }
  if (!finished) return invalid();
  const size = kept.reduce((sum, part) => sum + part.length, 0), clean = new Uint8Array(size);
  let cursor = 0; for (const part of kept) { clean.set(part, cursor); cursor += part.length; }
  let output = ''; const chunkSize = 0x8000;
  for (let start = 0; start < clean.length; start += chunkSize) output += String.fromCharCode(...clean.subarray(start, start + chunkSize));
  return { dataUrl: PREFIX + btoa(output), width, height, byteLength: size };
}
