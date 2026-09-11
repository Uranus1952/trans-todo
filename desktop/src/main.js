/**
 * Onederz · Windows 桌面部件主进程
 * ---------------------------------------------------------------
 * 职责：
 *   1. 起一个 loopback 静态服务，把共享前端（app/）以标准 HTTP 提供出去；
 *   2. 创建一个无边框透明窗口，施加系统亚克力磨砂 + DWM 圆角；
 *   3. 默认把它挂到桌面层（WorkerW），从而实现
 *      「打开其他应用/网页时自动被盖住、显示桌面时出现」——
 *      与系统桌面部件完全一致的显示隐藏逻辑；
 *   4. 自定义拖拽与八向缩放、托盘、全局热键、开机自启、配置持久化。
 */

const electron = require('electron');
if (!electron.app) {
  console.error('[fatal] 当前进程不是 Electron 主进程，请用 `npm start` 或 `npx electron .` 启动。');
  process.exit(1);
}
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, dialog, shell, Notification } = electron;
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const config = require('./config');
const native = require('./win32');
const { startStaticServer } = require('../../tools/static-server');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
const SELFTEST = !!process.env.ONEDERZ_SELFTEST;

/** 共享前端的物理位置：开发时在仓库 app/，打包后在 resources/app/ */
function resolveAppDir() {
  const packed = path.join(process.resourcesPath || '', 'app');
  if (!isDev && fs.existsSync(path.join(packed, 'index.html'))) return packed;
  return path.join(__dirname, '..', '..', 'app');
}

/** 同步服务目录：开发时在仓库 server/，打包后在 resources/server/ */
function resolveServerDir() {
  const packed = path.join(process.resourcesPath || '', 'server');
  if (!isDev && fs.existsSync(path.join(packed, 'src', 'server.js'))) return packed;
  return path.join(__dirname, '..', '..', 'server');
}

/**
 * 后台托管同步服务
 * ---------------------------------------------------------------
 * 目标是"部件在、服务就在，开机自启即全部就绪"，用户不需要留着一个命令行窗口。
 *  - 8787 上已有服务 → 直接复用（可能是之前那次启动留下的，或你单独跑的）
 *  - 没有 → 以隐藏窗口方式拉起（windowsHide，不会闪出黑色控制台）
 *  - 若这个服务是本进程拉起的，退出部件时一并收掉；别人起的则不动
 */
let serverChild = null;
const SERVER_URL = 'http://127.0.0.1:8787';

async function isServerUp() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(SERVER_URL + '/api/health', { signal: ctrl.signal });
    clearTimeout(tid);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureSyncServer() {
  if (await isServerUp()) {
    console.log('[server] 检测到同步服务已在运行，直接复用。');
    return { reused: true };
  }
  const dir = resolveServerDir();
  if (!fs.existsSync(path.join(dir, 'src', 'server.js'))) {
    console.warn('[server] 找不到同步服务源码（打包时未包含），部件将以离线模式运行。');
    return { started: false, missing: true };
  }
  serverChild = spawn(
    process.execPath,
    ['src/server.js'],
    {
      cwd: dir,
      env: {
        ...process.env,
        // 关键：Electron 的 process.execPath 是 electron.exe 而不是 node，
        // 直接跑 server.js 会被当成一个新的 Electron 应用。加这个开关让它以
        // 纯 Node 模式运行（Electron 自带的 Node 就是我们需要的运行时）。
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: 'ignore',
      windowsHide: true, // 关键：不弹控制台
      detached: false, // 跟随部件生命周期，避免留下无人认领的后台进程
    }
  );
  serverChild.on('error', (e) => console.warn('[server] 启动失败：', e.message));
  serverChild.on('exit', (code) => {
    if (shuttingDown) return;
    console.warn(`[server] 同步服务退出（代码 ${code}）。`);
    serverChild = null;
  });
  // 给它一点时间起端口
  for (let i = 0; i < 20; i++) {
    if (await isServerUp()) return { started: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  console.warn('[server] 同步服务已拉起但端口未就绪，稍后可手动检查。');
  return { started: true };
}

let win = null;
let tray = null;
let staticSrv = null;
let cursorTimer = null;
let modeTimer = null;
let userHidden = false;
let degradedReason = null;
let lastDiag = null;
let lastAttachOk = false;
let lastRounding = '0';

/** 拖拽 / 缩放会话状态 */
let session = null;

app.setAppUserModelId('cn.onederz.widget');

/**
 * 实例锁文件：让启动器在起第二个实例之前就能发现"已经在跑了"。
 * Electron 自身的 requestSingleInstanceLock 要等 Chromium 初始化之后才生效，
 * 那时已经报出一堆 userData 目录锁冲突的错误，用户看到的是莫名其妙的失败。
 * 提前用这个文件挡掉，才能给出人话提示。
 */
const LOCK_FILE = path.join(os.tmpdir(), 'onederz-instance.json');

function writeLockFile() {
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: app.getVersion() }),
      'utf8'
    );
  } catch {
    /* 写不了就算了，不影响主流程 */
  }
}

function clearLockFile() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* noop */
  }
}

// 无 GPU 的机器 / 远程桌面 / 虚拟机场景：ONEDERZ_NO_GPU=1 强制软件渲染，
// 否则 Chromium 的 GPU 进程起不来会直接退出。
if (process.env.ONEDERZ_NO_GPU || SELFTEST) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

/* -------------------------- 单实例 -------------------------- */
if (!app.requestSingleInstanceLock()) {
  console.log('[app] 已有一个 Onederz 在运行，本次启动退出。');
  app.quit();
} else {
  writeLockFile();
  app.on('second-instance', () => {
    // 第二次双击启动时，把已有实例的部件显示出来，而不是默默退出
    userHidden = false;
    if (!win) {
      createWindow();
      return;
    }
    if (win.isVisible()) win.focus();
    else win.showInactive();
    refreshTrayMenu();
  });
}

