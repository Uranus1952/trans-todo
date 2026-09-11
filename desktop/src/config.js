/**
 * Onederz · 桌面端配置持久化
 * 落在 Electron 的 userData 目录（Windows: %APPDATA%\Onederz\desktop-config.json）
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  bounds: null, // { x, y, width, height }
  // 默认用「跟随桌面显隐」：行为与系统桌面部件一致（打开其他应用即隐藏、回到桌面即出现），
  // 而且是经过验证可靠的方案。'desktop'（WorkerW 挂载）在 Electron 透明窗口上不可靠，
  // 现改为手动可选，并在挂载后自校验、失败自动回落到本模式。
  mode: 'autohide', // autohide(跟随桌面显隐) | desktop(桌面层·实验性) | bottom(置底常显) | top(置顶)
  backdrop: 'acrylic', // acrylic(亚克力磨砂) | blur(仅模糊) | none(关闭系统模糊)
  tint: 'light', // light(浅色文字方案) | dark(深色文字方案)
  glassBase: '255,255,255', // 玻璃基色 "r,g,b"，外观预设靠它给亚克力和页面上色
  opacity: 0.55, // 玻璃浓度 = 目标不透明度，同时驱动系统亚克力与页面玻璃层
  accent: '#5b6bff',
  collapsed: false,
  autoStart: false,
  hotkey: 'Alt+Space',
  minWidth: 268,
  minHeight: 216,
  applyRounding: true,
};

let cache = null;
let file = null;

function filePath() {
  if (!file) file = path.join(app.getPath('userData'), 'desktop-config.json');
  return file;
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[config] 保存失败：', err.message);
  }
  return next;
}

const reset = () => {
  cache = { ...DEFAULTS };
  return save({});
};

module.exports = { load, save, reset, DEFAULTS, filePath };
