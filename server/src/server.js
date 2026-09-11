/**
 * Onederz 同步服务
 * ---------------------------------------------------------------
 *   POST /api/auth/register   { username, password }        → { token, userId, username }
 *   POST /api/auth/login      { username, password }        → { token, userId, username }
 *   GET  /api/me              Bearer                        → { userId, username }
 *   POST /api/sync            Bearer { since, changes[] }   → { now, changes[], full? }
 *   GET  /api/snapshot        Bearer                        → 全量任务（新设备首次接入）
 *   GET  /api/health                                        → { ok, stats }
 *   WS   /ws?token=...                                      ← 其他端变更实时推送
 *
 * 启动：node src/server.js   端口默认 8787，可用 PORT / HOST 环境变量覆盖
 */

const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '8mb' }));

/* --------------------------------- CORS --------------------------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* -------------------------------- 鉴权中间件 ------------------------------- */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = auth.verifyToken(token);
  if (!payload) return res.status(401).json({ error: '登录已失效，请重新登录' });
  req.user = payload;
  next();
}

/* --------------------------------- 路由 --------------------------------- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'onederz', version: '1.0.0', time: Date.now(), stats: store.stats() });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  const bad = auth.validateCredentials(username, password);
  if (bad) return res.status(400).json({ error: bad });

  const name = String(username).trim();
  if (store.findUserByName(name)) return res.status(409).json({ error: '该用户名已被注册' });

  const { salt, hash } = auth.hashPassword(password);
  const user = {
    id: 'u_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4),
    username: name,
    salt,
    hash,
    createdAt: Date.now(),
  };
  store.createUser(user);
  res.json({ token: auth.issueToken(user), userId: user.id, username: user.username });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.findUserByName(username);
  if (!user || !auth.verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: '用户名或密码不正确' });
  }
  res.json({ token: auth.issueToken(user), userId: user.id, username: user.username });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ userId: req.user.uid, username: req.user.username });
});

app.get('/api/snapshot', requireAuth, (req, res) => {
  res.json({ now: Date.now(), tasks: Object.values(store.tasksOf(req.user.uid)) });
});

app.post('/api/sync', requireAuth, (req, res) => {
  const { since = 0, changes = [], deviceId = 'unknown' } = req.body || {};
  if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes 必须是数组' });

  const accepted = store.mergeTasks(req.user.uid, changes);
  const now = Date.now();
  // 回拉时多给 2 秒余量，抵消各端时钟微小偏差
  const upstream = store.changesSince(req.user.uid, Math.max(0, Number(since) || 0) - 2000);

  if (accepted.length) {
    broadcast(req.user.uid, accepted, now, deviceId);
  }
  res.json({ now, changes: upstream, accepted: accepted.length });
});

/* -------------------------- WebSocket 实时推送 -------------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const socketsByUser = new Map(); // userId -> Set<WebSocket>

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const payload = auth.verifyToken(url.searchParams.get('token'));
  if (!payload) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = payload.uid;
    ws.username = payload.username;
    ws.isAlive = true;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  if (!socketsByUser.has(ws.userId)) socketsByUser.set(ws.userId, new Set());
  socketsByUser.get(ws.userId).add(ws);
  console.log(`[ws] + ${ws.username} 在线设备 ${socketsByUser.get(ws.userId).size}`);

  ws.send(JSON.stringify({ type: 'hello', username: ws.username, now: Date.now() }));
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (buf) => {
    // 允许客户端通过 WS 直接上报，省一次 HTTP 往返
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'push' && Array.isArray(msg.changes)) {
        const accepted = store.mergeTasks(ws.userId, msg.changes);
        const now = Date.now();
        if (accepted.length) broadcast(ws.userId, accepted, now, msg.deviceId);
        ws.send(JSON.stringify({ type: 'ack', now, accepted: accepted.length }));
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', now: Date.now() }));
      }
    } catch {
      /* 忽略非法消息 */
    }
  });
  ws.on('close', () => {
    socketsByUser.get(ws.userId)?.delete(ws);
  });
});

function broadcast(userId, changes, now, originDeviceId) {
  const set = socketsByUser.get(userId);
  if (!set || !set.size) return;
  const payload = JSON.stringify({ type: 'changes', changes, now, origin: originDeviceId });
  for (const ws of set) {
    if (ws.readyState === 1) {
      try {
        ws.send(payload);
      } catch {
        /* noop */
      }
    }
  }
}

// 心跳，清理半开连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* noop */
    }
  }
}, 30000);

/* --------------------------------- 启动 --------------------------------- */

server.listen(PORT, HOST, () => {
  const lan = Object.values(require('node:os').networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  Onederz 同步服务已启动                       │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  本机   http://127.0.0.1:${PORT}`);
  lan.forEach((ip) => console.log(`  局域网 http://${ip}:${PORT}   ← 手机填这个`));
  console.log(`  数据   ${store.DB_FILE}`);
  console.log(`  账号   请在客户端"设置 → 同步"里注册\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flushNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}

module.exports = { app, server };
