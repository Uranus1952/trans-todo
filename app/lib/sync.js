/**
 * Onederz · 同步引擎
 * ---------------------------------------------------------------
 * 承担三件事：
 *   1. 变更上行 —— 本地每次改动都会进入 outbox，联网后批量推送；
 *   2. 增量下行 —— 每次同步只拉 `updatedAt > since` 的变更，LWW 合并；
 *   3. 实时推送 —— 通过 WebSocket 订阅，A 端勾选后 B 端毫秒级刷新。
 *
 * 冲突策略见 model.js 的 pickWinner（Last-Write-Wins + 删除优先 + deviceId 兜底）。
 * 由于"每日重置"是纯日期推导（见 model.js 头部说明），同步层完全不需要处理跨天问题。
 */

import { mergeChanges, normalizeTask } from './model.js';

const SYNC_OVERLAP_MS = 5000; // 回拨窗口，抵消各端时钟微差造成的漏拉

export class SyncEngine {
  /**
   * @param {object} opts
   * @param {() => Array} opts.getTasks
   * @param {(tasks:Array, changes:Array) => void} opts.applyTasks
   * @param {() => object} opts.getSettings
   * @param {(patch:object) => void} opts.patchSettings
   * @param {(status:object) => void} [opts.onStatus]
   * @param {(msg:object) => void} [opts.onEvent]
   */
  constructor(opts) {
    this.opts = opts;
    this.status = 'offline'; // offline | connecting | online | syncing | error
    this.lastError = null;
    this.since = 0;
    this.ws = null;
    this.wsRetry = 0;
    this.pending = new Map(); // id -> task（待上行）
    this.timer = null;
    this.wsTimer = null;
    this.stopped = true;
  }

  get settings() {
    return this.opts.getSettings();
  }

  emitStatus(extra = {}) {
    this.opts.onStatus?.({ status: this.status, lastError: this.lastError, pending: this.pending.size, ...extra });
  }

  emitEvent(msg) {
    this.opts.onEvent?.(msg);
  }

  /* --------------------------- 生命周期 --------------------------- */

  start() {
    this.stopped = false;
    const s = this.settings;
    if (s.serverUrl && s.token) {
      this.connect();
    } else {
      this.status = 'offline';
      this.emitStatus();
    }
    this.schedule(15000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.wsTimer);
    this.timer = null;
    this.wsTimer = null;
    this.closeWs();
  }

