/**
 * Onederz · 主控制器
 * ---------------------------------------------------------------
 * 负责把「数据模型 / 本地存储 / 同步引擎 / 渲染层」串起来，并处理
 * 所有交互：添加、勾选、编辑、删除、提醒、倒计时、跨天维护、窗口拖拽缩放。
 *
 * 三端共用：Windows(Electron) / Android(Capacitor) / 浏览器 PWA
 * 差异只有 window.onederz（Electron 预加载注入的原生能力）是否存在。
 */

import * as M from './lib/model.js';
import * as store from './lib/store.js';
import { SyncEngine, probeServer } from './lib/sync.js';
import { ensurePermission, systemNotify, chime, haptic } from './lib/notify.js';
import { renderList, renderHeader, renderSync, escapeHtml as esc } from './ui/render.js';
import { renderPanel } from './ui/panels.js';

/* ============================== 环境 ============================== */
const native = window.onederz || null; // Electron 预加载注入
const params = new URLSearchParams(location.search);
const isOverlay = params.get('overlay') === '1'; // Android 原生悬浮窗里的 WebView
const isAndroid = /Android/i.test(navigator.userAgent) || !!window.Capacitor;
const isDesktop = !!native;

// env-desktop  系统亚克力，页面全透明
// env-android  手机 App / PWA，铺环境光晕当磨砂素材
// env-overlay  Android 悬浮窗，由系统做窗口级模糊，页面全透明
document.body.classList.add(
  isDesktop ? 'env-desktop' : isOverlay ? 'env-android-overlay' : isAndroid ? 'env-android' : 'env-web'
);

/* ============================== 元素 ============================== */
const $ = (id) => document.getElementById(id);
const el = {
  widget: $('widget'),
  bar: $('bar'),
  list: $('list'),
  input: $('input'),
  typeSeg: $('typeSeg'),
  btnAdd: $('btnAdd'),
  btnAt: $('btnAt'),
  btnCd: $('btnCd'),
  ringFg: $('ringFg'),
  ringTxt: $('ringTxt'),
  dateText: $('dateText'),
  pendingText: $('pendingText'),
  progressBar: $('progressBar'),
  syncState: $('syncState'),
  syncText: $('syncText'),
  itemPop: $('itemPop'),
  mainPop: $('mainPop'),
  timePop: $('timePop'),
  timePopHead: $('timePopHead'),
  timeQuick: $('timeQuick'),
  timeInput: $('timeInput'),
  timeOk: $('timeOk'),
  timeRow: $('timeRow'),
  durRow: $('durRow'),
  durInput: $('durInput'),
  durOk: $('durOk'),
  timeTip: $('timeTip'),
  btnDur: $('btnDur'),
  panel: $('panel'),
  panelBody: $('panelBody'),
  panelTitle: $('panelTitle'),
  toastWrap: $('toastWrap'),
  btnCollapse: $('btnCollapse'),
  btnMenu: $('btnMenu'),
  btnHide: $('btnHide'),
  panelBack: $('panelBack'),
};

/* ============================== 状态 ============================== */
const MODE_LABEL = {
  autohide: '跟随桌面显示 / 隐藏',
  bottom: '普通窗口 · 一直显示在最底层',
  top: '始终置顶',
  desktop: '桌面层挂载（实验性）',
};
const BACKDROP_LABEL = { acrylic: '系统亚克力', blur: '仅模糊', none: '已关闭系统模糊' };

const state = {
  tasks: [],
  settings: store.loadSettings(),
  meta: store.loadMeta(),
  grouped: { daily: [], temp: [], done: [], total: 0, doneCount: 0 },
  editingId: null,
  addType: 'daily',
  popTaskId: null,
  timePopMode: null, // 'remind' | 'countdown'
  offsetFor: null, // 记录时间弹窗当前作用的任务 / 新建预设
  panelOpen: false,
  pendingAdd: { remindAt: null, countdownTo: null },
  collapsed: false,
  // 仅桌面端：外壳（Electron）侧的窗口行为配置
  desktop: null,
  // 仅 Android：原生悬浮窗插件状态
  android: null,
};

/* Android 悬浮窗插件（由 Capacitor 注入，未安装时为 null） */
const floating = window.Capacitor?.Plugins?.FloatingWidget || null;

async function refreshFloating() {
  if (!floating) return null;
  try {
    const st = await floating.isGranted();
    state.android = { granted: !!st.granted, running: !!st.running };
  } catch {
    state.android = { granted: false, running: false };
  }
  return state.android;
}

// 设备标识（用于同步时的冲突兜底与来源追溯）
if (!state.settings.deviceId) {
  state.settings.deviceId = M.uid('dev');
  state.settings.deviceName = isDesktop ? 'Windows 电脑' : isAndroid ? 'Android 手机' : '浏览器';
  store.saveSettings(state.settings);
}

/* ============================== 同步引擎 ============================== */
const engine = new SyncEngine({
  getTasks: () => state.tasks,
  getSettings: () => state.settings,
  patchSettings: (patch) => patchSettings(patch),
  applyTasks: (tasks, applied) => {
    state.tasks = tasks;
    store.saveTasks(state.tasks);
    render();
    if (applied.length && !applied.some((t) => t.deviceId === state.settings.deviceId)) {
      renderSyncBadge('online');
    }
  },
  onStatus: (s) => {
    syncStatus = s.status;
    syncError = s.lastError;
    renderSyncBadge();
  },
  onEvent: (msg) => {
    if (msg.type === 'remote-change') {
      toast('已同步', `其他设备更新了 ${msg.count} 项待办`, 'sync');
    }
  },
});
let syncStatus = 'offline';
let syncError = null;

