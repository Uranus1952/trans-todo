/**
 * Onederz 同步服务 · 持久化层
 * 用单个 JSON 文件保存全部数据，零原生依赖，拷走即备份。
 * 数据量级（个人/小团队待办）完全够用；写入采用"临时文件 + 重命名"保证原子性。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  version: 1,
  users: {}, // username -> { id, username, salt, hash, createdAt }
  tasks: {}, // userId   -> { taskId: task }
  };

let db = null;
let writeTimer = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (db) return db;
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { ...EMPTY, ...parsed };
      db.users ||= {};
      db.tasks ||= {};
      return db;
    } catch (err) {
      console.error('[store] db.json 解析失败，已备份并重建：', err.message);
      try {
        fs.renameSync(DB_FILE, DB_FILE + '.corrupt.' + Date.now());
      } catch {
        /* noop */
      }
    }
  }
  db = structuredClone(EMPTY);
  flush(true);
  return db;
}

function flush(sync = false) {
  if (!db) return;
  if (!sync) {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => flush(true), 120);
    return;
  }
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

module.exports = {
  DB_FILE,
  get db() {
    return load();
  },
  save: () => flush(false),
  flushNow: () => flush(true),

  /* -------------------------- 用户 -------------------------- */
  findUserByName(username) {
    const d = load();
    const key = String(username || '').trim().toLowerCase();
    return d.users[key] || null;
  },
  createUser(user) {
    const d = load();
    d.users[user.username.toLowerCase()] = user;
    d.tasks[user.id] ||= {};
    flush();
    return user;
  },

  /* -------------------------- 任务 -------------------------- */
  tasksOf(userId) {
    const d = load();
    d.tasks[userId] ||= {};
    return d.tasks[userId];
  },
  /**
   * Last-Write-Wins 合并，规则与客户端 model.js 的 pickWinner 完全对齐。
   * @returns {Array} 真正被服务端采纳（即发生更新）的任务
   */
  mergeTasks(userId, incoming) {
    const bucket = this.tasksOf(userId);
    const accepted = [];
    for (const raw of incoming || []) {
      if (!raw || !raw.id) continue;
      const cur = bucket[raw.id];
      if (!cur) {
        bucket[raw.id] = raw;
        accepted.push(raw);
        continue;
      }
      const newer = (raw.updatedAt || 0) !== (cur.updatedAt || 0)
        ? (raw.updatedAt || 0) > (cur.updatedAt || 0)
        : raw.deleted !== cur.deleted
          ? !!raw.deleted
          : String(raw.deviceId || '') >= String(cur.deviceId || '');
      if (newer) {
        bucket[raw.id] = raw;
        accepted.push(raw);
      }
    }
    if (accepted.length) flush();
    return accepted;
  },
  changesSince(userId, since, limit = 5000) {
    const bucket = this.tasksOf(userId);
    const out = [];
    for (const t of Object.values(bucket)) {
      if ((t.updatedAt || 0) > since) out.push(t);
      if (out.length >= limit) break;
    }
    out.sort((a, b) => a.updatedAt - b.updatedAt);
    return out;
  },
  stats() {
    const d = load();
    return {
      users: Object.keys(d.users).length,
      taskBuckets: Object.keys(d.tasks).length,
      tasks: Object.values(d.tasks).reduce((n, b) => n + Object.keys(b).length, 0),
    };
  },
};
