#!/usr/bin/env node
/**
 * IEEE OUI 厂商表生成器（task-023 初版；task-028 重写为"全量、无白名单"）。
 *
 * 生成 src/main/engine/discovery/oui-extended.ts。数据源只用 IEEE 注册库
 * （官方 oui.csv，或 Wireshark 从同一注册库导出的 manuf 文件），绝不手抄。
 *
 * 为什么不再按厂商白名单过滤：旧脚本每个厂商最多保留 20~40 个前缀，而 IEEE 给
 * 大厂（华为 2000+、Apple 1500+、三星 900+）分配的前缀远超上限——实测本机
 * 192.168.0.0/24 的 60:A3:E3（TP-Link）、B0:81:01（Honor）、AC:B7:22（Haier）
 * 全部落在被截断的尾部，导致设备显示"未知厂商"。截断等于主动丢真数据，
 * 与数据诚实原则冲突，因此改为全量收录。
 *
 * 只收录 24-bit（MA-L）前缀：28/36-bit 细分块无法用 MAC 前 3 字节区分同块内
 * 的不同厂商，收录会误标（宁缺毋滥）。手写主表 OUI_TABLE 仍优先于本表。
 *
 * 用法：
 *   node scripts/build-oui.mjs                      # 下载 IEEE oui.csv（默认）
 *   node scripts/build-oui.mjs --src manuf          # 下载 Wireshark manuf
 *   node scripts/build-oui.mjs --in <文件>          # 用本地文件（按扩展名/内容自动识别）
 *   node scripts/build-oui.mjs --out <文件>         # 自定义输出路径（调试用）
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IEEE_URL = 'https://standards-oui.ieee.org/oui/oui.csv';
const MANUF_URL = 'https://www.wireshark.org/download/automated/data/manuf';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT_DEFAULT = path.join(root, 'src/main/engine/discovery/oui-extended.ts');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

async function loadSource() {
  const local = argValue('--in', null);
  const kind = argValue('--src', null);
  const isManuf = kind === 'manuf' || (local !== null && /manuf/i.test(path.basename(local)));
  const url = isManuf ? MANUF_URL : IEEE_URL;
  const viaFile = local !== null;

  const text = viaFile
    ? await readFile(path.resolve(local), 'utf8')
    : await (async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${url}`);
        return res.text();
      })();

  return { text, isManuf, source: viaFile ? `本地文件 ${path.basename(local)}` : url };
}

/** 极简 CSV 行解析：支持引号包裹、字段内逗号与双写转义。 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 归一化厂商显示名：去掉 "Co., Ltd." 之类法律后缀与首尾杂讯。
 * 只做展示层清理，不改写品牌主体（Honor/Huawei/Tp-Link 原样保留）。
 * 拿不到主体时回退原始名称，绝不编造。
 */
export function cleanVendor(raw) {
  const original = raw.replace(/\s+/g, ' ').trim();
  if (!original) return '';
  // Wireshark 对 00:00:00 等特殊块的说明性名称："Officially Xerox, but ..."
  const official = /^Officially\s+([^,]+?)(?:,|\s+but\b)/i.exec(original);
  if (official) return official[1].trim();
  let name = original;
  const legal = /\s*,?\s*(?:co\.?\s*,?\s*ltd\.?|company\s+limited|limited|ltd\.?|inc\.?|incorporated|corp\.?|corporation|llc|plc|gmbh|s\.?\s?a\.?|b\.?\s?v\.?|a\.?\s?g\.?|oyj?|pty\.?\s*ltd\.?|pty\.?|s\.?\s?p\.?\s?a\.?|sas|sarl|k\.?\s?k\.?|sdn\.?\s*bhd\.?)$/i;
  for (let i = 0; i < 3; i += 1) {
    const next = name.replace(legal, '').replace(/[\s,;.-]+$/, '').trim();
    if (next === name || !next) break;
    name = next;
  }
  return name || original;
}

/** 解析 IEEE oui.csv → Map<24-bit 前缀, 厂商名>。 */
function parseIeeeCsv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^Registry,/i.test(line)) continue;
    const cols = parseCsvLine(line);
    const registry = (cols[0] ?? '').trim();
    const assignment = (cols[1] ?? '').trim().toUpperCase();
    const org = (cols[2] ?? '').trim();
    if (registry !== 'MA-L' || !/^[0-9A-F]{6}$/.test(assignment) || !org) continue;
    map.set(assignment, cleanVendor(org));
  }
  return map;
}

/** 解析 Wireshark manuf → Map<24-bit 前缀, 厂商名>。 */
function parseManuf(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const block = (cols[0] ?? '').trim().toUpperCase().replace(/-/g, ':');
    const org = (cols[2] ?? '').trim();
    // 28/36-bit 块形如 "00:00:0C:xx/28" 或带 7/9 位十六进制，跳过
    if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){2}$/.test(block) || !org) continue;
    map.set(block.replace(/:/g, ''), cleanVendor(org));
  }
  return map;
}

function render(map, source, isManuf) {
  const keys = [...map.keys()].sort();
  const rows = keys.map((k) => {
    const dashed = `${k.slice(0, 2)}-${k.slice(2, 4)}-${k.slice(4, 6)}`.toLowerCase();
    return `  ${JSON.stringify(dashed)}: ${JSON.stringify(map.get(k))},`;
  });
  const today = new Date().toISOString().slice(0, 10);
  return `/**
 * IEEE OUI 全量厂商表（自动生成，请勿手改）。
 *
 * 数据源：${isManuf ? 'Wireshark manuf（IEEE 注册库导出）' : 'IEEE 官方 oui.csv'} — ${source}
 * 生成时间：${today}
 * 条目数：${keys.length}（24-bit MA-L 前缀）
 * 生成命令：node scripts/build-oui.mjs${isManuf ? ' --src manuf' : ''}
 *
 * 24-bit 之外的 MA-M/MA-S 细分块不收录：前 3 字节无法区分同块内不同厂商，
 * 收录会误标（数据诚实原则）。查找顺序：手写主表 OUI_TABLE 优先，本表兜底；
 * 随机化 MAC（本地管理位）查不到属预期，由 isRandomizedMac 给出诚实标签。
 */
export const OUI_EXTENDED: Readonly<Record<string, string>> = {
${rows.join('\n')}
};
`;
}

const { text, isManuf, source } = await loadSource();
const map = isManuf ? parseManuf(text) : parseIeeeCsv(text);
if (map.size < 1000) throw new Error(`解析结果异常：仅 ${map.size} 条，拒绝覆盖现有表`);
const outPath = path.resolve(argValue('--out', OUT_DEFAULT));
const code = render(map, source, isManuf);
writeFileSync(outPath, code, 'utf8');
console.log(`[build-oui] ${map.size} 条 → ${path.relative(root, outPath)} (${Buffer.byteLength(code)} bytes)`);
