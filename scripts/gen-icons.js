// 生成托盘图标（16px 与 @2x Template image，纯 JS 生成 PNG，无外部依赖）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = table[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(size, draw) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      row[1 + x * 4] = r; row[2 + x * 4] = g; row[3 + x * 4] = b; row[4 + x * 4] = a;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 书本图标：实心圆角方块 + 中缝透明线（macOS template 图标）
function bookIcon(x, y, s) {
  const m = 1;
  const w = s - 2;
  const cx = x - m, cy = y - m;
  if (cx < 0 || cy < 0 || cx >= w || cy >= w) return [0, 0, 0, 0];
  const r = Math.max(2, Math.round(s * 0.22));
  const nx = Math.min(cx, w - 1 - cx), ny = Math.min(cy, w - 1 - cy);
  if (nx < r && ny < r && (r - nx) * (r - nx) + (r - ny) * (r - ny) > r * r) return [0, 0, 0, 0];
  if (cx === (w >> 1)) return [0, 0, 0, 0]; // 书脊缝隙
  return [0, 0, 0, 255];
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'trayTemplate.png'), makePng(16, bookIcon));
fs.writeFileSync(path.join(dir, 'trayTemplate@2x.png'), makePng(32, bookIcon));
console.log('icons generated at', dir);
