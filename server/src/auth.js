/**
 * Onederz 同步服务 · 账号与令牌
 * 口令用 scrypt + 随机盐；令牌是自签的 HMAC（无第三方依赖），
 * 泄露风险可控，适合自建的私有同步服务。
 */

const crypto = require('node:crypto');

const SECRET =
  process.env.ONEDERZ_SECRET ||
  // 未显式配置时，在数据目录持久化一个随机密钥，重启不掉线
  (() => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '.secret');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  })();

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 天

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(String(password), salt, 64);
  const want = Buffer.from(expected, 'hex');
  return actual.length === want.length && crypto.timingSafeEqual(actual, want);
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function issueToken(user) {
  return sign({ uid: user.id, username: user.username, exp: Date.now() + TOKEN_TTL_MS });
}

/** 校验账号格式，返回错误信息或 null */
function validateCredentials(username, password) {
  const u = String(username || '').trim();
  if (u.length < 2 || u.length > 32) return '用户名需为 2–32 个字符';
  if (!/^[\w.@-]+$/.test(u)) return '用户名只能包含字母、数字、下划线、点、@ 或减号';
  if (String(password || '').length < 4) return '密码至少 4 位';
  return null;
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, validateCredentials };
