'use strict';
const pm = require('./lib/process-manager');
const rfs = require('./lib/remote-fs');
const raw = process.env.QH_PM_ACTION;
if (!raw) process.exit(0);
let job;
try { job = JSON.parse(raw); } catch (_) { process.exit(1); }
function result(ok, error = null, data = {}) {
  if (process.send) { try { process.send({ ok, error, ...data }); } catch (_) {} }
  setTimeout(() => process.exit(ok ? 0 : 1), 20);
}
(async () => {
  const server = job.server || {};
  const node = job.node || null;
  const folder = server.folder || '';
  try {
    if (process.env.PANEL_MAINTENANCE === '1' && (job.action === 'start' || job.action === 'restart')) {
      return result(false, 'Pannello in manutenzione: avvio e riavvio dei bot disabilitati');
    }
    const manualStopFile = folder ? `${folder}/.qbq-runtime/manual-stop` : '';

    if (job.action === 'start') {
      if (node && manualStopFile) {
        try { rfs.remove(node, manualStopFile); } catch (_) {}
      }
      const r = pm.start(server, node);
      return result(!!r?.ok, r?.ok ? null : (r?.error || 'Avvio non riuscito'));
    }

    if (job.action === 'stop') {
      if (node && manualStopFile) {
        try {
          rfs.mkdir(node, `${folder}/.qbq-runtime`);
          rfs.writeFile(node, manualStopFile, `manual-stop ${new Date().toISOString()}\\n`);
        } catch (_) {}
      }

      const r = pm.stop(server, node);

      if (!r?.ok && node && manualStopFile) {
        try { rfs.remove(node, manualStopFile); } catch (_) {}
      }

      return result(!!r?.ok, r?.ok ? null : (r?.error || 'Arresto non riuscito'));
    }

    if (job.action === 'restart') {
      if (node && manualStopFile) {
        try { rfs.remove(node, manualStopFile); } catch (_) {}
      }
      const r = pm.restart(server, node);
      return result(!!r?.ok, r?.ok ? null : (r?.error || 'Riavvio non riuscito'));
    }
    if (job.action === 'command') { const r = pm.sendCommand(server, node, job.command); return result(!!r?.ok, r?.ok ? null : (r?.error || 'Comando non riuscito')); }
    if (job.action === 'delete') {
      let ok = true;
      try { if (node && folder) { const stop = pm.stop(server, node); ok = stop.ok !== false; } } catch (_) { ok = false; }
      try {
        if (!node || !folder) throw new Error('Nodo remoto o cartella server non disponibili');
        rfs.remove(node, folder);
      } catch (_) { ok = false; }
      return result(ok, ok ? null : 'Impossibile completare l eliminazione remota');
    }
    return result(false, 'Azione non supportata');
  } catch (e) { return result(false, e.message || String(e)); }
})();