/* ============================== 渲染 ============================== */
function render() {
  const now = Date.now();
  const today = M.dayKey(new Date(now));
  state.grouped = M.groupTasks(state.tasks, today);
  renderList(el.list, {
    grouped: state.grouped,
    now,
    today,
    editingId: state.editingId,
    addType: state.addType,
    hideCompleted: state.settings.hideCompleted,
  });
  renderHeader(el, { grouped: state.grouped, now });
  renderSyncBadge();
}

function renderSyncBadge(force) {
  renderSync(
    { syncState: el.syncState, syncText: el.syncText },
    force || syncStatus,
    syncError,
    state.meta.lastSyncAt
  );
}

/** 每秒只更新倒计时/提醒文案，不做整体重绘 */
function tickChips() {
  const now = Date.now();
  const today = M.dayKey(new Date(now));
  el.list.querySelectorAll('.row[data-id]').forEach((row) => {
    const task = state.tasks.find((t) => t.id === row.dataset.id);
    if (!task) return;
    const cd = row.querySelector('.chip.cd');
    if (cd && task.countdownTo) {
      const ms = task.countdownTo - now;
      const lvl = M.countdownLevel(ms);
      const txt = M.formatCountdown(ms);
      const svg = cd.querySelector('svg')?.outerHTML || '';
      if (cd.dataset.v !== txt + lvl) {
        cd.dataset.v = txt + lvl;
        cd.className = `chip cd ${lvl}`;
        cd.innerHTML = svg + esc(txt);
      }
    }
    const rm = row.querySelector('.chip.rm');
    if (rm) {
      const fired = task.remindFiredOn === today;
      rm.classList.toggle('fired', fired);
    }
  });
}

/* ============================== 持久化 ============================== */
function persist() {
  store.saveTasks(state.tasks);
}

/**
 * 提交一组设置变更：需要重绘列表与设置面板的场景走这里（点按钮、切换开关）。
 * 滑动条这类高频、连续的操作请用 liveSettings()，否则拖到一半 DOM 就被换掉了。
 */
function patchSettings(patch) {
  Object.assign(state.settings, patch);
  store.saveSettings(state.settings);
  applyTheme();
  if (state.panelOpen) renderPanelNow();
  render();
  return state.settings;
}

/**
 * 连续调节用的轻量通道：只改样式、保存、通知外壳，**不重建任何 DOM**。
 * 拖动滑块时每帧都会走这里，所以必须便宜。
 */
let saveTimer = null;
function liveSettings(patch) {
  Object.assign(state.settings, patch);
  applyTheme();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveSettings(state.settings), 260);
  return state.settings;
}

/* ------------------------- 玻璃浓度（核心外观） -------------------------
 * 三端由同一个滑块驱动，但"谁来承担不透明度"不同：
 *
 *   Windows 桌面端      系统亚克力本身就是这块面板的填充 → 页面只留一层极薄的色膜，
 *                       滑块 1:1 映射到亚克力的 alpha，避免"雾上加雾"；
 *   Android 悬浮窗      原生只提供模糊、不透传浓度 → 由页面这层承担滑块；
 *   浏览器 / Android App / 关闭系统模糊
 *                       页面这层就是全部，滑块直接映射到自身 alpha。
 * -------------------------------------------------------------------- */
const GLASS_MIN = 0.08;
const GLASS_MAX = 0.96;

function glassLayers(opacity) {
  const o = Math.min(Math.max(Number(opacity) || 0.55, GLASS_MIN), GLASS_MAX);
  const systemFill = isDesktop && state.desktop && state.desktop.backdrop !== 'none';
  const cssAlpha = systemFill ? 0.05 + 0.10 * o : o;
  return { o, cssAlpha, systemFill };
}

function applyTheme() {
  const s = state.settings;
  const tint = s.tint || 'light';
  const { o, cssAlpha } = glassLayers(s.glassOpacity);

  el.widget.dataset.tint = tint;
  el.widget.dataset.hidedone = s.hideCompleted ? '1' : '0';
  // 让环境光底色跟随玻璃明暗与外观预设（浏览器 / Android 端需要，桌面端由系统壁纸决定）。
  // 用 data-glass / data-theme，避免和 #widget 上的 data-tint 撞选择器。
  document.body.dataset.glass = tint;
  document.body.dataset.theme = s.theme || 'mist';
  document.documentElement.style.setProperty('--accent', s.accent || '#5b6bff');

  const light = tint === 'light';
  // 玻璃基色由外观预设（晨雾/琥珀/松石/墨玉…）决定，不再写死白或深灰
  const base = s.glassBase || (light ? '255,255,255' : '28,31,52');
  el.widget.style.setProperty('--glass-a', `rgba(${base},${cssAlpha.toFixed(3)})`);
  el.widget.style.setProperty('--glass-b', `rgba(${base},${(cssAlpha * 0.72).toFixed(3)})`);
  // 顶部高光随浓度变化：越厚越亮，越透越弱
  const sheen = light ? 0.03 + 0.20 * cssAlpha : 0.015 + 0.075 * cssAlpha;
  el.widget.style.setProperty('--sheen', sheen.toFixed(3));
  // 动态高光开关
  el.widget.style.setProperty('--spec-on', s.dynamicSheen === false ? '0' : '1');

  // 同步给桌面外壳（去重，避免与外壳广播形成回声）
  const sig = `${tint}|${o}|${s.accent}|${s.glassBase}`;
  if (native && sig !== applyTheme.last) {
    applyTheme.last = sig;
    native.setConfig({ tint, opacity: o, accent: s.accent, glassBase: s.glassBase });
  }
}

