const crypto = require('crypto');
const mysql = require('./mysql');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const sessionCache = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  mysql.createSession(token, userId, expires);
  sessionCache.set(token, { userId, expires });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const cached = sessionCache.get(token);
  if (cached) {
    if (cached.expires > Date.now()) return cached;
    sessionCache.delete(token);
    return null;
  }
  const session = mysql.getSession(token);
  if (session) sessionCache.set(token, session);
  return session;
}


const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const sessionCleanupTimer = setInterval(() => {
  try { mysql.cleanupSessions(); } catch (err) {
    console.warn('[auth] Pulizia sessioni fallita:', err.message || err);
  }
}, SESSION_CLEANUP_INTERVAL_MS);
if (typeof sessionCleanupTimer.unref === 'function') sessionCleanupTimer.unref();

function destroySession(token) {
  if (!token) return;
  sessionCache.delete(token);
  mysql.destroySession(token);
}

function destroyUserSessions(userId) {
  if (!userId) return;
  for (const [token, session] of sessionCache) {
    if (session.userId === userId) sessionCache.delete(token);
  }
  mysql.destroyUserSessions(userId);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;

  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });

  return out;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  destroyUserSessions,
  parseCookies,
};