/* ============================ 主流程 ============================ */

app.whenReady().then(async () => {
  const appDir = resolveAppDir();
  staticSrv = await startStaticServer(appDir, { quiet: true });

  createWindow();
  createTray();
  registerHotkey();
  applyAutoStart();

  // 后台托管同步服务：部件常驻托盘，服务就一直在，手机端随时可连
  const srv = await ensureSyncServer();
  if (isDev) console.log('[server] 同步服务状态：', JSON.stringify(srv));

  const info = await native.systemInfo();
  console.log(`[native] Windows ${info.osVersion} · WorkerW=${info.hasWorkerW ? '可用' : '不可用'}`);

  if (SELFTEST) {
    setTimeout(async () => {
      const cfg = config.load();
      const st = await win.webContents
        .executeJavaScript(
          `(async () => {
        const app = window.onederzApp;
        if (!app) return { ready: false };
        const M = app.M;
        const $ = (s) => document.querySelector(s);
        const $$ = (s) => [...document.querySelectorAll(s)];
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const log = {};

        // 清空本机数据，并把外观复位到已知状态，保证测试不依赖上一轮持久化的设置
        app.state.tasks = [];
        app.state.settings.tint = 'light';
        app.state.settings.glassOpacity = 0.55;
        app.state.settings.hideCompleted = false;
        app.applyTheme();
        app.render();

        // 1) 通过界面添加一条常驻任务
        document.getElementById('typeSeg').querySelector('[data-type="daily"]').click();
        const input = document.getElementById('input');
        input.value = '晨会 10:00';
        document.getElementById('btnAdd').click();
        await wait(60);
        log.step1_rows = $$('.row').length;

        // 2) 切换为临时任务再添加一条，并带上倒计时
        document.getElementById('typeSeg').querySelector('[data-type="temp"]').click();
        log.step2_addType = app.state.addType;
        const t = app.M.createTask({ type: 'temp', title: '交周报', countdownTo: Date.now() + 3600000, deviceId: 'selftest' });
        app.state.tasks.push(t);
        app.render();
        await wait(60);
        log.step2_rows = $$('.row').length;
        log.step2_cdChip = $('.chip.cd') ? $('.chip.cd').textContent.trim() : null;

        // 3) 点击复选框完成常驻任务 → 应进入"已完成"分区
        // 注意：render() 会重建列表 DOM，所以点击后必须按 id 重新查询节点
        const dailyId = app.state.tasks.find((x) => x.type === 'daily').id;
        $$('.row').find((r) => r.dataset.id === dailyId).querySelector('[data-act="toggle"]').click();
        await wait(60);
        log.step3_done = $$('.row.is-done').length;
        log.step3_dailyDone = !!$$('.row.is-done').find((r) => r.dataset.id === dailyId);
        log.step3_sections = $$('.sec').map((s) => s.textContent.replace(/\\s+/g, ''));
        log.step3_pending = document.getElementById('pendingText').textContent;
        log.step3_pct = document.getElementById('ringTxt').textContent;
        log.step3_progress = document.getElementById('progressBar').style.width;

        // 4) 打开单条待办的操作菜单
        const rows = $$('.row');
        rows[rows.length - 1].querySelector('[data-act="menu"]').click();
        await wait(60);
        log.step4_itemPop = !document.getElementById('itemPop').hidden;
        log.step4_popLeft = document.getElementById('itemPop').style.left;
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await wait(40);
        log.step4_closed = document.getElementById('itemPop').hidden;

        // 5) 打开设置面板，检查同步与桌面部件两栏都在
        document.getElementById('btnMenu').click();
        await wait(50);
        document.getElementById('mainPop').querySelector('[data-act="settings"]').click();
        await wait(80);
        log.step5_panel = !document.getElementById('panel').hidden;
        log.step5_modeSelect = !!document.getElementById('fMode');
        log.step5_serverField = !!document.getElementById('fServer');
        log.step5_funcs = typeof app.engine.login === 'function' && typeof app.engine.syncNow === 'function';
        log.step5_tick = typeof app.render === 'function';
        document.getElementById('panelBack').click();

        // 6) 每日重置：把常驻任务的完成日改成昨天，今天应自动回到未完成
        const daily = app.state.tasks.find((x) => x.type === 'daily');
        daily.doneDate = '2000-01-01';
        app.render();
        await wait(40);
        log.step6_reopened = $$('.row').find((r) => r.dataset.id === daily.id)?.classList.contains('is-done') === false;

        // 7) 临时任务过期后应被清理
        const temp = app.state.tasks.find((x) => x.type === 'temp');
        temp.date = '2000-01-01';
        const changed = app.M.runDailyMaintenance(app.state.tasks, Date.now());
        log.step7_cleaned = changed.length;

        // 8) 玻璃浓度滑块：拖动过程中不能重建面板 DOM（否则拖到一半就断了）
        document.getElementById('btnMenu').click();
        await wait(50);
        document.getElementById('mainPop').querySelector('[data-act="settings"]').click();
        await wait(80);
        const slider = document.getElementById('fOpacity');
        const w = document.getElementById('widget');
        const glassAlpha = () => {
          const raw = getComputedStyle(w).getPropertyValue('--glass-a').trim();
          return parseFloat(raw.split(',').pop());
        };
        const sheen = () => Number(getComputedStyle(w).getPropertyValue('--sheen').trim());
        const samples = [];
        for (const v of [8, 30, 55, 80, 96]) {
          slider.value = String(v);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(30);
          samples.push({ v, a: glassAlpha(), s: sheen(), out: document.getElementById('fOpacityOut').textContent });
        }
        log.step8_samples = samples.map((x) => x.v + '→' + x.a.toFixed(3));
        log.step8_sliderAlive = document.getElementById('fOpacity') === slider && slider.isConnected;
        log.step8_readout = samples[2].out;
        log.step8_alphaUp = samples.every((x, i) => i === 0 || x.a > samples[i - 1].a);
        log.step8_sheenUp = samples.every((x, i) => i === 0 || x.s > samples[i - 1].s);
        log.step8_panelOpen = !document.getElementById('panel').hidden;
        log.step8_liveApplied = app.state.settings.glassOpacity === 0.96;

        // 预设按钮
        document.querySelector('#panelBody [data-preset="0.18"]').click();
        await wait(60);
        log.step8_preset = app.state.settings.glassOpacity === 0.18;
        log.step8_afterPresetAlpha = glassAlpha();

        // 9) 外观预设：一键换整套（玻璃基色 + 主题色 + 浓度）
        const tintBtn = (id) => document.querySelector('#panelBody [data-theme="' + id + '"]');
        const lightGlass = getComputedStyle(w).getPropertyValue('--glass-a').trim();
        tintBtn('ink').click();
        await wait(70);
        const darkGlass = getComputedStyle(w).getPropertyValue('--glass-a').trim();
        log.step9_light = lightGlass;
        log.step9_dark = darkGlass;
        log.step9_tintAttr = w.dataset.tint;
        log.step9_darkTint = darkGlass.split(' ').join('').indexOf('rgba(24,26,48,') === 0;
        tintBtn('mist').click();
        await wait(50);
        log.step9_backToLight = w.dataset.tint === 'light';

        // 10) 关闭系统模糊时（浏览器 / PWA 路径），页面这层承担全部浓度，
        //     滑块应能覆盖接近全透到接近全不透的完整区间
        const s2 = document.getElementById('fOpacity');
        app.state.desktop = { ...(app.state.desktop || {}), backdrop: 'none' };
        app.applyTheme();
        const web = [];
        for (const v of [8, 50, 96]) {
          s2.value = String(v);
          s2.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(25);
          web.push({ v, a: glassAlpha() });
        }
        log.step10_samples = web.map((x) => x.v + '→' + x.a.toFixed(2));
        log.step10_span = Number((web[2].a - web[0].a).toFixed(2));
        log.step10_minTransparent = web[0].a <= 0.1;

        // 11) 时长任务：解析 → 开始 → 倒计时 → 自动完成
        const pd = M.parseDuration('读书 一小时');
        log.step11_parseHour = pd.title === '读书' && pd.durationMs === 3600000;
        const pd2 = M.parseDuration('跑步30分钟');
        log.step11_parseMin = pd2.title === '跑步' && pd2.durationMs === 1800000;
        const pd3 = M.parseDuration('背单词');
        log.step11_noParse = pd3.title === '背单词' && pd3.durationMs === null;
        const pd4 = M.parseDuration('阅读 1.5小时');
        log.step11_parseHalf = pd4.title === '阅读' && pd4.durationMs === 5400000;

        app.state.tasks = [];
        app.render();
        const dur = M.createTask({ type: 'temp', title: '读书', durationMs: 60_000, deviceId: 'selftest' });
        app.state.tasks.push(dur);
        app.render();
        await wait(40);
        log.step11_hasStartBtn = !!document.querySelector('[data-act="start"]');

        // 点 ▶ 开始 → 进入计时中，并出现进度线
        document.querySelector('[data-act="start"]').click();
        await wait(60);
        const t1 = app.state.tasks.find((x) => x.id === dur.id);
        log.step11_timing = M.isTiming(t1) === true;
        log.step11_prog = !!document.querySelector('.prog');

        // 把结束时刻拨到过去 → 应自动标记完成
        const t2 = { ...t1, countdownTo: Date.now() - 500, updatedAt: Date.now() };
        app.state.tasks = app.state.tasks.map((x) => (x.id === t2.id ? t2 : x));
        app.checkAutoComplete();
        await wait(60);
        const t3 = app.state.tasks.find((x) => x.id === dur.id);
        log.step11_autoDone = M.isDone(t3) === true;

        // 玻璃质感：噪点层与受光边应已挂上
        log.step11_grain = getComputedStyle(document.getElementById('widget')).getPropertyValue('--grain').trim();
        log.step11_blur = getComputedStyle(document.getElementById('widget')).backdropFilter || 'none';

        app.state.tasks = [];
        app.state.settings.glassOpacity = 0.55;
        app.applyTheme();
        app.render();
        return {
          ready: true,
          env: document.body.className,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          ...log,
        };
      })()`
        )
        .catch((err) => ({ ready: false, error: err.message }));

      console.log('[selftest] ' + JSON.stringify(st, null, 0));

      // 层级自检（Node 侧）：先确保窗口是显示状态，否则命中测试没有意义
      // （autohide 模式在"桌面不在最前"时本来就该隐藏，所以要先停掉层级轮询）
      clearInterval(modeTimer);
      modeTimer = null;
      // 挪到屏幕左上角：若同一台机器上还跑着另一份 Onederz（默认位置在右下），
      // 两份会叠在同一处，命中测试会正确地报告"最上面不是我"——那是真话不是误报
      win.setPosition(0, 0);
      win.showInactive();
      await new Promise((r) => setTimeout(r, 900));
      const diag = (await diagnoseLayer().catch(() => null)) || {
        mode: cfg.mode,
        visible: false,
        desktopAttached: false,
        interactive: false,
        hitTarget: '(未取到)',
      };

      /**
       * 输入路径验证：注入真实鼠标事件（sendInputEvent）在 Electron 44 上会让
       * 渲染进程崩溃（"An object could not be cloned" → renderer crashed），
       * 所以这里用 DOM 级 click —— 步骤 3 已经断言过「点击复选框 → 进入已完成」。
       * 屏幕命中测试（WindowFromPoint）受环境影响大，只作提示不作失败项。
       */

      const checks = [
        ['渲染进程就绪', st.ready === true],
        ...(cfg.mode === 'desktop'
          ? [['桌面层挂载经真实窗口校验通过', diag.desktopAttached === true]]
          : []),
        ['窗口圆角已施加', lastRounding === '1' || lastRounding === '2'],
        ['通过界面添加常驻任务', st.step1_rows === 1],
        ['切换到临时类型', st.step2_addType === 'temp'],
        ['临时任务带倒计时徽标', !!st.step2_cdChip && st.step2_cdChip.startsWith('剩')],
        ['勾选后进入已完成', st.step3_done === 1 && st.step3_dailyDone === true],
        ['分区正确（常驻清零后只剩今日临时 + 已完成）', JSON.stringify(st.step3_sections) === '["今日临时1","已完成1"]'],
        ['进度百分比', st.step3_pct === '50%'],
        ['进度条宽度', st.step3_progress === '50%'],
        ['单条操作菜单可打开', st.step4_itemPop === true],
        ['点击空白可关闭菜单', st.step4_closed === true],
        ['设置面板可打开', st.step5_panel === true],
        ['设置面板含同步栏', st.step5_serverField === true],
        ['设置面板含桌面行为栏', st.step5_modeSelect === true],
        ['同步引擎可调用', st.step5_funcs === true],
        ['常驻任务跨天自动重置', st.step6_reopened === true],
        ['过期临时任务被清理', st.step7_cleaned === 1],
        ['滑动玻璃浓度时面板 DOM 不被重建', st.step8_sliderAlive === true],
        ['滑块实时生效（不落盘点也立即应用）', st.step8_liveApplied === true],
        ['浓度数值随之回显', st.step8_readout === '55%'],
        ['浓度越高玻璃越不透明（单调递增）', st.step8_alphaUp === true],
        ['顶部高光随浓度同向变化', st.step8_sheenUp === true],
        ['拖完滑块设置面板仍开着', st.step8_panelOpen === true],
        ['预设按钮生效', st.step8_preset === true],
        ['浅色玻璃基色正确', String(st.step9_light || '').replace(/\s/g, '').indexOf('rgba(255,255,255,') === 0],
        ['墨玉预设切到深靛蓝基色', st.step9_darkTint === true],
        ['预设可来回切换', st.step9_backToLight === true],
        ['无系统模糊时由页面承担浓度', st.step10_minTransparent === true],
        ['浓度可调范围足够宽（≥0.8）', st.step10_span >= 0.8],
        ['时长解析：一小时', st.step11_parseHour === true],
        ['时长解析：30分钟', st.step11_parseMin === true],
        ['时长解析：1.5小时', st.step11_parseHalf === true],
        ['无时长文字不改写标题', st.step11_noParse === true],
        ['设了时长的任务出现 ▶ 按钮', st.step11_hasStartBtn === true],
        ['点 ▶ 进入计时中', st.step11_timing === true],
        ['计时中出现进度线', st.step11_prog === true],
        ['倒计时走完自动标记完成', st.step11_autoDone === true],
        ['玻璃已挂噪点纹理层', Number(st.step11_grain) > 0],
      ];
      let bad = 0;
      for (const [name, pass] of checks) {
        console.log(`[selftest] ${pass ? '✓' : '✗'} ${name}`);
        if (!pass) bad++;
      }
      console.log(
        `[selftest] 模式=${cfg.mode} 磨砂=${cfg.backdrop} 圆角=${lastRounding}（${
          lastRounding === '1' ? 'DWM 平滑' : lastRounding === '2' ? '区域裁剪兜底' : '未生效'
        }）层级=${diag.mode} 命中=${diag.hitTarget} 通过 ${checks.length - bad}/${checks.length}`
      );
      // 命中测试只作提示（受环境影响），不作为失败项
      if (cfg.mode !== 'desktop' && !diag.interactive) {
        console.log('[selftest] ⓘ 屏幕命中测试未指向本窗口（通常是有别的窗口叠在上面，属环境因素，不影响功能）');
      }

      // 顺便产出文档用的界面截图（切到 env-web 让环境光晕当磨砂素材，图片自身可读）
      if (process.env.ONEDERZ_SHOT) {
        try {
          const outDir = path.join(__dirname, '..', '..', 'docs');
          fs.mkdirSync(outDir, { recursive: true });
          const shots = [
            ['晨雾', 'light', '236,240,255', 0.6, 'screenshot-light', false],
            ['墨玉', 'dark', '24,26,48', 0.78, 'glass-ink', false],
            ['琥珀', 'light', '255,213,158', 0.62, 'glass-amber', false],
            ['松石', 'light', '196,240,229', 0.6, 'glass-jade', false],
            ['墨玉', 'dark', '24,26,48', 0.78, 'glass-dark-thick', false],
            ['晨雾', 'light', '236,240,255', 0.6, 'glass-settings', true],
          ];
          for (const [name, tint, glassBase, density, file, showPanel] of shots) {
            await win.webContents.executeJavaScript(`(() => {
              const app = window.onederzApp;
              const M = app.M;
              document.body.classList.remove('env-desktop');
              document.body.classList.add('env-web');
              // 截图要呈现"没有系统级模糊"时浏览器端的真实观感：
              // 此时玻璃浓度完全由页面这层承担，滑块效果才看得见
              app.state.desktop = null;
              app.state.settings.theme = '${name === '墨玉' ? 'ink' : name === '琥珀' ? 'amber' : name === '松石' ? 'jade' : 'mist'}';
              app.state.settings.tint = '${tint}';
              app.state.settings.glassBase = '${glassBase}';
              app.state.settings.glassOpacity = ${density};
              app.state.tasks = [
                M.createTask({ type: 'daily', title: '晨会 · 同步上周进度', deviceId: 'shot' }),
                M.createTask({ type: 'daily', title: '喝够八杯水', deviceId: 'shot' }),
                M.createTask({ type: 'temp', title: '读书', note: '番茄钟，专注一轮', durationMs: 1500000, deviceId: 'shot' }),
                M.createTask({ type: 'temp', title: '14:00 牙医预约', note: '带上上次的检查报告', remindAt: Date.now() + 3600000, deviceId: 'shot' }),
                M.createTask({ type: 'temp', title: '提交季度报销单', countdownTo: Date.now() + 5400000, deviceId: 'shot' }),
                M.setDone(M.createTask({ type: 'daily', title: '给团队同步进度', deviceId: 'shot' }), true),
              ];
              app.applyTheme();
              app.render();
              // 复位自检残留：关掉面板与弹层、清掉提示气泡，列表回到顶部
              app.closePanel();
              document.querySelectorAll('.pop').forEach((p) => (p.hidden = true));
              document.getElementById('toastWrap').style.display = 'none';
              document.getElementById('list').scrollTop = 0;
              const wg = document.getElementById('widget');
              if (${file === 'glass-ink'}) {
                // 让动态高光在截图里可见：光斑固定在右上、并强制点亮
                wg.style.setProperty('--mx', '268px');
                wg.style.setProperty('--my', '96px');
                const spec = wg.querySelector('.spec');
                if (spec) spec.style.opacity = '1';
              }
              if (${showPanel}) {
                app.openPanel();
                const body = document.getElementById('panelBody');
                const grp = [...body.querySelectorAll('.grp')].find((g) =>
                  g.querySelector('h3') && g.querySelector('h3').textContent.indexOf('背景玻璃') >= 0
                );
                // 用 rect 差值算偏移：offsetTop 的参照物是 .panel 而不是滚动容器
                if (grp) {
                  body.scrollTop =
                    grp.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12;
                }
              }
              return document.querySelectorAll('.row').length;
            })()`);
            await new Promise((r) => setTimeout(r, 520));
            const img = await win.webContents.capturePage();
            const out = path.join(outDir, `${file}.png`);
            fs.writeFileSync(out, img.toPNG());
            console.log(`[selftest] 截图 ${name} ${Math.round(density * 100)}%${showPanel ? ' · 设置面板' : ''} → ${out}`);
          }
        } catch (err) {
          console.warn('[selftest] 截图失败：', err.message);
        }
      }

      app.exit(bad === 0 ? 0 : 1);
    }, 9000);
  }
});