  schedule(ms) {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.syncNow().catch(() => {}), ms);
  }

  /* ----------------------------- 鉴权 ----------------------------- */

  async request(path, { method = 'GET', body, auth = true, timeout = 12000 } = {}) {
    const base = this.settings.serverUrl.replace(/\/+$/, '');
    if (!base) throw new Error('尚未配置同步服务器地址');
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (auth && this.settings.token) headers.Authorization = `Bearer ${this.settings.token}`;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    } finally {
      clearTimeout(tid);
    }
  }

  async register(username, password) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      body: { username, password, deviceId: this.settings.deviceId },
      auth: false,
    });
    this.patchAuth(data);
    return data;
  }

  async login(username, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: { username, password, deviceId: this.settings.deviceId },
      auth: false,
    });
    this.patchAuth(data);
    return data;
  }

  patchAuth(data) {
    this.opts.patchSettings({ token: data.token, userId: data.userId, username: data.username });
    this.since = 0;
  }

  signOut() {
    this.closeWs();
    this.opts.patchSettings({ token: '', userId: '', username: '' });
    this.status = 'offline';
    this.pending.clear();
    this.emitStatus();
  }

  /* ----------------------------- 上行 ----------------------------- */

  /** 本地任务发生变化时调用；autoFlush 为 false 时可攒批 */
  queue(task, autoFlush = true) {
    this.pending.set(task.id, task);
    this.emitStatus();
    if (autoFlush) {
      clearTimeout(this._flushTid);
      this._flushTid = setTimeout(() => this.syncNow().catch(() => {}), 350);
    }
  }

  queueMany(tasks, autoFlush = true) {
    for (const t of tasks) this.pending.set(t.id, t);
    this.emitStatus();
    if (autoFlush) {
      clearTimeout(this._flushTid);
      this._flushTid = setTimeout(() => this.syncNow().catch(() => {}), 350);
    }
  }

  /* ----------------------------- 同步 ----------------------------- */

  async syncNow() {
    const s = this.settings;
    if (!s.serverUrl || !s.token) {
      this.status = 'offline';
      this.emitStatus();
      return { skipped: true };
    }
    if (this._syncing) return { busy: true };
    this._syncing = true;
    const prev = this.status;
    this.status = 'syncing';
    this.emitStatus();
    try {
      const changes = [...this.pending.values()];
      const data = await this.request('/api/sync', {
        method: 'POST',
        body: {
          since: Math.max(0, this.since - SYNC_OVERLAP_MS),
          changes,
          deviceId: s.deviceId,
        },
      });
      // 上行成功才清空 outbox（期间新加入的保留）
      for (const [id, t] of this.pending) {
        const sent = changes.find((c) => c.id === id);
        if (sent && sent.updatedAt === t.updatedAt) this.pending.delete(id);
      }
      this.since = data.now || Date.now();
      const { tasks, applied } = mergeChanges(this.opts.getTasks(), data.changes || []);
      if (applied.length) this.opts.applyTasks(tasks, applied);
      else if (data.full || !this._bootstrapped) {
        this.opts.applyTasks(tasks, []);
      }
      this._bootstrapped = true;
      this.status = 'online';
      this.lastError = null;
      this.wsRetry = 0;
      this.emitStatus({ syncedAt: Date.now(), downloaded: (data.changes || []).length });
      return data;
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      if (prev !== 'error') console.warn('[sync] 同步失败', err.message);
      this.emitStatus();
      throw err;
    } finally {
      this._syncing = false;
    }
  }

  /* --------------------------- 实时推送 --------------------------- */

  connect() {
    const s = this.settings;
    if (this.stopped || !s.serverUrl || !s.token) return;
    this.closeWs();
    const url = new URL(s.serverUrl.replace(/\/+$/, '') + '/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', s.token);
    this.status = 'connecting';
    this.emitStatus();

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.lastError = err.message;
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = async () => {
      this.wsRetry = 0;
      this.status = 'online';
      this.emitStatus();
      try {
        await this.syncNow();
      } catch {
        /* 忽略，等下一轮 */
      }
    };

    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'changes' && Array.isArray(msg.changes)) {
        this.since = Math.max(this.since, msg.now || 0);
        const remote = msg.changes.map(normalizeTask);
        const changedByMe = remote.every((r) => r.deviceId === s.deviceId);
        const { tasks, applied } = mergeChanges(this.opts.getTasks(), remote);
        if (applied.length && !changedByMe) {
          this.opts.applyTasks(tasks, applied);
          this.emitEvent({ type: 'remote-change', count: applied.length });
        }
      } else if (msg.type === 'hello') {
        this.emitEvent({ type: 'hello', user: msg.username });
      }
    };

    socket.onclose = () => {
      if (this.ws === socket) this.ws = null;
      if (!this.stopped) {
        if (this.status === 'online' || this.status === 'connecting') this.status = 'offline';
        this.emitStatus();
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      /* onclose 会接手 */
    };
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.wsRetry = Math.min(this.wsRetry + 1, 6);
    const delay = Math.min(30000, 1000 * 2 ** (this.wsRetry - 1));
    clearTimeout(this.wsTimer);
    this.wsTimer = setTimeout(() => this.connect(), delay);
  }

  closeWs() {
    const s = this.ws;
    this.ws = null;
    if (s) {
      try {
        s.onclose = null;
        s.close();
      } catch {
        /* noop */
      }
    }
  }

  /** 用户改完服务器地址后调用 */
  restart() {
    this.stopped = false;
    this.since = 0;
    this.closeWs();
    if (this.timer) this.schedule(15000);
    if (this.settings.serverUrl && this.settings.token) this.connect();
    else {
      this.status = 'offline';
      this.emitStatus();
    }
  }
}

/* ----------------------------- 工具 ----------------------------- */

export async function probeServer(serverUrl) {
  const base = (serverUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('地址为空');
  const res = await fetch(base + '/api/health', { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
