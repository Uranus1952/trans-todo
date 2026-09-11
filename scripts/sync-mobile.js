/**
 * 把共享前端 app/ 复制到 mobile/www/，供 Capacitor 打包进 APK。
 * 保持"一套界面、两端复用"，不做任何代码分支。
 *   node scripts/sync-mobile.js
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'app');
const DEST = path.join(__dirname, '..', 'mobile', 'www');
const SKIP = new Set(['package.json', 'node_modules', '.DS_Store']);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) n += copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

fs.rmSync(DEST, { recursive: true, force: true });
const count = copyDir(SRC, DEST);

// Capacitor 需要 www/ 里有 index.html
if (!fs.existsSync(path.join(DEST, 'index.html'))) {
  console.error('✗ 复制失败：www/index.html 不存在');
  process.exit(1);
}
console.log(`✓ 已同步 ${count} 个文件 → mobile/www/`);