function createWindow() {
  const cfg = config.load();
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const W = 344;
  const H = 486;

  const b = cfg.bounds || {};
  const bounds = {
    width: clamp(b.width || W, cfg.minWidth, 2400),
    height: clamp(b.height || H, cfg.minHeight, 2000),
    x: clamp(b.x ?? area.x + area.width - W - 28, -4000, 8000),
    y: clamp(b.y ?? area.y + Math.round(area.height * 0.16), -4000, 8000),
  };

  win = new BrowserWindow({
    ...bounds,
    minWidth: cfg.minWidth,
    minHeight: cfg.minHeight,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'Onederz',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.loadURL(staticSrv.url + 'index.html');

  // 原生宿主预热（内含一次 C# 编译，约几百毫秒），与页面加载并行
  native.warmup();

  win.once('ready-to-show', async () => {
    await applyNativeLayer({ firstRun: true });
    win.showInactive();
    // DWM 圆角在窗口真正显示后再补一次更稳（部分机器首次调用会返回失败）
    if (config.load().applyRounding) {
      setTimeout(() => native.applyRounded(win, 22), 700);
    }
  });

  // 位置/尺寸变化时持久化
  const persistBounds = debounce(() => {
    if (!win || win.isDestroyed() || session) return;
    config.save({ bounds: win.getBounds() });
  }, 420);
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  // 不允许导航到外部页面，外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(staticSrv.url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });

  // 自检模式：收集渲染进程控制台输出，短暂运行后自动退出（用于无人值守验证）
  if (SELFTEST) {
    // Electron 35 起 console-message 改成了单一 event 对象，这里兼容新旧两种签名
    win.webContents.on('console-message', (...args) => {
      let level, message, line, source;
      if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
        ({ level, message, lineNumber: line, sourceId: source } = args[0]);
      } else {
        [, level, message, line, source] = args;
        level = ['debug', 'info', 'warn', 'error'][level] || level;
      }
      const where = source ? ` (${path.basename(source)}:${line})` : '';
      console.log(`[renderer:${level}] ${message}${where}`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer] 进程异常', d));
  }

  win.on('closed', () => {
    win = null;
  });
}

/* ---------------------- 原生层：磨砂 + 圆角 + 桌面层 ---------------------- */

/**
 * @param {{firstRun?: boolean, force?: boolean}} opts
 */
async function applyNativeLayer(opts = {}) {
  if (!win || win.isDestroyed()) return;
  const cfg = config.load();
  const report = { backdrop: null, rounding: null, mode: cfg.mode, desktop: null };

  // 施加任何原生效果之前先探一次，作为对照基线
  if (isDev || SELFTEST) {
    const before = await native.probeLayer(win).catch(() => null);
    if (before) console.log('[diag:before] chain=' + before.chain + ' selfClass=' + before.selfClass);
  }

  // 1) 磨砂玻璃（fill = 目标不透明度、base = 玻璃基色，都由外观预设给出）
  report.backdrop = await native.applyBackdrop(win, {
    backdrop: cfg.backdrop,
    fill: cfg.opacity,
    base: cfg.glassBase,
    tint: cfg.tint,
  });

  let mode = cfg.mode;

  // 2) 先做系统圆角 —— 此刻窗口还是顶层窗口，DWM 圆角只对顶层窗口生效。
  //    等挂进桌面层（变成子窗口）之后再调就会被拒绝，只能退回区域裁剪（有锯齿）。
  if (cfg.applyRounding) {
    report.rounding = await native.applyRounded(win, 22);
    lastRounding = report.rounding;
  }

  // 3) 显示层级
  if (mode === 'desktop') {
    const r = await native.attachToDesktop(win);
    report.desktop = r;

    // SetParent 调用成功 ≠ 真的生效：Electron 透明窗口在 Windows 上有两个
    // Chrome_WidgetWin_1，getNativeWindowHandle() 给的那个不承载内容。
    // 必须用"承载内容窗口的祖先链"复核，否则会报出"已挂载"的假象。
    let verified = false;
    let why = r.reason || '未知原因';
    if (r.ok) {
      if (r.kind !== 'workerw') {
        why = '当前系统的桌面层只有 Progman，没有可挂载的 WorkerW 壁纸层';
      } else {
        const probe = await native.probeLayer(win);
        verified = !!probe.chain && probe.chain.includes('@' + r.target);
        if (!verified) why = 'SetParent 未作用到承载内容的窗口';
      }
    }
    report.desktopVerified = verified;
    lastAttachOk = verified;

    if (!verified) {
      // 降级为"跟随桌面显隐"：用户可见行为一致（打开其他应用即隐藏、回到桌面即出现）
      console.warn(`[mode] 桌面层不可用（${why}），改用跟随桌面显隐`);
      mode = 'autohide';
      config.save({ mode });
      degradedReason = why;
    } else {
      win.setAlwaysOnTop(false);
    }
  } else {
    await native.detachFromDesktop(win);
    lastAttachOk = false;
  }

  if (mode === 'top') {
    win.setAlwaysOnTop(true, 'screen-saver');
    await native.setZOrder(win, 'top');
  } else if (mode === 'bottom') {
    win.setAlwaysOnTop(false);
    await native.setZOrder(win, 'bottom');
  } else {
    win.setAlwaysOnTop(false);
  }

  // DWM 有时要等窗口真正显示后才接受圆角设置，补几次；成功就不再动
  if (cfg.applyRounding && report.rounding !== '1') {
    scheduleRoundingRetry();
  }

  applyModeLoop(mode);
  refreshTrayMenu();
  sendConfig();

  // 窗口显示后做一次层级自检：确认挂上了、而且还能点
  setTimeout(() => {
    diagnoseLayer()
      .then((d) => {
        if (!d) return;
        if (isDev) console.log('[diag]', JSON.stringify(d));
        if (d.mode === 'desktop' && d.desktopAttached && !d.interactive) {
          console.warn('[diag] 已挂桌面层但命中的是 ' + d.hitTarget + '，点击可能被桌面图标层吃掉');
        }
      })
      .catch(() => {});
  }, 1800);

  if (degradedReason) {
    send('mode-fallback', { from: 'desktop', to: mode, reason: degradedReason });
    degradedReason = null;
  }
  if (isDev) console.log('[native]', JSON.stringify(report));
  return report;
}

/** 圆角兜底重试：DWM 圆角比区域裁剪平滑得多，值得多试几次 */
let roundTimer = null;
function scheduleRoundingRetry() {
  clearTimeout(roundTimer);
  const at = [800, 2200, 5000]; // 累计时间点
  let idx = 0;
  const next = () => {
    if (idx >= at.length || !win || win.isDestroyed()) return;
    const delay = at[idx] - (at[idx - 1] || 0);
    idx++;
    roundTimer = setTimeout(async () => {
      if (!win || win.isDestroyed()) return;
      const m = await native.applyRounded(win, 22);
      if (m === '1') return; // DWM 生效，收工
      next();
    }, delay);
  };
  next();
}

/**
 * 层级自检：确认部件真的在桌面层上、而且还能点。
 * 挂进桌面层后窗口会变成桌面的子窗口，若被桌面图标层盖住就会
 * "看得见但点不动"——这个检查专门防这种静默失效。
 */
async function diagnoseLayer() {
  if (!win || win.isDestroyed()) return null;
  const cfg = config.load();
  const probe = await native.probeLayer(win);
  const eb = win.getBounds();
  lastDiag = {
    mode: cfg.mode,
    visible: win.isVisible(),
    desktopAttached: cfg.mode === 'desktop' ? lastAttachOk : false,
    interactive: probe.ours,
    hitTarget: probe.hitClass,
    selfClass: probe.selfClass,
    selfHandle: probe.selfHandle,
    selfParent: probe.selfParent,
    hitHandle: probe.hitHandle,
    chain: probe.chain,
    winRect: probe.rect,
    ebBounds: { x: eb.x, y: eb.y, w: eb.width, h: eb.height },
  };
  return lastDiag;
}

/**
 * 层级维持循环。三种模式各自的"显示/隐藏逻辑"：
 *
 *   desktop  已挂到桌面层 → 由系统负责，无需轮询。
 *            与系统桌面部件完全一致：被其他窗口自然盖住，按 Win+D 时一起出现。
 *   autohide 跟随桌面显隐 —— 前台窗口是桌面 / 开始菜单 / 任务栏 / 本部件时显示，
 *            打开其他应用或网页时自动隐藏。这是挂不上桌面层时的等价降级方案。
 *   bottom   一直可见，但周期性把自己压回最底层，保证永远被其他窗口盖住
 *            （不抢焦点、不出现在任务栏）。
 *   top      一直置顶。
 */
function applyModeLoop(mode) {
  clearInterval(modeTimer);
  modeTimer = null;
  if (!win || win.isDestroyed()) return;

  if (mode === 'autohide') {
    modeTimer = setInterval(async () => {
      if (!win || win.isDestroyed() || session || userHidden) return;
      const onTop = await native.isDesktopOnTop(win);
      if (onTop && !win.isVisible()) win.showInactive();
      else if (!onTop && win.isVisible()) win.hide();
    }, 520);
    return;
  }

  if (mode === 'bottom') {
    modeTimer = setInterval(async () => {
      if (!win || win.isDestroyed() || session) return;
      await native.setZOrder(win, 'bottom');
    }, 700);
  }

  if (!userHidden && !win.isVisible()) win.showInactive();
}

/* ============================== 托盘 ============================== */

function createTray() {
  const iconPath = path.join(resolveAppDir(), 'icon-192.png');
  let image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Onederz · 今日待办');
  refreshTrayMenu();
  tray.on('click', () => toggleVisibility());
}

function refreshTrayMenu() {
  if (!tray) return;
  const cfg = config.load();
  const visible = !!win && !win.isDestroyed() && win.isVisible();

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? '隐藏部件' : '显示部件', click: () => toggleVisibility(), accelerator: cfg.hotkey },
      { type: 'separator' },
      {
        label: '显示层级',
        submenu: [
          { label: '跟随桌面显示 / 隐藏（推荐）', type: 'radio', checked: cfg.mode === 'autohide', click: () => setMode('autohide') },
          { label: '普通窗口 · 一直显示在最底层', type: 'radio', checked: cfg.mode === 'bottom', click: () => setMode('bottom') },
          { label: '始终置顶', type: 'radio', checked: cfg.mode === 'top', click: () => setMode('top') },
          { type: 'separator' },
          {
            label: '桌面层挂载（实验性，失败会自动回落）',
            type: 'radio',
            checked: cfg.mode === 'desktop',
            click: () => setMode('desktop'),
          },
        ],
      },
      {
        label: '磨砂效果',
        submenu: [
          { label: '系统亚克力（推荐）', type: 'radio', checked: cfg.backdrop === 'acrylic', click: () => setBackdrop('acrylic') },
          { label: '仅模糊（性能更好）', type: 'radio', checked: cfg.backdrop === 'blur', click: () => setBackdrop('blur') },
          { label: '关闭系统模糊', type: 'radio', checked: cfg.backdrop === 'none', click: () => setBackdrop('none') },
        ],
      },
      { type: 'separator' },
      { label: '打开设置与同步', click: () => send('open-settings') },
      { label: '立即聚焦输入框', click: () => send('focus-input') },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: !!cfg.autoStart,
        click: (item) => {
          config.save({ autoStart: item.checked });
          applyAutoStart();
          refreshTrayMenu();
        },
      },
      { type: 'separator' },
      { label: '重新加载界面', click: () => win?.webContents.reload() },
      { label: '打开开发者工具', click: () => win?.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: '退出 Onederz', click: () => quitApp() },
    ])
  );
}

