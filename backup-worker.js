'use strict';
const fs = require('fs');
const path = require('path');
const { readDb, withDb } = require('./lib/store');
const rfs = require('./lib/remote-fs');

const raw = process.env.QH_BACKUP_JOB;
if (!raw) process.exit(0);
let job;
try { job = JSON.parse(raw); } catch (_) { process.exit(1); }
const dataDir = path.join(__dirname, 'data');
const statusDir = path.join(dataDir, 'backup-jobs');
const statusFile = path.join(statusDir, `${job.jobId}.json`);

function now() { return new Date().toISOString(); }
function writeStatus(state, extra = {}) {
  try {
    fs.mkdirSync(statusDir, { recursive: true });
    const tmp = `${statusFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ jobId: job.jobId, state, updatedAt: now(), ...extra }));
    fs.renameSync(tmp, statusFile);
  } catch (_) {}
}
function finish(ok, error = null, backup = null) {
  writeStatus(ok ? 'completed' : 'error', { finishedAt: now(), error, backup });
  setTimeout(() => process.exit(ok ? 0 : 1), 20);
}
(async () => {
  writeStatus('running', { startedAt: now(), serverId: job.server?.id || null });
  try {
    if (!job.node?.host || !job.folder || !job.remoteTarget) throw new Error('Nodo o percorso backup non validi');
    const size = rfs.createRemoteTar(job.node, job.folder, job.remoteTarget, { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
    const backup = {
      id: job.backupId,
      ownerId: job.ownerId,
      serverId: job.server.id,
      serverName: job.server.name,
      filename: job.filename,
      path: job.remoteTarget,
      nodeId: job.node.id,
      size,
      createdAt: Date.now(),
      status: 'completed'
    };
    withDb(db => {
      db.backups ||= [];
      db.backups.push(backup);
    });
    finish(true, null, backup);
  } catch (e) {
    try { if (job.node?.host && job.remoteTarget) rfs.remove(job.node, job.remoteTarget); } catch (_) {}
    finish(false, String(e?.message || e).slice(0, 1000));
  }
})();