/* ============================== 任务操作 ============================== */
function upsert(task) {
  const t = M.normalizeTask(task);
  const i = state.tasks.findIndex((x) => x.id === t.id);
  if (i >= 0) state.tasks[i] = t;
  else state.tasks.push(t);
  persist();
  engine.queue(t);
  render();
  return t;
}

function addTask() {
  let title = el.input.value.trim();
  if (!title) {
    el.input.focus();
    return;
  }

  let durationMs = state.pendingAdd.durationMs;
  // 没显式设时长时，试着从文字里解析 —— "读书 一小时" 这种写法直接可用
  if (durationMs == null) {
    const parsed = M.parseDuration(title);
    if (parsed.durationMs) {
      durationMs = parsed.durationMs;
      title = parsed.title;
      toast('已识别时长', `${parsed.title} · ${M.durationText(durationMs)}`, 'ok', 2600);
    }
  }

  const task = M.createTask({
    type: state.addType,
    title,
    deviceId: state.settings.deviceId,
    remindAt: state.pendingAdd.remindAt,
    countdownTo: state.pendingAdd.countdownTo,
    durationMs,
  });
  upsert(task);
  el.input.value = '';
  state.pendingAdd = { remindAt: null, countdownTo: null, durationMs: null };
  updateComposerChips();
  haptic(10);
  el.list.scrollTop = el.list.scrollHeight;
}

function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const today = M.dayKey();
  upsert(M.setDone(t, !M.isDone(t, today)));
  haptic(8);
}

function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  upsert({ ...t, deleted: true, updatedAt: Date.now() });
  toast('已删除', esc(t.title).slice(0, 40), 'del');
}

/** 开始计时：以现在为起点倒数，走完自动标记完成 */
function startTiming(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || !t.durationMs) return;
  upsert(M.startTask(t));
  haptic(12);
  toast('开始计时', `${t.title} · ${M.durationText(t.durationMs)}`, 'ok', 2600);
}

/** 停止计时：保留剩余时长，下次接着用 */
function stopTiming(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  upsert(M.stopTask(t));
  toast('已停止计时', t.title, 'ok', 2200);
}

function clearDone() {
  const today = M.dayKey();
  const n = state.tasks.filter((t) => !t.deleted && M.isDone(t, today) && !M.isExpired(t, today)).length;
  if (!n) return toast('没有已完成的任务', '');
  const now = Date.now();
  const changed = state.tasks
    .filter((t) => !t.deleted && M.isDone(t, today))
    .map((t) => ({ ...t, deleted: true, updatedAt: now }));
  state.tasks = state.tasks.map((t) => changed.find((c) => c.id === t.id) || t);
  persist();
  engine.queueMany(changed);
  render();
  toast('已清理', `删除 ${changed.length} 条已完成任务`, 'del');
}

/* ============================== 跨天维护 ============================== */
let midnightTimer = null;
function scheduleMidnight() {
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(() => {
    runDailyMaintenance();
    scheduleMidnight();
  }, M.msUntilMidnight() + 800);
}

function runDailyMaintenance() {
  const changed = M.runDailyMaintenance(state.tasks, Date.now());
  if (changed.length) {
    state.tasks = state.tasks.map((t) => changed.find((c) => c.id === t.id) || t);
    persist();
    engine.queueMany(changed);
    toast('新的一天', `已清除 ${changed.length} 条过期临时任务，常驻任务已自动重置`, 'day');
  }
  state.meta.lastDailyCheck = M.dayKey();
  store.saveMeta(state.meta);
  render();
}

/* ============================== 提醒轮询 ============================== */
let alarmTimer = null;
function startAlarmLoop() {
  clearInterval(alarmTimer);
  alarmTimer = setInterval(checkReminders, 5000);
}

function checkReminders() {
  const now = Date.now();
  for (const task of state.tasks) {
    if (!M.shouldFireReminder(task, now)) continue;
    task.remindFiredOn = M.dayKey(new Date(now));
    const t = { ...task, updatedAt: now };
    state.tasks = state.tasks.map((x) => (x.id === t.id ? t : x));
    persist();
    if (state.settings.notifyOn) systemNotify({ title: '⏰ ' + t.title, body: '你设定的提醒时间到了', tag: t.id });
    if (state.settings.soundOn) chime(2);
    haptic(30);
    toast('⏰ ' + t.title, '提醒时间到了', 'alarm', 6000);
  }
  if (state.panelOpen === false) tickChips();
}

/**
 * 自动完成：开始过计时的任务，倒计时走完就自动标记完成。
 * 一分钟宽限窗，避免设备休眠错过精确时刻。
 */