/* ============================ 行为封装 ============================ */

function toggleVisibility() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
    userHidden = true;
  } else {
    userHidden = false;
    win.showInactive();
  }
  refreshTrayMenu();
}

function send(cmd, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('app:command', { cmd, payload });
}

function sendConfig() {
  if (win && !win.isDestroyed()) win.webContents.send('app:config', config.load());
}

async function setMode(mode) {
  config.save({ mode });
  userHidden = false;
  await applyNativeLayer();
  return { ok: true, mode: config.load().mode };
}

async function setBackdrop(backdrop) {
  config.save({ backdrop });
  const cfgNow = config.load();
  const r = await native.applyBackdrop(win, { backdrop, fill: cfgNow.opacity, tint: cfgNow.tint });
  refreshTrayMenu();
  return r;
}

function applyAutoStart() {
  const cfg = config.load();
  try {
    app.setLoginItemSettings({
      openAtLogin: !!cfg.autoStart,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.join(__dirname, '..')],
    });
  } catch (err) {
    console.warn('[autostart]', err.message);
  }
}

function registerHotkey() {
  const { globalShortcut } = require('electron');
  const cfg = config.load();
  try {
    globalShortcut.register(cfg.hotkey || 'Alt+Space', () => toggleVisibility());
  } catch (err) {
    console.warn('[hotkey] 注册失败：', err.message);
  }
}

