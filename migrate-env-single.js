'use strict';

const path = require('path');
const rfs = require('./lib/remote-fs');

const fs = require('fs');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;

    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = value;
    }
  }
}

const { readDb } = require('./lib/store');
const storage = require('./lib/node-storage');

function getServerNode(server, db) {
  if (!server) return null;
  if (server.nodeId) {
    return (db.nodes || []).find(n => String(n.id) === String(server.nodeId)) || null;
  }
  return null;
}

function serverFolder(server, db, node) {
  if (!server?.id) throw new Error('Server non valido');
  return storage.serverStorageFolder(
    { ...server, nodeId: node.id },
    db,
    node
  );
}

function parseEnv(content) {
  const values = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;

    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[m[1]] = value;
  }
  return values;
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value ?? ''));
}

(async () => {
  const db = readDb();
  const servers = Array.isArray(db.servers) ? db.servers : [];

  console.log(`[QubiqoHost] Migrazione .env: ${servers.length} server trovati.`);

  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const srv of servers) {
    const name = srv.name || srv.id || 'server';
    try {
      const node = getServerNode(srv, db);
      if (!node) {
        console.log(`[SKIP] ${name}: nodo non disponibile`);
        skipped++;
        continue;
      }

      const folder = serverFolder(srv, db, node);
      const envPath = path.posix.join(folder, '.env');
      const backupPath = `${envPath}.bak-env-migration`;

      const original = rfs.readFile(node, envPath);
      const env = parseEnv(original);

      const isNode = String(srv.language || '').toLowerCase() === 'nodejs';
      const keepKey = isNode ? 'DISCORD_TOKEN' : 'BOT_TOKEN';
      const removeKey = isNode ? 'BOT_TOKEN' : 'DISCORD_TOKEN';

      const token = env[keepKey] || env[removeKey];

      if (!token) {
        console.log(`[SKIP] ${name}: nessun token trovato`);
        skipped++;
        continue;
      }

      // Backup remoto prima di qualsiasi modifica.
      rfs.sshRun(
        node,
        `cp ${rfs.q(envPath)} ${rfs.q(backupPath)} && chmod 600 ${rfs.q(backupPath)}`,
        { timeout: 15000 }
      );

      // Mantiene eventuali altre variabili .env dell'utente.
      const output = [];
      const seen = new Set();

      for (const line of String(original).split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);

        if (!m) {
          if (line.trim() !== '') output.push(line);
          continue;
        }

        const key = m[1];

        if (key === keepKey || key === removeKey) {
          if (key === keepKey) {
            if (seen.has(keepKey)) continue;
            output.push(`${keepKey}=${quoteEnvValue(token)}`);
            seen.add(keepKey);
          }
          continue;
        }

        output.push(line);
      }

      if (!seen.has(keepKey)) {
        output.unshift(`${keepKey}=${quoteEnvValue(token)}`);
      }

      const finalContent = `${output.join('\n')}\n`;

      rfs.writeFile(node, envPath, finalContent);

      rfs.sshRun(
        node,
        `chmod 600 ${rfs.q(envPath)}`,
        { timeout: 10000 }
      );

      console.log(`[OK] ${name}: mantenuta ${keepKey}, rimossa ${removeKey}`);
      changed++;
    } catch (err) {
      console.error(`[ERR] ${name}: ${err.message || err}`);
      failed++;
    }
  }

  console.log('');
  console.log(`[QubiqoHost] Migrazione completata.`);
  console.log(`  Modificati: ${changed}`);
  console.log(`  Saltati:    ${skipped}`);
  console.log(`  Errori:     ${failed}`);
})();
