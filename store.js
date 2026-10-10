const fs = require('fs');
const path = require('path');
const mysql = require('./mysql');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'db.json');
const WRITE_LOCK_PATH = path.join(DATA_DIR, 'db-write.lock');
const VERSION_PATH = path.join(DATA_DIR, 'db-version');
let stateLoadedAt = 0;




let stateCache = null;
let stateLoaded = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeDb(db) {
  db ||= {};
  db.users ||= [];
  db.servers ||= [];
  db.billing ||= {};
  db.billing.transactions ||= [];
  db.billing.packages ||= [
    { id: 'credits_100', credits: 100, amountCents: 500, label: '100 crediti' },
    { id: 'credits_250', credits: 250, amountCents: 1000, label: '250 crediti' },
    { id: 'credits_600', credits: 600, amountCents: 2000, label: '600 crediti' },
  ];
  db.billing.settings ||= { slotCreditCost: 100, currency: 'EUR' };
  db.databases ||= [];
  db.backups ||= [];
  db.network ||= [];
  db.subusers ||= [];
  db.nodes ||= [];
  db.tickets ||= [];
  db.auditLogs ||= [];
  db.settings ||= {};
  
  
  for (const server of db.servers) {
    if (!server) continue;
    server.cpuCores = 0.5;
    delete server.cpuPercent;
  }
  for (const user of db.users) {
    if (!['user', 'staff', 'tester', 'admin'].includes(user.role)) user.role = 'user';
    if (!Number.isFinite(user.slots)) user.slots = 1;
    if (!Number.isFinite(user.credits)) user.credits = 0;
  }
  return db;
}

function importLegacyIfNeeded() {
  const current = mysql.getState();
  if (current) return normalizeDb(current);

  ensureDataDir();
  if (fs.existsSync(LEGACY_DB_PATH)) {
    try {
      const legacy = normalizeDb(JSON.parse(fs.readFileSync(LEGACY_DB_PATH, 'utf8')));
      mysql.setState(legacy, false);
      return legacy;
    } catch {
      throw new Error('Database legacy non valido: impossibile importare data/db.json.');
    }
  }

  const empty = normalizeDb({ users: [], servers: [] });
  mysql.setState(empty, false);
  return empty;
}

function loadRaw() {
  if (stateLoaded) {
    try {
      const mtime = fs.statSync(VERSION_PATH).mtimeMs;
      if (mtime <= stateLoadedAt) return stateCache;
    } catch (_) { return stateCache; }
    try {
      const fresh = mysql.getState();
      if (fresh) { stateCache = normalizeDb(fresh); stateLoadedAt = Date.now(); return stateCache; }
    } catch (_) {}
    return stateCache;
  }
  stateCache = importLegacyIfNeeded();
  stateLoaded = true;
  stateLoadedAt = Date.now();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(VERSION_PATH, String(Date.now())); } catch (_) {}
  return stateCache;
}

function saveRaw(db) {
  const normalized = normalizeDb(db);
  mysql.setState(normalized, true);
  stateCache = normalized;
  stateLoaded = true;
  stateLoadedAt = Date.now();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(VERSION_PATH, String(stateLoadedAt)); } catch (_) {}
}

function acquireWriteLock() {
  ensureDataDir();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(WRITE_LOCK_PATH, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      return fd;
    } catch (_) {
      try {
        const stat = fs.statSync(WRITE_LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 30000) fs.unlinkSync(WRITE_LOCK_PATH);
      } catch (_) {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw new Error('Impossibile ottenere il lock locale del database');
}

function releaseWriteLock(fd) {
  try { fs.closeSync(fd); } catch (_) {}
  try { fs.unlinkSync(WRITE_LOCK_PATH); } catch (_) {}
}

function withDb(fn) {
  const fd = acquireWriteLock();
  try {
    const fresh = mysql.getState();
    const db = normalizeDb(fresh || {});
    const result = fn(db);
    saveRaw(db);
    return result;
  } finally {
    releaseWriteLock(fd);
  }
}

function readDb() {
  return loadRaw();
}

module.exports = { readDb, withDb };