function checkAutoComplete() {
  const now = Date.now();
  const hits = state.tasks.filter((t) => M.shouldAutoComplete(t, now));
  if (!hits.length) return;
  for (const task of hits) {
    const done = M.setDone(task, true, now);
    state.tasks = state.tasks.map((x) => (x.id === done.id ? done : x));
    engine.queue(done);
    if (state.settings.notifyOn) systemNotify({ title: '✅ ' + done.title, body: '预计时间到了，已自动标记完成', tag: done.id });
    if (state.settings.soundOn) chime(1);
    haptic(20);
    toast('✅ 已完成', `${done.title} · 用时 ${M.durationText(done.durationMs)}`, 'ok', 5000);
  }
  persist();
  render();
}

/* ============================== 应用内提示 ============================== */
const TOAST_ICON = {
  alarm: '<svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12"/></svg>',
  day: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M5 13l4.5 4.5L19 7"/></svg>',
};

function toast(title, sub, kind = 'ok', ms = 3200) {
  const node = document.createElement('div');
  node.className = 'toast' + (kind === 'alarm' ? ' alarm' : '');
  node.innerHTML = `${TOAST_ICON[kind] || TOAST_ICON.ok}<div><b>${title}</b>${
    sub ? `<div class="t-sub">${sub}</div>` : ''
  }</div>`;
  el.toastWrap.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, ms);
}

/* ============================== 弹层 ============================== */
function closePops() {
  el.itemPop.hidden = true;
  el.mainPop.hidden = true;
  el.timePop.hidden = true;
  state.popTaskId = null;
}

function placePop(pop, anchorRect) {
  const wrap = el.widget.getBoundingClientRect();
  pop.hidden = false;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = anchorRect.right - wrap.left - pw;
  let top = anchorRect.bottom - wrap.top + 6;
  left = Math.max(8, Math.min(left, wrap.width - pw - 8));
  if (top + ph > wrap.height - 8) top = anchorRect.top - wrap.top - ph - 6;
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

function openItemPop(taskId, anchor) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  closePops();
  state.popTaskId = taskId;
  $('popRemindLabel').textContent = task.remindAt ? '修改提醒时间' : '设定提醒时间';
  $('popCdLabel').textContent = task.countdownTo ? '修改倒计时' : '设定倒计时';
  placePop(el.itemPop, anchor.getBoundingClientRect());
}

/* ---------------------- 时间弹窗（提醒 / 倒计时） ---------------------- */
const QUICK = {
  remind: [
    { label: '+5 分', fn: () => Date.now() + 5 * 60000 },
    { label: '+15 分', fn: () => Date.now() + 15 * 60000 },
    { label: '+30 分', fn: () => Date.now() + 30 * 60000 },
    { label: '+1 小时', fn: () => Date.now() + 3600000 },
    { label: '今晚 20:00', fn: () => atHour(20) },
    { label: '明早 9:00', fn: () => atHour(9, 1) },
  ],
  countdown: [
    { label: '5 分钟', fn: () => Date.now() + 5 * 60000 },
    { label: '15 分钟', fn: () => Date.now() + 15 * 60000 },
    { label: '25 分钟', fn: () => Date.now() + 25 * 60000 },
    { label: '1 小时', fn: () => Date.now() + 3600000 },
    { label: '2 小时', fn: () => Date.now() + 7200000 },
    { label: '到今天结束', fn: () => M.dayStart() + 86400000 },
  ],
  duration: [
    { label: '15 分钟', fn: () => 15 * 60000 },
    { label: '25 分钟', fn: () => 25 * 60000 },
    { label: '45 分钟', fn: () => 45 * 60000 },
    { label: '1 小时', fn: () => 3600000 },
    { label: '90 分钟', fn: () => 90 * 60000 },
    { label: '2 小时', fn: () => 2 * 3600000 },
  ],
};

function atHour(h, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
}

function openTimePop(mode, taskId, anchor, target) {
  closePops();
  state.timePopMode = mode;
  state.offsetFor = taskId ? { kind: 'task', id: taskId } : { kind: target || 'new' };
  el.timePopHead.textContent =
    mode === 'remind' ? '设定提醒时间' : mode === 'countdown' ? '设定倒计时目标' : '设定预计时长';
  el.timeQuick.innerHTML = QUICK[mode]
    .map((q, i) => `<button data-q="${i}">${esc(q.label)}</button>`)
    .join('');

  // 时长模式用"分钟数"输入，其余用具体时刻
  const isDur = mode === 'duration';
  el.timeRow.hidden = isDur;
  el.durRow.hidden = !isDur;

  const cur =
    taskId != null
      ? mode === 'remind'
        ? state.tasks.find((t) => t.id === taskId)?.remindAt
        : mode === 'countdown'
          ? state.tasks.find((t) => t.id === taskId)?.countdownTo
          : state.tasks.find((t) => t.id === taskId)?.durationMs
      : null;

  if (isDur) {
    el.durInput.value = cur ? Math.max(1, Math.round(cur / 60000)) : 30;
    updateTimeTip();
  } else {
    const d = new Date(cur || Date.now());
    el.timeInput.value = `${M.pad2(d.getHours())}:${M.pad2(d.getMinutes())}`;
    updateTimeTip();
  }
  placePop(el.timePop, anchor.getBoundingClientRect());
}

