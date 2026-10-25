/**
 * 一次性 OUI 扩充表生成器（task-023）。
 *
 * 从 IEEE 官方库下载完整 oui.txt（~10MB），按厂商白名单过滤出手机/平板/摄像头/
 * 网络设备/NAS/打印机相关前缀，生成 src/main/engine/discovery/oui-extended.ts。
 * 生成结果提交入库；本脚本保留用于将来重新生成（node scripts/build-oui.mjs）。
 *
 * 为什么用 IEEE 原始数据：OUI 前缀靠手抄/记忆必然出错，错一条就把 A 厂商设备
 * 标成 B 厂商——违背数据诚实原则。官方库是唯一可信源。
 *
 * 用法：node scripts/build-oui.mjs
 */
import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUI_URL = 'https://standards-oui.ieee.org/oui/oui.txt';

/**
 * 白名单：关键词（匹配 oui.txt 厂商名，大小写不敏感）→ 归一化显示名。
 * 同一显示名可挂多个关键词；每厂商前缀数上限防止单厂商撑爆表。
 */
const WHITELIST = [
  // 手机 / 平板
  { keys: ['apple, inc', 'apple inc'], name: 'Apple', cap: 60 },
  { keys: ['samsung electronics'], name: 'Samsung', cap: 40 },
  { keys: ['huawei technologies', 'huawei device', 'huawei cloud'], name: 'Huawei', cap: 40 },
  { keys: ['honor device', 'honor technologies'], name: 'Honor', cap: 20 },
  { keys: ['xiaomi communications', 'xiaomi inc', 'beijing xiaomi'], name: 'Xiaomi', cap: 30 },
  { keys: ['guangdong oppo', 'oppo mobile'], name: 'OPPO', cap: 20 },
  { keys: ['vivo mobile'], name: 'vivo', cap: 20 },
  { keys: ['oneplus electronics'], name: 'OnePlus', cap: 10 },
  { keys: ['realme'], name: 'realme', cap: 20 },
  { keys: ['google, inc', 'google llc', 'google inc'], name: 'Google', cap: 20 },
  { keys: ['motorola mobility', 'motorola solutions'], name: 'Motorola', cap: 15 },
  // 摄像头
  { keys: ['hangzhou hikvision', 'hikvision digital'], name: 'Hikvision', cap: 40 },
  { keys: ['dahua technology'], name: 'Dahua', cap: 40 },
  { keys: ['zhejiang uniview'], name: 'Uniview', cap: 20 },
  { keys: ['ezviz'], name: 'EZVIZ', cap: 10 },
  { keys: ['imou'], name: 'Imou', cap: 10 },
  { keys: ['axis communications'], name: 'Axis', cap: 20 },
  { keys: ['hangzhou xiongmai', 'xiongmai technology'], name: 'XiongMai', cap: 10 },
  // 网络设备
  { keys: ['tp-link', 'tp-link technologies'], name: 'TP-Link', cap: 40 },
  { keys: ['ruijie networks', 'ruijie_Republic'], name: 'Ruijie', cap: 20 },
  { keys: ['hangzhou h3c', 'new h3c'], name: 'H3C', cap: 20 },
  { keys: ['cisco systems'], name: 'Cisco', cap: 40 },
  { keys: ['ubiquiti'], name: 'Ubiquiti', cap: 30 },
  { keys: ['routerboard', 'tikls'], name: 'MikroTik', cap: 20 },
  { keys: ['netgear'], name: 'Netgear', cap: 40 },
  { keys: ['asustek', 'asustek computer'], name: 'ASUS', cap: 30 },
  { keys: ['shenzhen tenda', 'tenda technology'], name: 'Tenda', cap: 15 },
  { keys: ['zyxel'], name: 'Zyxel', cap: 20 },
  { keys: ['d-link', 'dlink'], name: 'D-Link', cap: 30 },
  { keys: ['fortinet', 'fortinet inc'], name: 'Fortinet', cap: 10 },
  { keys: ['aruba'], name: 'Aruba', cap: 15 },
  { keys: ['lantronix'], name: 'Lantronix', cap: 5 },
  // NAS / 服务器
  { keys: ['synology'], name: 'Synology', cap: 20 },
  { keys: ['qnap'], name: 'QNAP', cap: 15 },
  { keys: ['western digital', 'wd media'], name: 'Western Digital', cap: 10 },
  // 打印机
  { keys: ['canon inc', 'canon kabushiki', 'canon electronics'], name: 'Canon', cap: 20 },
  { keys: ['seiko epson'], name: 'Epson', cap: 20 },
  { keys: ['brother industries'], name: 'Brother', cap: 20 },
  { keys: ['fuji xerox', 'xerox corporation', 'fuji zerograf'], name: 'Xerox', cap: 20 },
  { keys: ['ricoh company', 'ricoh co'], name: 'Ricoh', cap: 20 },
  { keys: ['kyocera'], name: 'Kyocera', cap: 15 },
  { keys: ['lexmark'], name: 'Lexmark', cap: 15 },
  { keys: ['konica minolta'], name: 'Konica Minolta', cap: 15 },
  { keys: ['toshiba tec'], name: 'Toshiba TEC', cap: 10 },
  { keys: ['hewlett packard', 'hp inc', 'hewlett-packard'], name: 'HP', cap: 40 },
  { keys: ['sharp corporation'], name: 'Sharp', cap: 10 },
];

