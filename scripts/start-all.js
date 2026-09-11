#!/usr/bin/env node
/**
 * Onederz 一键启动
 * ---------------------------------------------------------------
 *   1. 检查依赖（缺了就自动装，含 Electron 二进制）
 *   2. 若已有实例在运行，给出人话提示而不是硬起第二个（后者会因 userData 目录锁报一堆错）
 *   3. 拉起同步服务 + Windows 桌面部件
 * 输出带 [同步] / [桌面] 前缀，Ctrl+C 一起收摊。
 *
 *   node scripts/start-all.js            正常启动
 *   node scripts/start-all.js --nogpu    强制软件渲染（远程桌面 / 虚拟机 / 无独显）
 *   node scripts/start-all.js --restart  先退出已在运行的实例，再重新启动
 *
 * 所有用户可见文案都放在这里（Node 的 UTF-8 输出可靠），
 * 批处理入口保持纯 ASCII，避免 cmd.exe 下的中文乱码。
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const DESKTOP_DIR = path.join(ROOT, 'desktop');
const LOCK_FILE = path.join(os.tmpdir(), 'onederz-instance.json');
const SERVER_URL = 'http://127.0.0.1:8787';

/** 8787 上是否已有同步服务在跑（部件会自己托管一个，避免端口冲突） */
async function isServerUp() {
  try {
    const res = await fetch(SERVER_URL + '/api/health', { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

const nogpu = process.argv.includes('--nogpu');
const restart = process.argv.includes('--restart');

const children = [];
let shuttingDown = false;
let desktopStartedAt = 0;

const C = { 同步: '\x1b[36m', 桌面: '\x1b[35m', 启动: '\x1b[32m', 错误: '\x1b[31m', 提示: '\x1b[33m' };
const log = (tag, msg) => console.log(`${C[tag] || ''}[${tag}]\x1b[0m ${msg}`);
const die = (msg) => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m\n`);
  shutdown(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 实例检测 ============================ */

/** 读取实例锁文件；返回仍在运行的实例信息，或 null */
function readRunningInstance() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (!info || !info.pid) return null;
  try {
    process.kill(info.pid, 0); // 只探测存在性
    return info;
  } catch (err) {
    // ESRCH = 进程已不存在（残留锁文件）；其它错误保守认为还活着
    return err && err.code === 'ESRCH' ? null : info;
  }
}

function killInstance(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* noop */
  }
}

/* ============================ 依赖准备 ============================ */

function run(cmd, args, cwd, extraEnv) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return r.status === 0;
}

function electronBinaryPath() {
  try {
    const p = require(path.join(DESKTOP_DIR, 'node_modules', 'electron'));
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

/**
 * 从 desktop/.npmrc 读出 electron_mirror。
 * .npmrc 只在 npm 生命周期脚本里转成 npm_config_* 环境变量，
 * 我们手动跑 install.js 时拿不到，所以要自己解析并显式传 ELECTRON_MIRROR。
 */
function readElectronMirror() {
  const fallback = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
  try {
    const m = fs.readFileSync(path.join(DESKTOP_DIR, '.npmrc'), 'utf8').match(/^\s*electron_mirror\s*=\s*(\S+)\s*$/m);
    return m ? m[1] : fallback;
  } catch {
    return fallback;
  }
}

function ensureDeps() {
  const missing = [];
  if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) missing.push('同步服务');
  if (!fs.existsSync(path.join(DESKTOP_DIR, 'node_modules'))) missing.push('桌面端');

  if (missing.length) {
    console.log('');
    log('启动', `首次运行，需要安装依赖（${missing.join(' / ')}）`);
    log('启动', '大约 1–3 分钟，需要联网，请耐心等待…');
    console.log('');
    if (!run('npm', ['run', 'setup'], ROOT)) {
      die(
        '依赖安装失败。若是 Electron 下载超时，请检查 desktop/.npmrc 里的镜像地址，\n' +
          '  或手动执行：cd desktop && node node_modules\\electron\\install.js'
      );
    }
  }

  const exe = electronBinaryPath();
  if (!exe || !fs.existsSync(exe)) {
    const mirror = readElectronMirror();
    log('启动', `正在补下 Electron 运行时（首次约 200MB，镜像 ${mirror}）…`);
    const ok = run(process.execPath, [path.join('node_modules', 'electron', 'install.js')], DESKTOP_DIR, {
      ELECTRON_MIRROR: mirror,
    });
    const exe2 = electronBinaryPath();
    if (!ok || !exe2 || !fs.existsSync(exe2)) {
      die(
        'Electron 运行时下载失败。\n' +
          '  请确认 desktop/.npmrc 中的 electron_mirror 可用，然后重试；\n' +
          '  或手动执行：cd desktop && node node_modules\\electron\\install.js'
      );
    }
  }
  return electronBinaryPath();
}

/* ============================ 子进程管理 ============================ */

function pipe(child, tag) {
  const handle = (buf) => {
    String(buf)
      .replace(/\r/g, '')
      .split('\n')
      .filter((l) => l.trim())
      .forEach((l) => log(tag, l));
  };
  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode !== null || c.killed) continue;
    try {
      if (process.platform === 'win32') {
        // Windows 下子进程可能还有孙进程，用 taskkill 整棵树收掉
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        c.kill('SIGTERM');
      }
    } catch {
      /* noop */
    }
  }
  setTimeout(() => process.exit(code), 400);
}

/** 已在运行时的提示文案 */
function printAlreadyRunning(info) {
  console.log(`
\x1b[1mOnederz 已经在运行了\x1b[0m（进程号 ${info.pid}）
  所以这次没有再启动一个，避免两个实例抢同一份数据。

  想看到部件：
    · 按 \x1b[36mAlt+Space\x1b[0m 直接显隐部件
    · 或点系统托盘里的 Onederz 图标 → 「显示部件」
    · 或按 \x1b[36mWin+D\x1b[0m 回到桌面（默认模式下它只在桌面可见）

  想彻底退出：托盘右键 → 退出 Onederz
  想强杀重启：双击「重启 Onederz.cmd」，或执行 npm run restart
`);
}

/* ================================ 主流程 ================================ */

(async function main() {
  let running = readRunningInstance();

  if (running && restart) {
    log('启动', `正在退出已有实例（进程号 ${running.pid}）…`);
    killInstance(running.pid);
    await sleep(1500);
    running = readRunningInstance();
    if (running) {
      log('提示', '旧实例未能退出，仍尝试启动（可能失败）。');
    } else {
      log('启动', '旧实例已退出。');
    }
  }

  if (running && !restart) {
    printAlreadyRunning(running);
    process.exit(0);
    return;
  }

  const electronPath = ensureDeps();
  if (shuttingDown) return;

  // 部件本身会托管同步服务（见 desktop/src/main.js 的 ensureSyncServer）。
  // 若 8787 已有服务在跑，这里就别再起一个 —— 否则会 EADDRINUSE 直接崩。
  if (await isServerUp()) {
    log('同步', '检测到同步服务已在运行，直接复用。');
  } else {
    log('启动', '正在启动同步服务…');
    const server = spawn(process.execPath, ['src/server.js'], {
      cwd: SERVER_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(server);
    pipe(server, '同步');
    server.on('error', (e) => die('同步服务启动失败：' + e.message));
    server.on('exit', (code) => {
      if (shuttingDown) return;
      log('同步', `进程退出（代码 ${code}）。端口 8787 被占用？桌面端仍可离线使用。`);
    });
    await sleep(1400);
    if (shuttingDown) return;
  }

  console.log(`
\x1b[1mOnederz 已启动\x1b[0m
  没看到部件？按 \x1b[36mAlt+Space\x1b[0m，或看系统托盘。
  默认模式下它只在桌面可见 —— 按 \x1b[36mWin+D\x1b[0m 回到桌面即可看到。
  想让它一直可见：托盘右键 → 显示层级 → 「普通窗口 · 一直显示在最底层」。
  彻底退出：在本窗口按 \x1b[36mCtrl+C\x1b[0m，或托盘右键 → 退出。
`);

  const args = [DESKTOP_DIR];
  const env = { ...process.env };
  if (nogpu) {
    args.push('--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox', '--use-gl=swiftshader', '--disable-dev-shm-usage');
    env.ONEDERZ_NO_GPU = '1';
  }

  log('启动', nogpu ? '正在以软件渲染启动桌面部件…' : '正在启动桌面部件…');
  desktopStartedAt = Date.now();
  const desktop = spawn(electronPath, args, { cwd: DESKTOP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(desktop);
  pipe(desktop, '桌面');
  desktop.on('error', (e) => die('桌面部件启动失败：' + e.message));
  desktop.on('exit', (code) => {
    if (shuttingDown) return;
    const lived = Date.now() - desktopStartedAt;

    // 秒退且退出码为 0：几乎一定是"已有一个实例在跑"导致新实例让位，
    // 或者是 userData 目录被占用。这时不要把同步服务一起带走 ——
    // 用户很可能只是想在旧实例上看到部件而已。
    if (code === 0 && lived < 6000) {
      const alive = readRunningInstance();
      console.log('');
      log('提示', alive ? `检测到已有实例在运行（进程号 ${alive.pid}）。` : '桌面部件启动后立即退出了。');
      console.log(`
  常见原因：上一次的 Onederz 还在后台运行（关掉窗口不会退出，它常驻托盘），
  新实例拿不到数据目录锁，于是自动让位。

  请试：
    1. 按 \x1b[36mAlt+Space\x1b[0m，或点系统托盘里的 Onederz 图标 —— 部件可能只是被隐藏了
    2. 托盘右键 → 退出 Onederz，然后重新启动
    3. 或直接双击「重启 Onederz.cmd」强制重启

  \x1b[33m同步服务仍在运行\x1b[0m（手机端可以继续同步）。按 Ctrl+C 结束。
`);
      return; // 保留同步服务
    }

    log('桌面', `已退出（代码 ${code}）。`);
    shutdown(code ?? 0);
  });
})();

process.on('SIGINT', () => {
  log('启动', '收到 Ctrl+C，正在关闭…');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
