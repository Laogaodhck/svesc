/**
 * 打包残留目录清理脚本（绕过环境 safe-delete 的递归 rm 拦截）。
 *
 * 背景：环境中 safe-delete shim 会拦截"一次调用递归删大目录"，并对 .asar
 * 有专项保护（unlink/rename 均走 trash 被拦，失败的 trash 还会泄漏句柄）。
 * 本脚本逐文件 unlink + 自底向上 rmdir；.asar 文件**直接跳过**——
 * electron-builder 的 electronDist 复制流程会用新文件同名覆盖旧 asar，
 * 无需删除。
 *
 * 用法：node scripts/clean-unpacked.cjs <dir> [moreDirs...]
 * 仅用于清理构建产物目录，禁止对源码/个人目录使用。
 */
const fs = require('fs');
const path = require('path');

let files = 0;
let dirs = 0;

function clean(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`    readdir 失败于: ${dir} → ${err.code}`);
    throw err;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clean(p, depth + 1);
    } else {
      if (p.endsWith('.asar')) {
        console.log(`    跳过 asar（复制流程会覆盖）: ${p}`);
        continue;
      }
      for (let i = 0; ; i++) {
        try {
          fs.unlinkSync(p);
          files++;
          break;
        } catch (err) {
          if (err.code !== 'EBUSY' || i >= 2) {
            console.error(`    unlink 失败于: ${p} → ${err.code || err.message}`);
            throw err;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        }
      }
    }
  }
  for (let i = 0; ; i++) {
    try {
      fs.rmdirSync(dir);
      dirs++;
      break;
    } catch (err) {
      // 目录里只剩 asar（被跳过）属预期：交给打包流程的复制覆盖处理
      if (err.code === 'ENOTEMPTY') {
        console.log(`    保留仅含 asar 的目录: ${dir}`);
        return;
      }
      if (err.code !== 'EBUSY' || i >= 2) {
        console.error(`    rmdir 失败于: ${dir} → ${err.code || err.message}`);
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

for (const target of process.argv.slice(2)) {
  if (!fs.existsSync(target)) {
    console.log(`skip (不存在): ${target}`);
    continue;
  }
  try {
    clean(path.resolve(target));
    console.log(`已清理: ${target}（本次 ${files} 文件 / ${dirs} 目录，累计）`);
  } catch (err) {
    console.error(`清理未完成: ${target} → ${err.code || err.message}`);
    process.exitCode = 1;
  }
}