function quitApp() {
  config.save({ bounds: win && !win.isDestroyed() ? win.getBounds() : config.load().bounds });
  app.isQuitting = true;
  app.quit();
}

/* ============================== IPC ============================== */

let backdropTimer = null;
ipcMain.handle('app:get-config', () => config.load());
ipcMain.on('app:set-config', (_e, patch) => {
  // 注意：这里刻意不回推 config，否则会和渲染进程的 applyTheme 形成回声死循环。
  // 由托盘 / 原生层发起的变更才通过 sendConfig() 广播。
  const prev = config.load();
  config.save(patch);
  const tintChanged = 'tint' in patch && patch.tint !== prev.tint;
  const opacityChanged = 'opacity' in patch && Number(patch.opacity) !== Number(prev.opacity);
  const baseChanged = 'glassBase' in patch && String(patch.glassBase) !== String(prev.glassBase);
  if (tintChanged || opacityChanged || baseChanged) {
    clearTimeout(backdropTimer);
    backdropTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const cfg = config.load();
      native.applyBackdrop(win, {
        backdrop: cfg.backdrop,
        fill: cfg.opacity,
        base: cfg.glassBase,
        tint: cfg.tint,
      });
    }, 180);
  }
});

ipcMain.on('win:drag-start', () => {
  if (!win || win.isDestroyed()) return;
  // 拖动进行中不允许再进入缩放，反之亦然 —— 两种会话互斥
  if (session) return;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  session = { kind: 'drag', cursor, bounds: b };
  startCursorLoop();
});