function resolveTimeInput() {
  const [h, m] = (el.timeInput.value || '09:00').split(':').map(Number);
  const now = new Date();
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0, 0, 0);
  const rolled = d.getTime() <= Date.now();
  if (rolled) d = new Date(d.getTime() + 86400000);
  return { ts: d.getTime(), rolled };
}

function updateTimeTip() {
  if (state.timePopMode === 'duration') {
    const mins = Math.max(1, Number(el.durInput.value) || 30);
    el.timeTip.textContent = `预计用时 ${M.durationText(mins * 60000)}。开始做事后点 ▶ 就会自动倒数，到点自动标记完成。`;
    return;
  }
  const { ts, rolled } = resolveTimeInput();
  const fmt = new Date(ts);
  el.timeTip.textContent = `将设为 ${fmt.getMonth() + 1}月${fmt.getDate()}日 ${M.pad2(fmt.getHours())}:${M.pad2(
    fmt.getMinutes()
  )}${rolled ? '（已过今日该时刻，自动顺延到明天）' : ''}`;
}

function applyTime(ts) {
  const mode = state.timePopMode;
  const target = state.offsetFor;
  if (!mode || !target) return;

  if (target.kind === 'new') {
    state.pendingAdd[mode === 'remind' ? 'remindAt' : mode === 'countdown' ? 'countdownTo' : 'durationMs'] = ts;
    updateComposerChips();
  } else {
    const t = state.tasks.find((x) => x.id === target.id);
    if (!t) return;
    const patch = { updatedAt: Date.now() };
    if (mode === 'remind') {
      patch.remindAt = ts;
      patch.remindFiredOn = null;
    } else if (mode === 'countdown') {
      patch.countdownTo = ts;
      patch.startedAt = null; // 手动定的倒计时不算"开始做事"
    } else {
      patch.durationMs = ts;
      // 改时长时如果正在计时，按剩余时间顺延
      if (t.startedAt != null && t.countdownTo) {
        const remain = Math.max(0, t.countdownTo - Date.now());
        patch.countdownTo = Date.now() + Math.min(remain, ts);
      } else {
        patch.countdownTo = null;
      }
    }
    upsert({ ...t, ...patch });
  }
  closePops();
}

function updateComposerChips() {
  const { remindAt, countdownTo, durationMs } = state.pendingAdd;
  el.btnAt.classList.toggle('on', !!remindAt);
  el.btnCd.classList.toggle('on', !!countdownTo);
  el.btnDur.classList.toggle('on', !!durationMs);
  const bits = [];
  if (remindAt) bits.push('提醒 ' + M.hhmm(remindAt));
  if (countdownTo) bits.push('倒计时到 ' + M.hhmm(countdownTo));
  if (durationMs) bits.push('时长 ' + M.durationText(durationMs));
  el.input.placeholder = bits.length ? `添加任务（${bits.join(' / ')}）` : '添加一条待办…';
}

/* ============================== 设置面板 ============================== */
function openPanel() {
  closePops();
  state.panelOpen = true;
  el.panel.hidden = false;
  renderPanelNow();
}

function closePanel() {
  state.panelOpen = false;
  el.panel.hidden = true;
}

function renderPanelNow() {
  const keepScroll = el.panelBody.scrollTop;
  renderPanel(el.panelBody, {
    settings: state.settings,
    status: syncStatus,
    onLive: (patch) => liveSettings(patch),
    desktop: state.desktop
      ? {
          mode: state.desktop.mode,
          backdrop: state.desktop.backdrop,
          autoStart: state.desktop.autoStart,
          hotkey: state.desktop.hotkey,
          fallback: state.desktop.fallback,
          onMode: async (mode) => {
            await native.setMode(mode);
            toast('显示层级已切换', MODE_LABEL[mode] || mode, 'ok');
          },
          onBackdrop: async (bd) => {
            await native.setBackdrop(bd);
            toast('磨砂效果已切换', BACKDROP_LABEL[bd] || bd, 'ok');
          },
          onAutoStart: async (flag) => {
            await native.setAutoStart(flag);
            toast(flag ? '已开启开机自启' : '已关闭开机自启', '', 'ok');
          },
        }
      : null,
    android: floating
      ? {
          granted: !!state.android?.granted,
          running: !!state.android?.running,
          onToggle: async () => {
            const cur = await refreshFloating();
            if (cur?.running) {
              await floating.hide();
              toast('已关闭悬浮窗', '', 'ok');
            } else {
              const perm = await floating.isGranted();
              if (!perm.granted) {
                await floating.requestPermission();
                toast('请先授予「在其他应用上层显示」', '授权后回到 Onederz 再点一次开启', 'ok', 5200);
              } else {
                await floating.show();
                toast('悬浮窗已开启', '拖动顶部条移动，拖右下角缩放', 'ok');
              }
            }
            await refreshFloating();
            renderPanelNow();
          },
        }
      : null,
    onPatch: (patch) => {
      const needRestart = 'serverUrl' in patch && patch.serverUrl !== state.settings.serverUrl;
      patchSettings(patch);
      if (needRestart) engine.restart();
    },
    onLogin: async (u, p) => {
      const r = await engine.login(u, p);
      engine.restart();
      toast('登录成功', `欢迎，${r.username}`, 'ok');
      await afterAuth();
    },
    onRegister: async (u, p) => {
      const r = await engine.register(u, p);
      engine.restart();
      toast('注册成功', '已开始同步', 'ok');
      await afterAuth();
    },
    onLogout: () => {
      engine.signOut();
      toast('已退出登录', '本机数据保留，不再上传', 'ok');
      renderPanelNow();
    },
    onExport: exportBackup,
    onImport: importBackup,
    onClearDone: clearDone,
    onWipe: () => {
      if (!confirm('确定清除本机全部待办数据吗？此操作不可撤销（云端数据不受影响）。')) return;
      store.wipeAll();
      state.tasks = [];
      render();
      toast('已清除', '本机数据已重置', 'del');
    },
  });
  el.panelBody.scrollTop = keepScroll;
}

