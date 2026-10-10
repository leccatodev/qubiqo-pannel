'use strict';
const rfs = require('./lib/remote-fs');

const fs = require('fs');
const path = require('path');
const { readDb, withDb } = require('./lib/store');
const storage = require('./lib/node-storage');
const nodeSelector = require('./lib/node-selector');
const pm = require('./lib/process-manager');

const DATA_DIR = path.join(__dirname, 'data');
const STATUS_FILE = path.join(DATA_DIR, 'restore-status.json');
const LOCK_FILE = path.join(DATA_DIR, 'restore-worker.lock');

function now() { return new Date().toISOString(); }
function ensureData() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function writeStatus(status) {
  try {
    ensureData();
    const tmp = `${STATUS_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, STATUS_FILE);
  } catch (_) {}
}

function acquireLock() {
  try {
    ensureData();
    if (fs.existsSync(LOCK_FILE)) {
      try {
        const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (old?.pid) {
          try { process.kill(Number(old.pid), 0); return false; } catch (_) {}
        }
      } catch (_) {}
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: now() }));
    return true;
  } catch (_) { return true; }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

const getDefaultNode = nodeSelector.getDefaultNode;

function getNode(server, db) { return server?.nodeId ? (db.nodes || []).find(n => String(n.id) === String(server.nodeId)) || null : getDefaultNode(db); }
function getFolder(server, db) {
  const node = getNode(server, db);
  if (!node) return null;
  return storage.serverStorageFolder(server, db, node);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitUntilRunning(server, node, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      const payload = JSON.stringify({ server, node });

      const checkCode = `
        const pm = require('./lib/process-manager');
        let data = {};
        try { data = JSON.parse(process.argv[1] || '{}'); } catch (_) {}
        try {
          process.stdout.write(pm.isRunning(data.server, data.node) ? '1' : '0');
        } catch (_) {
          process.stdout.write('0');
        }
      `;

      const { spawnSync } = require('child_process');
      const check = spawnSync(
        process.execPath,
        ['-e', checkCode, payload],
        {
          cwd: __dirname,
          encoding: 'utf8',
          timeout: 12000,
          maxBuffer: 64 * 1024
        }
      );

      if (!check.error && String(check.stdout || '').trim() === '1') {
        return true;
      }
    } catch (_) {}

    await sleep(2000);
  }

  return false;
}

async function main() {
  if (!acquireLock()) process.exit(0);

  const startedAt = now();
  try {
    const db = readDb();
    const servers = Array.isArray(db.servers) ? db.servers : [];
    const candidates = servers.filter(s => s && !s.suspended && s.status === 'running' && s.migrationStatus !== 'pending');
    const skipped = []; 

    const status = {
      state: candidates.length ? 'running' : 'completed',
      startedAt,
      finishedAt: candidates.length ? null : now(),
      total: candidates.length,
      completed: 0,
      online: 0,
      failed: 0,
      skippedNoNode: skipped.length,
      current: null,
      results: [],
    };
    writeStatus(status);

    console.log(`[QubiqoHost] Ripristino bot: ${candidates.length} server.`);

    for (const srv of candidates) {
      const node = getNode(srv, db);
      const folder = getFolder(srv, db);
      status.current = { id: srv.id, name: srv.name, nodeId: srv.nodeId };
      writeStatus(status);

      let result = { ok: false, error: 'Nodo non trovato' };
      try {
        const manualStopFile = folder ? `${folder}/.qbq-runtime/manual-stop` : '';

        if (node && manualStopFile && rfs.exists(node, manualStopFile)) {
          withDb(db2 => {
            const current = (db2.servers || []).find(x => x.id === srv.id);
            if (current) current.status = 'stopped';
          });

          status.completed += 1;
          status.current = null;
          status.results.push({
            id: srv.id,
            name: srv.name,
            nodeId: srv.nodeId,
            ok: true,
            online: false,
            skipped: true,
            error: 'Avvio automatico saltato: server fermato manualmente',
            completedAt: now(),
          });
          writeStatus(status);
          console.log(`[QubiqoHost] ↷ Ripristino saltato: ${srv.name} è stato fermato manualmente.`);
          continue;
        }

        if (node && folder) {
          result = pm.start({ ...srv, folder }, node);
        }
      } catch (err) {
        result = { ok: false, error: String(err?.message || err) };
      }

      let online = false;
      if (result.ok && node) online = await waitUntilRunning({ ...srv, folder }, node);

      status.completed += 1;
      if (online) status.online += 1;
      else status.failed += 1;
      status.results.push({
        id: srv.id,
        name: srv.name,
        nodeId: srv.nodeId,
        ok: !!result.ok,
        online,
        error: result.ok ? null : String(result.error || 'Avvio non riuscito').slice(0, 500),
        completedAt: now(),
      });
      status.current = null;
      writeStatus(status);

      if (online) console.log(`[QubiqoHost] ✓ Server ripristinato e online: ${srv.name}`);
      else console.error(`[QubiqoHost] ✗ Server non confermato online: ${srv.name} — ${result.error || 'timeout avvio'}`);
    }

    status.state = 'completed';
    status.finishedAt = now();
    writeStatus(status);
    console.log(`[QubiqoHost] Ripristino completato: ${status.online}/${status.total} online, ${status.failed} non confermati.`);
  } catch (err) {
    writeStatus({ state: 'error', startedAt, finishedAt: now(), error: String(err?.message || err) });
    console.error('[QubiqoHost] Worker ripristino errore:', err);
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

main();
