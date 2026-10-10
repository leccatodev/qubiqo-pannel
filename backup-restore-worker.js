'use strict';
const fs = require('fs');
const path = require('path');
const { readDb, withDb } = require('./lib/store');
const pm = require('./lib/process-manager');
const rfs = require('./lib/remote-fs');

const raw = process.env.QH_BACKUP_RESTORE_JOB;
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
function finish(ok, error = null) {
  writeStatus(ok ? 'completed' : 'error', { finishedAt: now(), error });
  setTimeout(() => process.exit(ok ? 0 : 1), 20);
}
(async () => {
  writeStatus('running', { startedAt: now(), serverId: job.server?.id || null });
  try {
    if (!job.node?.host || !job.folder || !job.remoteBackupPath) throw new Error('Nodo o percorso backup non validi');
    const srv = { ...job.server, folder: job.folder };
    const wasRunning = !!pm.isRunning(srv, job.node);
    if (wasRunning) pm.stop(srv, job.node);
    const tempFolder = `${job.folder}.restore-${job.jobId}`;
    const oldFolder = `${job.folder}.previous-${job.jobId}`;
    rfs.sshRun(job.node, `rm -rf ${rfs.q(tempFolder)} ${rfs.q(oldFolder)} && mkdir -p ${rfs.q(tempFolder)}`, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    try {
      rfs.extractRemoteTar(job.node, job.remoteBackupPath, tempFolder, { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
      try { rfs.remove(job.node, `${tempFolder}/.qbq-runtime`); } catch (_) {}
      rfs.sshRun(job.node, `if [ -d ${rfs.q(job.folder)} ]; then mv -T ${rfs.q(job.folder)} ${rfs.q(oldFolder)}; fi && mv -T ${rfs.q(tempFolder)} ${rfs.q(job.folder)} && rm -rf ${rfs.q(oldFolder)}`, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    } catch (restoreError) {
      try { if (!rfs.exists(job.node, job.folder) && rfs.exists(job.node, oldFolder)) rfs.rename(job.node, oldFolder, job.folder); } catch (_) {}
      try { rfs.remove(job.node, tempFolder); } catch (_) {}
      try { rfs.remove(job.node, oldFolder); } catch (_) {}
      throw restoreError;
    }
    if (wasRunning && !job.server.suspended) {
      const result = pm.start(srv, job.node);
      withDb(db => {
        const current = db.servers.find(s => s.id === job.server.id);
        if (current) current.status = result.ok ? 'running' : 'stopped';
      });
      if (!result.ok) throw new Error(`Backup ripristinato ma riavvio fallito: ${result.error || 'errore sconosciuto'}`);
    }
    finish(true);
  } catch (e) {
    finish(false, String(e?.message || e).slice(0, 1000));
  }
})();