async function afterAuth() {
  await ensurePermission();
  try {
    await engine.syncNow();
    const r = await engine.request('/api/snapshot');
    if (r?.tasks?.length) {
      const { tasks } = M.mergeChanges(state.tasks, r.tasks);
      state.tasks = tasks;
      persist();
      render();
      toast('已同步', `从云端载入 ${r.tasks.length} 条备选记录`, 'sync');
    }
  } catch {
    /* 下一步的定时同步会补上 */
  }
  renderPanelNow();
}

/* ============================== 备份 ============================== */
function exportBackup() {
  const text = M.exportSnapshot(state.tasks, {
    deviceId: state.settings.deviceId,
    username: state.settings.username,
    exportedAt: new Date().toISOString(),
  });
  const name = `onederz-backup-${M.dayKey()}.json`;
  if (native?.saveFile) {
    native.saveFile(name, text).then((p) => {
      if (p) toast('已导出', p, 'ok');
    });
    return;
  }
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast('已导出', name, 'ok');
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { tasks } = M.importSnapshot(text);
      const { tasks: merged } = M.mergeChanges(state.tasks, tasks);
      state.tasks = merged;
      persist();
      engine.queueMany(tasks);
      render();
      toast('导入完成', `合并 ${tasks.length} 条记录`, 'ok');
    } catch (err) {
      toast('导入失败', err.message, 'del');
    }
  };
  input.click();
}

/* ============================== 交互绑定 ============================== */
function wireComposer() {
  el.typeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.addType = btn.dataset.type;
    el.typeSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b === btn));
    el.input.placeholder = state.addType === 'temp' ? '添加今天的临时待办…' : '添加一条待办…';
    updateComposerChips();
    el.input.focus();
  });

  el.btnAdd.addEventListener('click', addTask);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTask();
    }
  });

  el.btnAt.addEventListener('click', (e) => openTimePop('remind', null, e.currentTarget, 'new'));
  el.btnCd.addEventListener('click', (e) => openTimePop('countdown', null, e.currentTarget, 'new'));
}

function wireList() {
  el.list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;

    if (act === 'toggle') return toggleDone(id);
    if (act === 'start') return startTiming(id);
    if (act === 'stop') return stopTiming(id);
    if (act === 'remind') return openTimePop('remind', id, e.target.closest('[data-act]'));
    if (act === 'countdown') return openTimePop('countdown', id, e.target.closest('[data-act]'));
    if (act === 'menu') return openItemPop(id, e.target.closest('[data-act]'));

    // 点击正文进入编辑
    if (e.target.closest('.body') && !e.target.closest('input')) {
      state.editingId = id;
      render();
    }
  });

  el.list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('button')) return;
    state.editingId = row.dataset.id;
    render();
  });

  // 行内编辑保存
  const commitEdit = (input, save) => {
    const id = input.closest('.row').dataset.id;
    const task = state.tasks.find((t) => t.id === id);
    const value = input.value.trim();
    state.editingId = null;
    if (save && task && value && value !== task.title) {
      upsert({ ...task, title: value, updatedAt: Date.now() });
    } else {
      render();
    }
  };
  el.list.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-edit]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit(e.target, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      commitEdit(e.target, false);
    }
  });
  el.list.addEventListener(
    'blur',
    (e) => {
      if (e.target.matches?.('[data-edit]') && state.editingId) commitEdit(e.target, true);
    },
    true
  );
}

