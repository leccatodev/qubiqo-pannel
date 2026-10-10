const path = require('path');
const rfs = require('./remote-fs');
const storage = require('./node-storage');

function sanitizeName(str) {
  return String(str || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function ensureUserStorage(node, username, serverName) {
  if (!node) throw new Error('Nodo remoto obbligatorio');
  const targetPath = path.posix.join(storage.nodeStorageBase(node), storage.userKey({ username }), storage.safeName(serverName, 'server'));
  rfs.mkdir(node, targetPath);
  return targetPath;
}

function moveServerFilesToNodePath(node, username, serverName, oldPath) {
  if (!node) throw new Error('Nodo remoto obbligatorio');
  const targetPath = ensureUserStorage(node, username, serverName);
  if (oldPath && String(oldPath).startsWith('/') && oldPath !== targetPath) {
    const old = rfs.q(oldPath);
    const target = rfs.q(targetPath);
    rfs.sshRun(node, `if [ -d ${old} ]; then cp -an ${old}/. ${target}/ 2>/dev/null || true; fi`, { timeout: 120000 });
  }
  return targetPath;
}

module.exports = { ensureUserStorage, moveServerFilesToNodePath };