/**
 * 拖动只改位置，**绝不改尺寸**。
 *
 * 这里刻意用 setBounds 把宽高一起写回去，而不是 setPosition：
 * 之前用户反馈"拖动时窗口先变宽再变高"，如果根因是系统/DPI 在
 * SetWindowPos 往返里偷偷改了尺寸，setPosition 就拦不住；
 * 每帧把宽高写回，等于强制钉死。同时把漂移打印出来，便于定位真因。
 */
let dragDriftWarned = false;
function applyDrag() {
  if (!session || session.kind !== 'drag' || !win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const dx = p.x - session.cursor.x;
  const dy = p.y - session.cursor.y;
  const want = {
    x: Math.round(session.bounds.x + dx),
    y: Math.round(session.bounds.y + dy),
    width: session.bounds.width,
    height: session.bounds.height,
  };
  win.setBounds(want);

  const now = win.getBounds();
  if (now.width !== want.width || now.height !== want.height) {
    if (!dragDriftWarned) {
      dragDriftWarned = true;
      const dpi = screen.getDisplayMatching(now).scaleFactor;
      console.warn(
        `[drag] 拖动时检测到尺寸漂移：期望 ${want.width}x${want.height}，实际 ${now.width}x${now.height}，` +
          `DPI=${dpi}。已强制写回，请把这条日志发我以定位根因。`
      );
    }
    win.setBounds(want);
  }
}

ipcMain.on('win:drag-move', () => applyDrag());

ipcMain.on('win:drag-end', () => {
  endSession();
});

ipcMain.on('win:resize-start', (_e, dir) => {
  if (!win || win.isDestroyed()) return;
  session = { kind: 'resize', dir: String(dir || 'se'), cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() };
  startCursorLoop();
});

ipcMain.on('win:resize-move', () => applyResize());

function applyResize() {
  if (!session || session.kind !== 'resize' || !win || win.isDestroyed()) return;
  const cfg = config.load();
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - session.cursor.x;
  const dy = cursor.y - session.cursor.y;
  const b = { ...session.bounds };
  const dir = session.dir;

  if (dir.includes('e')) b.width = session.bounds.width + dx;
  if (dir.includes('s')) b.height = session.bounds.height + dy;
  if (dir.includes('w')) {
    b.width = session.bounds.width - dx;
    b.x = session.bounds.x + dx;
  }
  if (dir.includes('n')) {
    b.height = session.bounds.height - dy;
    b.y = session.bounds.y + dy;
  }

  // 达到最小尺寸时钳住，避免窗口位置被继续拖走
  if (b.width < cfg.minWidth) {
    if (dir.includes('w')) b.x = session.bounds.x + (session.bounds.width - cfg.minWidth);
    b.width = cfg.minWidth;
  }
  if (b.height < cfg.minHeight) {
    if (dir.includes('n')) b.y = session.bounds.y + (session.bounds.height - cfg.minHeight);
    b.height = cfg.minHeight;
  }

  win.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });
}