function fetchText(url, redirects = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        fetchText(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function main() {
  console.log('下载 IEEE oui.txt ...');
  fetchText(OUI_URL)
    .then((text) => {
      console.log(`下载完成 ${(text.length / 1e6).toFixed(1)}MB，解析中 ...`);
      const entries = [];
      const re = /^\s*([0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2})\s+\(hex\)\s+(.+?)\s*$/gm;
      let m;
      while ((m = re.exec(text)) !== null) {
        entries.push({ prefix: m[1].toLowerCase(), vendor: m[2] });
      }
      console.log(`共解析 ${entries.length} 条 OUI 记录`);

      const byName = new Map();
      let unmatchedCount = 0;
      for (const { prefix, vendor } of entries) {
        const v = vendor.toLowerCase();
        const rule = WHITELIST.find((r) => r.keys.some((k) => v.includes(k)));
        if (!rule) {
          unmatchedCount += 1;
          continue;
        }
        if (!byName.has(rule.name)) byName.set(rule.name, []);
        const list = byName.get(rule.name);
        if (list.length < rule.cap && !list.includes(prefix)) list.push(prefix);
      }

      const total = Array.from(byName.values()).reduce((n, l) => n + l.length, 0);
      const lines = [];
      lines.push('/**');
      lines.push(' * IEEE 官方 OUI 数据过滤生成的扩充厂商表（task-023，由 scripts/build-oui.mjs 生成）。');
      lines.push(' * 只收录白名单厂商（手机/平板/摄像头/网络设备/NAS/打印机），未命中仍回退主表与 null。');
      lines.push(' * 键格式与小写连字符前 3 段一致：`00-e0-4c`。生成时间见文件底部。');
      lines.push(' */');
      lines.push('');
      lines.push('export const OUI_EXTENDED: Readonly<Record<string, string>> = {');
      for (const [name, list] of byName) {
        if (list.length === 0) continue;
        lines.push(`  // —— ${name}（${list.length} 条）——`);
        for (const prefix of list.sort()) {
          lines.push(`  '${prefix}': '${name}',`);
        }
      }
      lines.push('};');
      lines.push('');
      const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'engine', 'discovery', 'oui-extended.ts');
      writeFileSync(out, lines.join('\n'), 'utf8');
      console.log(`已生成 ${out}`);
      console.log(`厂商 ${byName.size} 个，前缀共 ${total} 条（白名单外 ${unmatchedCount} 条忽略）`);
    })
    .catch((err) => {
      console.error('生成失败:', err.message);
      process.exit(1);
    });
}

main();
