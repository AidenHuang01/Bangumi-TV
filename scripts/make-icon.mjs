// Rasterize our own simple vector mark into the PNG launcher icon Samsung expects.
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

const size = 512;
const raw = Buffer.alloc((size * 4 + 1) * size);
function roundedRect(x, y, left, top, width, height, radius) {
  const cx = Math.max(left + radius, Math.min(left + width - radius, x));
  const cy = Math.max(top + radius, Math.min(top + height - radius, y));
  return x >= left && x <= left + width && y >= top && y <= top + height &&
    (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    let color = [16, 26, 37, 255];
    const ring = roundedRect(x, y, 62, 100, 388, 272, 50) && !roundedRect(x, y, 82, 120, 348, 232, 30);
    const triangle = x >= 220 && x <= 316 && Math.abs(y - 236) <= 58 * (316 - x) / 96;
    if (ring || triangle) color = [125, 228, 196, 255];
    if (roundedRect(x, y, 182, 396, 148, 20, 10)) color = [237, 184, 128, 255];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    raw.set(color, offset);
  }
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
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
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
await writeFile(new URL('../tv-app/icon.png', import.meta.url), png);
console.log('Generated tv-app/icon.png');