ipcMain.on('win:resize-end', async () => {
  endSession();
  // 区域裁剪圆角依赖尺寸，缩放后重新施加一次
  if (config.load().applyRounding) await native.applyRounded(win, 22);
});

ipcMain.on('win:hide', () => {
  win?.hide();
  userHidden = true;
  refreshTrayMenu();
});
ipcMain.on('win:show', () => {
  userHidden = false;
  win?.showInactive();
  refreshTrayMenu();
});
ipcMain.on('win:minimize', () => win?.minimize());

ipcMain.handle('win:set-mode', (_e, mode) => setMode(mode));
ipcMain.handle('win:set-backdrop', (_e, bd) => setBackdrop(bd));
ipcMain.handle('win:apply-native', () => applyNativeLayer());
ipcMain.handle('win:diagnose', () => diagnoseLayer());

ipcMain.handle('app:set-auto-start', (_e, flag) => {
  config.save({ autoStart: !!flag });
  applyAutoStart();
  refreshTrayMenu();
  return { ok: true };
});

ipcMain.handle('app:save-file', async (_e, { name, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出 Onederz 备份',
    defaultPath: name || 'onederz-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
});

ipcMain.on('app:notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    win?.showInactive();
    win?.focus();
  });
  n.show();
});

ipcMain.on('app:quit', () => quitApp());

