/**
 * Onederz · 共享数据模型与业务规则
 * ---------------------------------------------------------------
 * 这个文件是 Windows 桌面端 / Android 端 / 浏览器 PWA 的**唯一事实来源**。
 * 全部为纯函数，不依赖任何平台 API，因此三端行为天然一致。
 *
 * 核心设计（重要）：
 *   常驻任务的"每日重置"不使用定时器清零，而是把"完成于哪一天"记录在
 *   `doneDate` 字段上。判定"今天是否完成" = (doneDate === 今天)。
 *   好处：
 *     1. 天然幂等 —— 重置事件不需要被写入、被同步，零点时日期变了自然就重置了；
 *     2. 天然跨端一致 —— A 端勾选后 doneDate=今天，同步到 B 端后 B 端也显示已完成；
 *     3. 穿越零点无需任何定时任务参与，离线设备第二天打开也自动是未完成。
 *   临时任务的过期同理：`date < 今天` 即为过期，显示层直接过滤，并顺带做一次
 *   软删除（tombstone）广播，让其他端连数据一起清掉。
 */

export const TASK_DAILY = 'daily'; // 常驻任务：添加一次，每日自动出现
export const TASK_TEMP = 'temp'; // 临时任务：仅当日有效

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* 时间工具                                                            */
/* ------------------------------------------------------------------ */