function wirePops() {
  el.itemPop.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = state.popTaskId;
    const task = state.tasks.find((t) => t.id === id);
    if (!act || !task) return;

    if (act === 'edit') {
      closePops();
      state.editingId = id;
      render();
    } else if (act === 'remind') {
      openTimePop('remind', id, e.target.closest('[data-act]'));
    } else if (act === 'countdown') {
      openTimePop('countdown', id, e.target.closest('[data-act]'));
    } else if (act === 'clearTime') {
      upsert({ ...task, remindAt: null, countdownTo: null, remindFiredOn: null, updatedAt: Date.now() });
      closePops();
    } else if (act === 'delete') {
      closePops();
      deleteTask(id);
    }
  });

  el.timeQuick.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-q]');
    if (!btn) return;
    applyTime(QUICK[state.timePopMode][Number(btn.dataset.q)].fn());
  });
  el.timeInput.addEventListener('input', updateTimeTip);
  el.timeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTime(resolveTimeInput().ts);
  });
  el.timeOk.addEventListener('click', () => applyTime(resolveTimeInput().ts));

  el.durInput.addEventListener('input', updateTimeTip);
  el.durInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTime(Math.max(1, Number(el.durInput.value) || 30) * 60000);
  });
  el.durOk.addEventListener('click', () => applyTime(Math.max(1, Number(el.durInput.value) || 30) * 60000));

  el.mainPop.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closePops();
    if (act === 'addFocus') {
      state.addType = 'daily';
      el.typeSeg.querySelector('[data-type="daily"]').classList.add('on');
      el.typeSeg.querySelector('[data-type="temp"]').classList.remove('on');
      el.input.focus();
    } else if (act === 'hideDone') {
      patchSettings({ hideCompleted: !state.settings.hideCompleted });
    } else if (act === 'tint') {
      patchSettings({ tint: state.settings.tint === 'dark' ? 'light' : 'dark' });
    } else if (act === 'settings') {
      openPanel();
    } else if (act === 'export') {
      exportBackup();
    } else if (act === 'import') {
      importBackup();
    } else if (act === 'quit') {
      native?.quit?.() ??
        (window.close(), toast('请手动关闭此页面', '浏览器环境无法自行退出'));
    }
  });

  // 点击空白处关闭弹层
  document.addEventListener('pointerdown', (e) => {
    // e.target 可能是 document/window（例如程序化派发或焦点在非元素节点上），
    // 这类节点没有 closest，必须判类型后再用，否则会抛异常导致弹层关不掉。
    const t = e.target instanceof Element ? e.target : null;
    if (t && (t.closest('.pop') || t.closest('#btnMenu') || t.closest('.row-acts'))) return;
    if (state.editingId && t && t.closest('[data-edit]')) return;
    closePops();
  });
}

function wireHeader() {
  el.btnMenu.addEventListener('click', (e) => {
    const open = el.mainPop.hidden;
    closePops();
    if (open) {
      $('popHideDone').textContent = state.settings.hideCompleted ? '显示已完成' : '隐藏已完成';
      $('popTint').textContent = state.settings.tint === 'dark' ? '切换浅色玻璃' : '切换深色玻璃';
      const quitBtn = el.mainPop.querySelector('[data-act="quit"]');
      if (quitBtn) quitBtn.style.display = native ? '' : 'none';
      placePop(el.mainPop, e.currentTarget.getBoundingClientRect());
    }
  });

  el.btnCollapse.addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    el.widget.dataset.collapsed = state.collapsed ? '1' : '0';
    el.btnCollapse.style.transform = state.collapsed ? 'rotate(-90deg)' : '';
    native?.setConfig?.({ collapsed: state.collapsed });
  });

  el.btnHide.addEventListener('click', async () => {
    if (isOverlay && floating) {
      // 悬浮窗里的关闭按钮 = 收起悬浮窗
      await floating.hide();
      return;
    }
    if (native?.hide) native.hide();
    else toast('提示', '浏览器/手机端请直接用系统方式关闭', 'ok');
  });

  el.panelBack.addEventListener('click', closePanel);
}

/* --------------------------- 窗口拖拽与缩放 --------------------------- */
/**
 * 单一入口决定"这次按下是缩放还是拖动"。
 *
 * 之前把拖拽绑在标题栏、缩放绑在 8 个 .rz 热区上，而 .rz 的 z-index(60) 高于
 * 标题栏(2)，等于标题栏顶部 5px 和四角 14px 实际是缩放区 —— 在那里按下再拖，
 * 触发的就是缩放（se 方向会同时变宽变高），看起来就是"拖一下窗口自己变大"。
 */
function wireWindowChrome() {
  if (!native) return;

  const EDGE = 6; // 边缘热区厚度（px）
  const CORNER = 16; // 四角热区边长
  let mode = null; // 'drag' | 'resize'
  let dir = null;
  let specRaf = 0;

  /**
   * 标题栏区域**完全排除**出缩放区。
   * 之前把顶部边缘/上角也当缩放区，而标题栏正好横跨顶部 —— 用户在标题栏靠上
   * 按下时触发的就是缩放（se 会同时变宽变高），看起来就是"拖动时窗口自己变大"。
   * 现在规则很简单：标题栏只能拖动；缩放只走左/右/下边缘与下方两角。
   */
  const edgeDir = (x, y, w, h, barBottom) => {
    if (y <= barBottom) return null; // 标题栏内一律不缩放
    const s = y >= h - EDGE,
      west = x <= EDGE,
      east = x >= w - EDGE;
    const low = y >= h - CORNER;
    if (s && west) return 'sw';
    if (s && east) return 'se';
    if (low && west) return 'w';
    if (low && east) return 'e';
    if (s) return 's';
    if (west) return 'w';
    if (east) return 'e';
    return null;
  };

  /** 动态高光：让高光跟着鼠标走，玻璃才有"被光照到"的生命感 */
  const moveSpec = (e) => {
    if (specRaf) return;
    specRaf = requestAnimationFrame(() => {
      specRaf = 0;
      if (mode) return; // 拖动/缩放时不折腾，省一档 GPU
      const r = el.widget.getBoundingClientRect();
      el.widget.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.widget.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  };

  el.widget.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      // 这些元素自己有交互，别抢
      if (e.target.closest('button, input, a, .pop, .panel, .toast, select, textarea')) return;

      const rect = el.widget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const barBottom = el.bar.getBoundingClientRect().bottom - rect.top;

      dir = edgeDir(x, y, rect.width, rect.height, barBottom);
      if (dir) {
        mode = 'resize';
        native.resizeStart(dir);
      } else {
        // 只有标题栏范围才允许拖动
        if (y > barBottom) return;
        mode = 'drag';
        native.dragStart();
      }

      document.body.classList.add('dragging');
      try {
        el.widget.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    },
    true
  );

  el.widget.addEventListener('pointermove', (e) => {
    moveSpec(e);
    if (!mode) return;
    if (mode === 'resize') native.resizeMove();
    else native.dragMove();
  });

  const finish = (e) => {
    if (!mode) return;
    const wasResize = mode === 'resize';
    mode = null;
    dir = null;
    document.body.classList.remove('dragging');
    try {
      el.widget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (wasResize) native.resizeEnd();
    else native.dragEnd();
  };
  el.widget.addEventListener('pointerup', finish);
  el.widget.addEventListener('pointercancel', finish);
}

/* ------------------------------ 键盘 ------------------------------ */
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, [contenteditable]');
    if (e.key === 'Escape') {
      if (state.editingId) {
        state.editingId = null;
        render();
      } else if (!el.panel.hidden) closePanel();
      else if (!el.mainPop.hidden || !el.itemPop.hidden || !el.timePop.hidden) closePops();
      else if (typing) e.target.blur();
      return;
    }
    if (typing) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      el.input.focus();
    }
  });
}