/* -------------------------- 拖拽时的光标跟催 -------------------------- */
/**
 * 渲染进程的 pointermove 在光标移出窗口后会停止触发，
 * 这里在主进程侧按帧读取屏幕光标位置补齐，保证拖拽顺滑连续。
 */
function startCursorLoop() {
  stopCursorLoop();
  const last = { x: NaN, y: NaN };
  cursorTimer = setInterval(() => {
    if (!session) return stopCursorLoop();
    const p = screen.getCursorScreenPoint();
    if (p.x === last.x && p.y === last.y) return;
    last.x = p.x;
    last.y = p.y;
    if (session.kind === 'drag') {
      applyDrag(); // 与渲染进程的 drag-move 走同一份逻辑：只改位置、钉死宽高
    } else {
      applyResize();
    }
  }, 16);
}

function stopCursorLoop() {
  clearInterval(cursorTimer);
  cursorTimer = null;
}

function endSession() {
  if (!session) return;
  session = null;
  stopCursorLoop();
  if (win && !win.isDestroyed()) config.save({ bounds: win.getBounds() });
}

/* ============================== 工具 ============================== */

function clamp(v, min, max) {
  return Math.min(Math.max(Number(v) || 0, min), max);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ============================ 生命周期 ============================ */

app.on('window-all-closed', (e) => {
  // 关闭窗口不退出，部件常驻托盘
  e.preventDefault?.();
});
app.on('activate', () => {
  if (!win) createWindow();
  else win.showInactive();
});
app.on('before-quit', () => {
  session = null;
  stopCursorLoop();
  clearInterval(modeTimer);
  clearLockFile();
  native.shutdownHost();
  staticSrv?.close();
  // 只收掉自己拉起的服务；复用别人的就别动
  if (serverChild) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(serverChild.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        serverChild.kill('SIGTERM');
      }
    } catch {
      /* noop */
    }
  }
  const { globalShortcut } = require('electron');
  globalShortcut.unregisterAll();
});
