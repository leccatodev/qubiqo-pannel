'use strict';

function getDefaultNode(db) {
  const nodes = Array.isArray(db?.nodes) ? db.nodes.filter(Boolean) : [];
  if (!nodes.length) return null;
  const envId = String(process.env.DEFAULT_NODE_ID || '').trim();
  if (envId) return nodes.find(n => String(n.id) === envId) || null;
  const marked = nodes.filter(n => n.isDefault === true);
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) throw new Error('Configurazione non valida: sono presenti più nodi predefiniti');
  if (nodes.length === 1) return nodes[0];
  return null;
}

function getNodeById(db, id) {
  if (!id) return null;
  return (Array.isArray(db?.nodes) ? db.nodes : []).find(n => String(n.id) === String(id)) || null;
}

function getRequiredNodeById(db, id) {
  const node = getNodeById(db, id);
  if (!node) throw new Error('Nodo assegnato al server non trovato');
  return node;
}

function resolveNode(db, id) {
  return id ? getNodeById(db, id) : getDefaultNode(db);
}

module.exports = { getDefaultNode, getNodeById, getRequiredNodeById, resolveNode };
