#!/usr/bin/env node
/**
 * 验证员 Vic 自用的**只读**裁剪脚本（不是产品代码，不参与构建）。
 *
 * 为什么需要它：整屏截图 1344x841，小字号数值（墨盒百分比、MAC、心跳间隔）
 * 在全图缩放后无法可靠辨认。本脚本从原图无损裁出指定矩形，输出小图供逐处目视核对。
 * 只读取原 PNG，绝不修改原图。
 *
 * 用法：node crop-png.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const [inFile, outFile, xs, ys, ws, hs, ss] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error('用法: node crop-png.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]');
  process.exit(2);
}
const CX = Number(xs ?? 0);
const CY = Number(ys ?? 0);
const CW = Number(ws ?? 0);
const CH = Number(hs ?? 0);
const SCALE = Number(ss ?? 1);

const buf = fs.readFileSync(inFile);
const chunks = [];
let off = 8;
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
  off += 12 + len;
  if (type === 'IEND') break;
}
const ihdr = chunks.find((c) => c.type === 'IHDR').data;
const W = ihdr.readUInt32BE(0);
const H = ihdr.readUInt32BE(4);
const depth = ihdr[8];
const ctype = ihdr[9];
if (depth !== 8 || ![2, 6].includes(ctype)) throw new Error(`仅支持 8bit RGB/RGBA，实际 depth=${depth} type=${ctype}`);
const bpp = ctype === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));

// unfilter
const stride = W * bpp;
const px = Buffer.alloc(stride * H);
let pos = 0;
for (let y = 0; y < H; y++) {
  const ft = raw[pos++];
  const row = raw.subarray(pos, pos + stride);
  pos += stride;
  const cur = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    let v = row[x];
    if (ft === 1) v = (v + a) & 0xff;
    else if (ft === 2) v = (v + b) & 0xff;
    else if (ft === 3) v = (v + ((a + b) >> 1)) & 0xff;
    else if (ft === 4) v = (v + paeth(a, b, c)) & 0xff;
    else if (ft !== 0) throw new Error(`未知 filter ${ft}`);
    cur[x] = v;
  }
}

const x0 = Math.max(0, Math.min(W - 1, CX));
const y0 = Math.max(0, Math.min(H - 1, CY));
const w = Math.max(1, Math.min(W - x0, CW || W));
const h = Math.max(1, Math.min(H - y0, CH || H));
const OW = Math.round(w * SCALE);
const OH = Math.round(h * SCALE);

const outStride = OW * 3 + 1;
const outRaw = Buffer.alloc(outStride * OH);
for (let y = 0; y < OH; y++) {
  outRaw[y * outStride] = 0; // filter none
  const sy = y0 + Math.min(h - 1, Math.floor(y / SCALE));
  for (let x = 0; x < OW; x++) {
    const sx = x0 + Math.min(w - 1, Math.floor(x / SCALE));
    const si = sy * stride + sx * bpp;
    const di = y * outStride + 1 + x * 3;
    outRaw[di] = px[si];
    outRaw[di + 1] = px[si + 1];
    outRaw[di + 2] = px[si + 2];
  }
}

const newIhdr = Buffer.alloc(13);
newIhdr.writeUInt32BE(OW, 0);
newIhdr.writeUInt32BE(OH, 4);
newIhdr[8] = 8;
newIhdr[9] = 2;
newIhdr[10] = 0;
newIhdr[11] = 0;
newIhdr[12] = 0;

const out = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', newIhdr),
  chunk('IDAT', zlib.deflateSync(outRaw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(outFile, out);
console.log(`${outFile} ${OW}x${OH} ${out.length}B  (crop ${x0},${y0} ${w}x${h} scale ${SCALE})`);