/* ============================== 启动 ============================== */
async function boot() {
  // 0) 与桌面外壳同步外观与窗口行为配置
  if (native?.getConfig) {
    try {
      const cfg = await native.getConfig();
      if (cfg?.tint) state.settings.tint = cfg.tint;
      if (cfg?.opacity) state.settings.glassOpacity = cfg.opacity;
      if (cfg?.accent) state.settings.accent = cfg.accent;
      if (cfg?.collapsed) {
        state.collapsed = true;
        el.widget.dataset.collapsed = '1';
      }
      state.desktop = {
        mode: cfg?.mode || 'desktop',
        backdrop: cfg?.backdrop || 'acrylic',
        autoStart: !!cfg?.autoStart,
        hotkey: cfg?.hotkey || 'Alt+Space',
        fallback: null,
      };
    } catch {
      /* noop */
    }
  }

  // 桌面外壳下发的命令与配置变更
  native?.onCommand?.((msg) => {
    if (!msg) return;
    if (msg.cmd === 'open-settings') openPanel();
    else if (msg.cmd === 'focus-input') el.input.focus();
    else if (msg.cmd === 'mode-fallback') {
      if (state.desktop) state.desktop.fallback = msg.payload?.reason || '系统限制';
      toast('已切换为「跟随桌面显示」', '当前系统无法挂载桌面层，显示效果一致', 'ok', 6000);
      if (state.panelOpen) renderPanelNow();
    }
  });

  native?.onConfigChange?.((cfg) => {
    if (!cfg || !state.desktop) return;
    state.desktop.mode = cfg.mode || state.desktop.mode;
    state.desktop.backdrop = cfg.backdrop || state.desktop.backdrop;
    state.desktop.autoStart = !!cfg.autoStart;
    if (cfg.tint) state.settings.tint = cfg.tint;
    if (cfg.opacity) state.settings.glassOpacity = cfg.opacity;
    applyTheme();
    if (state.panelOpen) renderPanelNow();
  });

  // 1) 载入本机数据
  state.tasks = store.loadTasks();
  applyTheme();
  runDailyMaintenance();
  render();

  // 2) 事件绑定
  wireComposer();
  wireList();
  wirePops();
  wireHeader();
  wireWindowChrome();
  wireKeys();
  updateComposerChips();

  // 3) 同步
  engine.start();
  await ensurePermission();
  if (floating) await refreshFloating();

  // 4) 定时器
  scheduleMidnight();
  startAlarmLoop();
  setInterval(tickChips, 1000);
  setInterval(checkAutoComplete, 1000);

  // 5) 回到前台时补一次跨天检查与同步（休眠唤醒场景）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    runDailyMaintenance();
    engine.syncNow().catch(() => {});
  });

  window.addEventListener('online', () => engine.restart());
  window.addEventListener('offline', () => {
    syncStatus = 'offline';
    renderSyncBadge();
  });

  // 6) 首次使用：若未配置同步，弹一次温和提示
  if (!state.settings.token && !localStorage.getItem('onederz.greeted')) {
    localStorage.setItem('onederz.greeted', '1');
    setTimeout(() => toast('欢迎使用 Onederz', '在上方菜单 → 设置与同步 里配置账号，即可多端同步', 'ok', 5200), 900);
  }

  console.log(
    `%cOnederz%c 已就绪 · ${isDesktop ? 'Windows 桌面部件' : isAndroid ? 'Android' : '浏览器'} · 设备 ${state.settings.deviceId}`,
    'background:#5b6bff;color:#fff;padding:2px 7px;border-radius:5px;font-weight:700',
    'color:#8a93a8'
  );
}

boot();

// 便于调试与自动化验收
window.onederzApp = {
  state, engine, render, applyTheme, renderPanelNow, openPanel, closePanel,
  checkAutoComplete, M, store, probeServer, toast, floating,
};
