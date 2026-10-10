const path = require('path');

function nodeStorageBase(node) {
  if (!node) throw new Error('Nodo non disponibile');
  if (node.storageBase && /^\/[^\0]*$/.test(String(node.storageBase))) {
    return String(node.storageBase).replace(/\/+$/, '') || '/storage';
  }
  const user = String(node.username || '').trim();
  if (user === 'root') return '/root/storage';
  if (/^[a-zA-Z0-9._-]+$/.test(user)) return `/home/${user}/storage`;
  throw new Error('Utente SSH del nodo non valido per lo storage');
}

function safeName(value, fallback = 'item') {
  const name = String(value || '').trim()
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '_')
    .slice(0, 80)
    .trim();
  return name || fallback;
}

function userKey(user) {
  return String(user?.username || user?.id || 'unknown')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 64) || String(user?.id || 'unknown');
}

function userStorageFolder(user, node) {
  if (!user || !node) throw new Error('Utente o nodo non disponibile');
  return path.posix.join(nodeStorageBase(node), userKey(user));
}

function serverStorageFolder(server, db, node) {
  if (!server?.id) throw new Error('Server non valido');
  const targetNode = node || (server.nodeId ? (db?.nodes || []).find(n => n.id === server.nodeId) : null);
  if (!targetNode) throw new Error('Nodo non disponibile per lo storage del server');
  const owner = (db?.users || []).find(u => u.id === server.ownerId);
  const ownerKey = userKey(owner || { id: server.ownerId });
  let serverKey = safeName(server.name, String(server.id));
  const siblings = (db?.servers || []).filter(s => s && s.id !== server.id && s.ownerId === server.ownerId && safeName(s.name, String(s.id)).toLowerCase() === serverKey.toLowerCase());
  if (siblings.length) serverKey = `${serverKey} (${String(server.id).slice(0, 8)})`;
  return path.posix.join(nodeStorageBase(targetNode), ownerKey, serverKey);
}

function backupFolder(node, ownerId) {
  return path.posix.join(nodeStorageBase(node), '.qubiqohost-backups', String(ownerId || 'unknown'));
}

module.exports = { nodeStorageBase, safeName, userKey, userStorageFolder, serverStorageFolder, backupFolder };
