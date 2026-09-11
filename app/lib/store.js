/**
 * Onederz · 本地存储
 * ---------------------------------------------------------------
 * 三端（Electron 渲染进程 / Android WebView / 浏览器 PWA）都用 localStorage。
 * Electron 的 localStorage 落在 userData 目录，Capacitor 落在 App 私有目录，
 * 都是持久化的，无需各端各写一套。
 */

import { normalizeTask } from './model.js';

const K_TASKS = 'onederz.tasks.v1';
const K_META = 'onederz.meta.v1';
const K_SETTINGS = 'onederz.settings.v1';
const K_DIRTY = 'onederz.dirty.v1';

export const DEFAULT_SETTINGS = {
  serverUrl: '',
  token: '',
  userId: '',
  username: '',
  deviceId: '',
  deviceName: '',
  tint: 'light', // light | dark（文字明暗方案）
  glassBase: '255,255,255', // 玻璃基色 "r,g,b"，外观预设会改它
  theme: 'mist', // 当前外观预设 id
  glassOpacity: 0.55, // 玻璃浓度（= 目标不透明度），三端统一的唯一样式旋钮
  accent: '#5b6bff',
  soundOn: true,
  notifyOn: true,
  hideCompleted: false,
  autoCollapseDone: false,
  sortBy: 'order', // order | created | alpha
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[store] 写入失败', key, err);
    return false;
  }
}

/* ---------------------------- 任务 ---------------------------- */

export function loadTasks() {
  const raw = read(K_TASKS, []);
  return Array.isArray(raw) ? raw.map(normalizeTask) : [];
}

export function saveTasks(tasks) {
  return write(K_TASKS, tasks);
}

/* ---------------------------- 元数据 ---------------------------- */

export function loadMeta() {
  return { lastSyncAt: 0, lastDailyCheck: null, ...read(K_META, {}) };
}

export function saveMeta(meta) {
  return write(K_META, meta);
}

/* ---------------------------- 设置 ---------------------------- */

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K_SETTINGS, {}) };
}

export function saveSettings(settings) {
  return write(K_SETTINGS, settings);
}

/* ------------------------- 待推送脏标记 ------------------------- */

export function loadDirty() {
  const raw = read(K_DIRTY, []);
  return new Set(Array.isArray(raw) ? raw : []);
}

export function saveDirty(set) {
  return write(K_DIRTY, [...set]);
}

/* ---------------------------- 整体 ---------------------------- */

export function wipeAll() {
  [K_TASKS, K_META, K_DIRTY].forEach((k) => localStorage.removeItem(k));
}
