const { execFileSync } = require('child_process');

function env(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

const HOST = env('MYSQL_HOST', '127.0.0.1');
const PORT = env('MYSQL_PORT', '3306');
const USER = env('MYSQL_USER', 'qubiqohost');
const PASSWORD = process.env.MYSQL_PASSWORD || '';
const DATABASE = env('MYSQL_DATABASE', 'qubiqohost');
const MYSQL_BIN = env('MYSQL_BIN', 'mysql');





let schemaReady = false;

function identifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Identificatore MySQL non valido: ${value}`);
  }
  return `\`${value}\``;
}

function run(sql, database = null) {
  const args = [
    '-h', HOST,
    '-P', PORT,
    '-u', USER,
    '--batch',
    '--raw',
    '--skip-column-names',
  ];

  if (database) args.push(database);
  
  
  
  
  const result = execFileSync(MYSQL_BIN, args, {
    input: String(sql),
    encoding: 'utf8',
    env: { ...process.env, MYSQL_PWD: PASSWORD },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });

  return result.trim();
}

function ensureDatabase() {
  if (schemaReady) return;

  const db = identifier(DATABASE);
  run(`CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  run(`
    CREATE TABLE IF NOT EXISTS ${db}.app_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      state LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;

    CREATE TABLE IF NOT EXISTS ${db}.app_state_backups (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      state LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB;

    CREATE TABLE IF NOT EXISTS ${db}.sessions (
      token CHAR(64) NOT NULL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      expires BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sessions_user (user_id),
      INDEX idx_sessions_expires (expires)
    ) ENGINE=InnoDB;
  `);

  schemaReady = true;
}

function escapeBase64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function getState() {
  ensureDatabase();
  const db = identifier(DATABASE);
  const out = run(`SELECT state FROM ${db}.app_state WHERE id=1;`, DATABASE);
  if (!out) return null;
  return JSON.parse(out);
}

function setState(state, backup = true) {
  ensureDatabase();
  const db = identifier(DATABASE);
  const encoded = escapeBase64(JSON.stringify(state));

  
  
  
  const statements = [];
  if (backup) {
    statements.push(`INSERT INTO ${db}.app_state_backups (state) SELECT state FROM ${db}.app_state WHERE id=1;`);
    statements.push(`DELETE FROM ${db}.app_state_backups WHERE id NOT IN (SELECT id FROM (SELECT id FROM ${db}.app_state_backups ORDER BY id DESC LIMIT 20) keep_ids);`);
  }
  statements.push(`INSERT INTO ${db}.app_state (id, state) VALUES (1, FROM_BASE64('${encoded}')) ON DUPLICATE KEY UPDATE state=VALUES(state), updated_at=CURRENT_TIMESTAMP;`);

  run(statements.join('\n'), DATABASE);
}

function withLock(fn) {
  ensureDatabase();
  const lockName = 'qubiqohost_app_state';
  const acquired = run(`SELECT GET_LOCK('${lockName}', 10);`, DATABASE);
  if (acquired !== '1') throw new Error('Impossibile ottenere il lock del database MySQL');
  try {
    return fn();
  } finally {
    try { run(`SELECT RELEASE_LOCK('${lockName}');`); } catch (_) {}
  }
}

function getSession(token) {
  if (!token) return null;
  ensureDatabase();
  const db = identifier(DATABASE);
  const encodedToken = escapeBase64(token);
  const out = run(`SELECT user_id, expires FROM ${db}.sessions WHERE token=FROM_BASE64('${encodedToken}') AND expires > ${Date.now()} LIMIT 1;`, DATABASE);
  if (!out) return null;
  const [userId, expires] = out.split('\t');
  if (!userId || !expires) return null;
  return { userId, expires: Number(expires) };
}

function createSession(token, userId, expires) {
  ensureDatabase();
  const db = identifier(DATABASE);
  const t = escapeBase64(token);
  const u = escapeBase64(userId);
  run(`INSERT INTO ${db}.sessions (token, user_id, expires) VALUES (FROM_BASE64('${t}'), FROM_BASE64('${u}'), ${Number(expires)});`, DATABASE);
}

function destroySession(token) {
  if (!token) return;
  ensureDatabase();
  const db = identifier(DATABASE);
  const t = escapeBase64(token);
  run(`DELETE FROM ${db}.sessions WHERE token=FROM_BASE64('${t}');`, DATABASE);
}

function destroyUserSessions(userId) {
  if (!userId) return;
  ensureDatabase();
  const db = identifier(DATABASE);
  const u = escapeBase64(userId);
  run(`DELETE FROM ${db}.sessions WHERE user_id=FROM_BASE64('${u}');`, DATABASE);
}

function cleanupSessions() {
  ensureDatabase();
  const db = identifier(DATABASE);
  run(`DELETE FROM ${db}.sessions WHERE expires <= ${Date.now()};`, DATABASE);
}

module.exports = {
  ensureDatabase,
  getState,
  setState,
  withLock,
  getSession,
  createSession,
  destroySession,
  destroyUserSessions,
  cleanupSessions,
  DATABASE,
};
