const fs = require('fs');
const path = require('path');
const { readDb, withDb } = require('./lib/store');
const pm = require('./lib/process-manager');
const rfs = require('./lib/remote-fs');
const storage = require('./lib/node-storage');

const raw = process.env.QH_NODE_MIGRATION_JOB;
if (!raw) process.exit(0);

let job;
try { job = JSON.parse(raw); } catch (e) {
  console.error('[node-migration] Job non valido:', e.message);
  process.exit(1);
}

const jobId = String(job.jobId || '');
const userIds = new Set((job.userIds || []).map(String));
const targetNodeId = String(job.targetNodeId || '');
const statusPath = job.jobPath || path.join(__dirname, 'data', `node-migration-${jobId}.json`);

function writeStatus(status) {
  try {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    const tmp = `${statusPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      jobId,
      ...status,
      updatedAt: Date.now(),
    }, null, 2));
    fs.renameSync(tmp, statusPath);
  } catch (e) {
    console.error('[node-migration] Impossibile scrivere stato:', e.message);
  }
}


function safeStorageName(value, fallback = 'server') {
  const name = String(value || '').trim()
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '_')
    .slice(0, 80)
    .trim();
  return name || fallback;
}

function nodeStorageBase(node) { return storage.nodeStorageBase(node); }

function userKeyFor(user) { return storage.userKey(user); }

function serverStorageFolderForNode(server, db, node) { return storage.serverStorageFolder(server, db, node); }

async function main() {
  const db = readDb();
  const targetNode = (db.nodes || []).find(n => n.id === targetNodeId);
  if (!targetNode) throw new Error('Nodo destinazione non trovato');

  const servers = (db.servers || []).filter(s =>
    s && userIds.has(String(s.ownerId)) &&
    s.migrationTargetNodeId === targetNodeId &&
    s.migrationStatus === 'pending'
  );

  writeStatus({ state: 'running', total: servers.length, completed: 0, failed: 0, current: null, errors: [] });
  const backups = (db.backups || []).filter(b => b && userIds.has(String(b.ownerId)) && b.nodeId && String(b.nodeId) !== String(targetNodeId));


  let completed = 0;
  let failed = 0;
  const errors = [];
  const results = [];

  for (const originalServer of servers) {
    const server = { ...originalServer };
    const sourceNode = server.migrationFromNodeSnapshot
      || (server.migrationFromNodeId
        ? (db.nodes || []).find(n => n.id === server.migrationFromNodeId)
        : null);
    const sourcePath = server.migrationFromFolder
      || (sourceNode ? serverStorageFolderForNode(server, db, sourceNode) : null);
    const targetPath = serverStorageFolderForNode(server, db, targetNode);
    writeStatus({
      state: 'running',
      total: servers.length,
      completed,
      failed,
      current: { id: server.id, name: server.name, from: sourceNode?.name || 'pannello', to: targetNode.name },
      errors,
    });

    let wasRunning = false;
    try {
      if (!sourceNode || !sourcePath) {
        throw new Error('Nodo sorgente non disponibile: migrazione interrotta per evitare perdita dei dati');
      } else {
        try { wasRunning = Boolean(pm.isRunning({ ...server, folder: sourcePath }, sourceNode)); } catch (_) {}
        if (wasRunning) pm.stop({ ...server, folder: sourcePath }, sourceNode);
        await new Promise(r => setTimeout(r, 500));
        if (rfs.exists(sourceNode, sourcePath)) {
          await rfs.copyRemoteDirectoryToRemote(sourceNode, sourcePath, targetNode, targetPath, { timeout: 20 * 60 * 1000 });
          if (String(sourceNode.id || '') !== String(targetNode.id || '') || sourcePath !== targetPath) {
            try {
              rfs.remove(sourceNode, sourcePath);
            } catch (removeError) {
              try { rfs.remove(targetNode, targetPath); } catch (_) {}
              throw new Error(`Copia completata ma impossibile rimuovere la sorgente: ${removeError.message}`);
            }
          }
        } else {
          await rfs.mkdir(targetNode, targetPath);
        }
      }

      withDb(db2 => {
        const current = db2.servers.find(x => x.id === server.id);
        if (current) {
          current.nodeId = targetNodeId;
          current.migrationStatus = 'completed';
          current.migrationTargetNodeId = null;
          current.migrationFromNodeId = null;
          current.migrationFromFolder = null;
          current.migrationFromNodeSnapshot = null;
        }
      });

      completed++;
      writeStatus({
        state: 'running',
        total: servers.length,
        completed,
        failed,
        current: null,
        errors,
        completedServer: {
          id: server.id,
          folder: targetPath,
          oldNodeId: server.migrationFromNodeId || null,
          wasRunning,
        },
      });
      results.push({ id: server.id, ok: true, targetNodeId, folder: targetPath, oldNodeId: server.migrationFromNodeId || null, oldFolder: sourcePath, wasRunning });

      if (wasRunning) {
        try {
          const result = pm.start({ ...server, folder: targetPath }, targetNode);
          if (!result?.ok) throw new Error(result?.error || 'Avvio fallito');
        } catch (e) {
          errors.push({ id: server.id, name: server.name, error: `Migrato ma riavvio fallito: ${e.message}` });
        }
      }
    } catch (e) {
      failed++;
      errors.push({ id: server.id, name: server.name, error: String(e.message || e) });
      writeStatus({
        state: 'running',
        total: servers.length,
        completed,
        failed,
        current: null,
        errors,
        results,
        failedServer: {
          id: server.id,
          oldNodeId: server.migrationFromNodeId || null,
          oldFolder: sourcePath,
        },
      });
      results.push({ id: server.id, ok: false, targetNodeId, oldNodeId: server.migrationFromNodeId || null, oldFolder: sourcePath });
    }
  }

  for (const backup of backups) {
    const sourceNode = (db.nodes || []).find(n => n.id === backup.nodeId);
    const targetPath = path.posix.join(nodeStorageBase(targetNode), '.qubiqohost-backups', String(backup.ownerId || 'unknown'), safeStorageName(backup.filename || backup.id, backup.id).replace(/[^a-zA-Z0-9_.-]/g, '_'));
    try {
      if (!sourceNode || !backup.path) throw new Error('Nodo sorgente backup non disponibile');
      await rfs.copyRemoteFileToRemote(sourceNode, backup.path, targetNode, targetPath, { timeout: 300000 });
      let size = Number(backup.size) || 0;
      try { size = rfs.remoteFileSize(targetNode, targetPath); } catch (_) {}
      if (String(sourceNode.id || '') !== String(targetNode.id || '') || String(backup.path) !== String(targetPath)) {
        try {
          rfs.remove(sourceNode, backup.path);
        } catch (removeError) {
          try { rfs.remove(targetNode, targetPath); } catch (_) {}
          throw new Error(`Copia backup completata ma impossibile rimuovere la sorgente: ${removeError.message}`);
        }
      }
      withDb(db2 => {
        const b = db2.backups.find(x => x.id === backup.id);
        if (b) {
          b.nodeId = targetNodeId;
          b.path = targetPath;
          b.size = size;
        }
      });
    } catch (e) {
      errors.push({ id: backup.id, name: backup.filename, error: `Migrazione backup fallita: ${e.message}` });
      failed++;
    }
  }

  writeStatus({
    state: failed ? 'completed_with_errors' : 'completed',
    total: servers.length,
    completed,
    failed,
    current: null,
    errors,
    results,
  });
}

main().catch(e => {
  writeStatus({ state: 'error', total: 0, completed: 0, failed: 0, current: null, errors: [String(e.message || e)] });
  process.exitCode = 1;
});