export const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期键 'YYYY-MM-DD'（刻意用本地时区，用户的"今天"由用户所在时区决定） */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 某天 00:00:00.000 的时间戳 */
export function dayStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 'YYYY-MM-DD' + 'HH:mm' → 时间戳（本地时区） */
export function toTimestamp(dateKeyStr, hhmm) {
  const [y, m, d] = dateKeyStr.split('-').map(Number);
  const [hh, mm] = String(hhmm || '09:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
}

/** 时间戳 → 'HH:mm' */
export function hhmm(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 距离下一个零点还有多少毫秒 */
export function msUntilMidnight(now = Date.now()) {
  return dayStart(now) + 86400000 - now;
}

/** 生成短 ID（不依赖 crypto，三端通用） */
export function uid(prefix = 't') {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand()}${rand()}`.slice(0, 34);
}

/* ------------------------------------------------------------------ */
/* 任务工厂与规范化                                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {object} init
 * @param {'daily'|'temp'} init.type
 * @param {string} init.title
 */
export function createTask(init = {}) {
  const now = Date.now();
  const type = init.type === TASK_TEMP ? TASK_TEMP : TASK_DAILY;
  return normalizeTask({
    id: init.id || uid(type === TASK_DAILY ? 'd' : 'x'),
    type,
    title: (init.title || '').trim(),
    note: init.note || '',
    date: type === TASK_TEMP ? init.date || dayKey() : null,
    doneDate: null, // 最近一次"完成"发生在哪一天
    doneAt: null, // 最近一次勾选的精确时间（仅用于展示）
    remindAt: init.remindAt ?? null, // 提醒时间戳
    remindFiredOn: null, // 提醒已触发的日期键，避免重复提醒
    countdownTo: init.countdownTo ?? null, // 倒计时目标时间戳
    durationMs: init.durationMs ?? null, // 预计时长（毫秒）
    startedAt: init.startedAt ?? null, // 开始做事的时刻；有它，倒计时结束才会自动完成
    order: init.order ?? now,
    color: init.color || null,
    createdAt: now,
    updatedAt: now,
    deviceId: init.deviceId || 'local',
    deleted: false,
  });
}

/** 补齐/纠正字段，保证任意来源（本地旧数据、服务端、其他设备）的任务都可安全使用 */
export function normalizeTask(raw = {}) {
  const t = { ...raw };
  t.id = t.id || uid();
  t.type = t.type === TASK_TEMP ? TASK_TEMP : TASK_DAILY;
  t.title = typeof t.title === 'string' ? t.title : '';
  t.note = typeof t.note === 'string' ? t.note : '';
  t.date = t.type === TASK_TEMP ? t.date || dayKey() : null;
  t.doneDate = t.doneDate || null;
  t.doneAt = Number.isFinite(t.doneAt) ? t.doneAt : null;
  t.remindAt = Number.isFinite(t.remindAt) ? t.remindAt : null;
  t.remindFiredOn = t.remindFiredOn || null;
  t.countdownTo = Number.isFinite(t.countdownTo) ? t.countdownTo : null;
  t.durationMs = Number.isFinite(t.durationMs) && t.durationMs > 0 ? t.durationMs : null;
  t.startedAt = Number.isFinite(t.startedAt) ? t.startedAt : null;
  t.order = Number.isFinite(t.order) ? t.order : Date.now();
  t.createdAt = Number.isFinite(t.createdAt) ? t.createdAt : Date.now();
  t.updatedAt = Number.isFinite(t.updatedAt) ? t.updatedAt : Date.now();
  t.deviceId = t.deviceId || 'local';
  t.deleted = !!t.deleted;
  return t;
}

/* ------------------------------------------------------------------ */
/* 完成态：常驻任务按"天"计算，临时任务按任务本身计算                    */
/* ------------------------------------------------------------------ */

export function isDone(task, today = dayKey()) {
  if (task.type === TASK_DAILY) return task.doneDate === today;
  return task.doneDate != null;
}

/** 返回被修改后的任务副本（不改原对象） */
export function setDone(task, done, now = Date.now()) {
  const today = dayKey(new Date(now));
  const next = { ...task };
  next.doneDate = done ? today : null;
  next.doneAt = done ? now : null;
  if (done && next.remindAt) next.remindFiredOn = today; // 完成了就别再提醒
  next.updatedAt = now;
  return normalizeTask(next);
}

/* ------------------------------------------------------------------ */
/* 可见性 / 分组                                                       */
/* ------------------------------------------------------------------ */

/** 临时任务是否已过期（跨天即过期） */
export function isExpired(task, today = dayKey()) {
  return task.type === TASK_TEMP && !!task.date && task.date < today;
}

export function isVisible(task, today = dayKey()) {
  if (task.deleted) return false;
  if (isExpired(task, today)) return false;
  return true;
}

/**
 * 把任务分成"进行中 / 已完成"两组并排序。
 * 排序：未完成在前 → 有倒计时的靠前（按目标时间）→ 手动 order
 */
export function groupTasks(tasks, today = dayKey()) {
  const visible = tasks.filter((t) => isVisible(t, today));
  const sorted = (list) =>
    list.slice().sort((a, b) => {
      const ca = a.countdownTo ?? Infinity;
      const cb = b.countdownTo ?? Infinity;
      if (ca !== cb) return ca - cb;
      return a.order - b.order;
    });
  const pending = sorted(visible.filter((t) => !isDone(t, today)));
  const done = sorted(visible.filter((t) => isDone(t, today)));
  return {
    daily: pending.filter((t) => t.type === TASK_DAILY),
    temp: pending.filter((t) => t.type === TASK_TEMP),
    done,
    total: visible.length,
    doneCount: done.length,
  };
}

/* ------------------------------------------------------------------ */
/* 每日维护：过期临时任务软删除 + 常驻任务无需处理                       */
/* ------------------------------------------------------------------ */

/**
 * 零点过后调用（或在每次启动/同步后调用）。
 * 常驻任务：无需任何操作 —— doneDate 不是今天，自然就是"未完成"。
 * 临时任务：过期者标记 deleted（tombstone），这样其他设备同步后也会一起清掉，
 *          同时把 remindFiredOn 之类的当日标记重置。
 *
 * @returns {Array} 变更过的任务（用于推送到同步服务）
 */
export function runDailyMaintenance(tasks, now = Date.now()) {
  const today = dayKey(new Date(now));
  const changed = [];
  for (const task of tasks) {
    if (task.deleted) continue;
    if (isExpired(task, today)) {
      const next = { ...task, deleted: true, updatedAt: now };
      changed.push(next);
    } else if (task.remindFiredOn && task.remindFiredOn !== today) {
      // 跨天后允许再次提醒
      changed.push({ ...task, remindFiredOn: null, updatedAt: now });
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* 提醒 / 倒计时                                                       */
/* ------------------------------------------------------------------ */

export function formatCountdown(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let text;
  if (d > 0) text = `${d}天${h}小时`;
  else if (h > 0) text = `${h}:${pad2(m)}:${pad2(s)}`;
  else text = `${m}:${pad2(s)}`;
  return neg ? `已超时 ${text}` : `剩 ${text}`;
}

/** 倒计时紧迫度：用于 UI 着色 */
export function countdownLevel(ms) {
  if (ms < 0) return 'over';
  if (ms < 10 * 60 * 1000) return 'urgent';
  if (ms < 60 * 60 * 1000) return 'soon';
  return 'calm';
}

/** 该任务此刻是否应当触发提醒 */
export function shouldFireReminder(task, now = Date.now()) {
  if (task.deleted || !task.remindAt) return false;
  const today = dayKey(new Date(now));
  if (task.remindFiredOn === today) return false;
  if (isDone(task, today)) return false;
  return now >= task.remindAt && now - task.remindAt < 12 * 3600 * 1000;
}

/* ------------------------------------------------------------------ */
/* 时长任务：设个时长 → 点开始 → 倒计时走完自动完成                      */
/* ------------------------------------------------------------------ */

/** 开始做这件事：以当下为起点启动倒计时 */
export function startTask(task, now = Date.now()) {
  if (!task.durationMs) return normalizeTask(task);
  return normalizeTask({
    ...task,
    startedAt: now,
    countdownTo: now + task.durationMs,
    updatedAt: now,
  });
}

/** 停止计时（保留已进行的时间，便于下次接着算） */
export function stopTask(task, now = Date.now()) {
  if (task.startedAt == null) return normalizeTask(task);
  const elapsed = Math.max(0, now - task.startedAt);
  return normalizeTask({
    ...task,
    startedAt: null,
    countdownTo: null,
    durationMs: task.durationMs ? Math.max(60000, task.durationMs - elapsed) : null,
    updatedAt: now,
  });

}

/** 该任务此刻是否应当自动标记完成：只有"开始过"的时长任务才会 */
export function shouldAutoComplete(task, now = Date.now()) {
  if (task.deleted || !task.startedAt || !task.countdownTo) return false;
  if (isDone(task, dayKey(new Date(now)))) return false;
  const late = now - task.countdownTo;
  return late >= 0 && late < 60_000; // 一分钟宽限，防止休眠错过
}

/** 任务完成度 0~1（用于进行中的进度条） */
export function taskProgress(task, now = Date.now()) {
  if (!task.startedAt || !task.durationMs) return 0;
  return Math.min(1, Math.max(0, (now - task.startedAt) / task.durationMs));
}

const CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 中文数字 → 数值，支持 一~九十九 与 半 */
function cnNumber(text) {
  if (text === '半') return 0.5;
  if (!text) return NaN;
  if (text.startsWith('十')) return 10 + (CN_NUM[text[1]] || 0);
  if (text.includes('十')) {
    const [a, b] = text.split('十');
    return (CN_NUM[a] || 1) * 10 + (CN_NUM[b] || 0);
  }
  return CN_NUM[text];
}

/**
 * 从标题里解析时长，例如：
 *   "读书 一小时"  → { title:'读书', durationMs: 3600000 }
 *   "跑步30分钟"   → { title:'跑步', durationMs: 1800000 }
 *   "阅读 1.5小时" → { title:'阅读', durationMs: 5400000 }
 *   "背单词"       → { title:'背单词', durationMs: null }
 * 解析不到就原样返回，绝不改写用户的文字。
 */
export function parseDuration(rawTitle) {
  const title = String(rawTitle || '').trim();
  if (!title) return { title, durationMs: null };

  // 1) 阿拉伯数字：1小时 / 1.5小时 / 30分钟 / 45min
  let m = title.match(/\s*(\d+(?:\.\d+)?)\s*(个小时|小时|时|h|分钟|分|min|m)\s*$/i);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const ms = /^h|小时|时$/.test(unit) ? n * 3600000 : n * 60000;
    if (ms > 0) return { title: title.slice(0, m.index).trim(), durationMs: Math.round(ms) };
  }

  // 2) 中文数字：一小时 / 半小时 / 三十分钟 / 二十分钟
  m = title.match(/\s*([一两二三四五六七八九十半]+)\s*(个小时|小时|时|分钟|分)\s*$/);
  if (m) {
    const n = cnNumber(m[1]);
    const ms = /小时|时$/.test(m[2]) ? n * 3600000 : n * 60000;
    if (Number.isFinite(n) && ms > 0) return { title: title.slice(0, m.index).trim(), durationMs: Math.round(ms) };
  }

  return { title, durationMs: null };
}

/** 毫秒 → 人话："1小时" / "45分钟" / "1小时30分" */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}小时${m}分`;
  if (h) return `${h}小时`;
  return `${m}分钟`;
}

/** 该任务是否处于"计时中" */
export function isTiming(task, now = Date.now()) {
  return (
    !task.deleted &&
    task.startedAt != null &&
    task.countdownTo != null &&
    task.countdownTo > now &&
    !isDone(task, dayKey(new Date(now)))
  );
}

/* ------------------------------------------------------------------ */
/* 同步合并：Last-Write-Wins + tombstone 优先                           */
/* ------------------------------------------------------------------ */

/**
 * 合并两条同一 id 的记录。规则：
 *   1. updatedAt 大者胜；
 *   2. 时间相同则 deleted 优先（删除是更"强"的动作，避免复活）；
 *   3. 再相同则比较 deviceId，保证多端结果确定性一致。
 */
export function pickWinner(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.deleted !== b.deleted) return a.deleted ? a : b;
  return String(a.deviceId) >= String(b.deviceId) ? a : b;
}

/** 把远端变更合并进本地列表，返回 { tasks, applied:[被采纳的远端任务] } */
export function mergeChanges(localTasks, remoteChanges) {
  const map = new Map(localTasks.map((t) => [t.id, t]));
  const applied = [];
  for (const raw of remoteChanges || []) {
    const remote = normalizeTask(raw);
    const local = map.get(remote.id);
    const winner = pickWinner(local, remote);
    if (winner === remote && local !== remote) {
      map.set(remote.id, remote);
      applied.push(remote);
    }
  }
  return { tasks: [...map.values()], applied };
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入（备份、跨端手工迁移）                                     */
/* ------------------------------------------------------------------ */

export function exportSnapshot(tasks, meta = {}) {
  return JSON.stringify(
    { app: 'onederz', schema: SCHEMA_VERSION, exportedAt: Date.now(), meta, tasks },
    null,
    2
  );
}

export function importSnapshot(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const tasks = (data.tasks || []).map(normalizeTask);
  return { tasks, meta: data.meta || {} };
}
