#!/usr/bin/env node
/**
 * 验证员 Vic 自用只读分析脚本（不是产品代码）。
 *
 * 目的：对 smoke 产出的 PNG 做**像素级**统计，用于判定"非空白/非全黑"，
 * 并生成像素完全相同但字节不同的副本，便于逐张目视复核。
 *
 * 用法：node analyze-png.mjs <file.png> [...]
 * 输出：JSON（宽高/均值/方差/最常见色占比/近黑占比/唯一色数）
 */
import fs from 'node:fs';
import path from 'node:path';
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

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function parseChunks(buf) {
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    out.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
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

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      switch (ft) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`未知 filter type ${ft} @ row ${y}`);
      }
      cur[x] = v;
    }
  }
  return out;
}

function analyze(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('非 PNG');
  const chunks = parseChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth !== 8) throw new Error(`仅支持 8bit，实际 ${bitDepth}`);
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = CH[colorType];
  if (!bpp) throw new Error(`不支持 colorType ${colorType}`);

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);
  const pixels = unfilter(raw, width, height, bpp);

  const stride = width * bpp;
  let sum = 0;
  let sumSq = 0;
  let nearBlack = 0;
  let transparent = 0;
  const colorCount = new Map();
  const pxCount = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * bpp;
      const r = pixels[i];
      const g = bpp >= 3 ? pixels[i + 1] : r;
      const b = bpp >= 3 ? pixels[i + 2] : r;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      sumSq += lum * lum;
      if (lum < 12) nearBlack++;
      if (bpp === 4 && pixels[i + 3] < 8) transparent++;
      const key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
      colorCount.set(key, (colorCount.get(key) ?? 0) + 1);
    }
  }
  const mean = sum / pxCount;
  const variance = sumSq / pxCount - mean * mean;
  let topKey = 0;
  let topCount = 0;
  for (const [k, c] of colorCount) {
    if (c > topCount) { topCount = c; topKey = k; }
  }
  const topRgb = [((topKey / 1024) | 0) * 8, (((topKey / 32) | 0) % 32) * 8, (topKey % 32) * 8];

  // 生成像素相同、字节不同的副本（重压缩 IDAT），供目视复核
  const level = 9;
  const newIdat = zlib.deflateSync(raw, { level });
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const c of chunks) {
    let data = c.data;
    if (c.type === 'IDAT') continue;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(c.type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    parts.push(len, typeBuf, data, crcBuf);
    void data;
  }
  // 在 IHDR 之后插入新 IDAT：简单做法——重建顺序 IHDR, [其他非 IDAT], IDAT, IEND
  const rebuilt = [parts[0]];
  const chunkList = [];
  for (const c of chunks) {
    const len = Buffer.alloc(4);
    const typeBuf = Buffer.from(c.type, 'ascii');
    let data = c.data;
    if (c.type === 'IDAT') data = newIdat;
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    chunkList.push(Buffer.concat([len, typeBuf, data, crcBuf]));
  }
  const outPath = path.join(path.dirname(file), `_re_${path.basename(file)}`);
  fs.writeFileSync(outPath, Buffer.concat([rebuilt[0], ...chunkList]));

  return {
    file: path.basename(file),
    bytes: buf.length,
    width,
    height,
    colorType,
    meanLum: +mean.toFixed(1),
    stdLum: +Math.sqrt(variance).toFixed(1),
    topColorPct: +((topCount / pxCount) * 100).toFixed(1),
    topColorRgb: topRgb,
    nearBlackPct: +((nearBlack / pxCount) * 100).toFixed(1),
    transparentPct: +((transparent / pxCount) * 100).toFixed(2),
    uniqueColorsApprox: colorCount.size,
    reencoded: path.basename(outPath),
  };
}

for (const f of process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(analyze(f)));
  } catch (err) {
    console.log(JSON.stringify({ file: path.basename(f), error: err.message }));
  }
}
