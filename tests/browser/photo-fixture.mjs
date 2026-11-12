import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

/** An artificial solid-colour PNG. It contains no photo, EXIF, network URL or personal data. */
export function syntheticPhotoPNG(width = 2200, height = 1100, rgb = [190, 120, 50]) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 4_000_000) throw new Error('Synthetic image dimensions are bounded.');
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * (width * 3 + 1) + 1 + x * 3;
    pixels[index] = rgb[0]; pixels[index + 1] = rgb[1]; pixels[index + 2] = rgb[2];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export function syntheticPhotoFile(width, height, rgb) {
  return { name: 'synthetic-food.png', mimeType: 'image/png', buffer: syntheticPhotoPNG(width, height, rgb) };
}

/** Read the canvas-produced JPEG dimensions for a size assertion, not as input validation. */
export function jpegDimensions(dataUrl) {
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  let position = 2;
  while (position + 4 < bytes.length) {
    if (bytes[position++] !== 0xff) throw new Error('Unexpected JPEG fixture marker.');
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: bytes.readUInt16BE(position + 5), height: bytes.readUInt16BE(position + 3) };
    if (marker === 0xda || marker === 0xd9) break;
    position += bytes.readUInt16BE(position);
  }
  throw new Error('No JPEG dimensions in the generated fixture.');
}
