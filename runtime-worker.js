'use strict';

const fs = require('fs');
const path = require('path');
const { readDb } = require('./lib/store');
const pm = require('./lib/process-manager');
const rfs = require('./lib/remote-fs');
const storage = require('./lib/node-storage');
const nodeSelector = require('./lib/node-selector');

const DATA_DIR = path.join(__dirname, 'data');
const STATUS_FILE = path.join(DATA_DIR, 'runtime-stats.json');
const LOCK_FILE = path.join(DATA_DIR, 'runtime-worker.lock');

function ensureData() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function now() { return Date.now(); }
function writeAtomic(file, data) {
  try {
    ensureData();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (_) {}
}
function lock() {
  try {
    ensureData();
    if (fs.existsSync(LOCK_FILE)) {
      try {
        const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (old?.pid) { try { process.kill(Number(old.pid), 0); return false; } catch (_) {} }
      } catch (_) {}
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: now() }));
  } catch (_) {}
  return true;
}
function unlock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }
const getDefaultNode = nodeSelector.getDefaultNode;

function getNode(s, db) { return s?.nodeId ? (db.nodes || []).find(n => String(n.id) === String(s.nodeId)) || null : getDefaultNode(db); }
function folder(s, db) {
  const node = getNode(s, db);
  if (!node) return null;
  return storage.serverStorageFolder(s, db, node);
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readCpuSample(line) {
  const raw = String(line || '').trim().split(/\s+/);
  if (raw[0] === 'cpu') raw.shift();
  const parts = raw.map(Number);
  if (parts.length < 4 || parts.some(v => !Number.isFinite(v))) return null;
  const total = parts.reduce((sum, value) => sum + value, 0);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  return { total, idle };
}

function collectNodeStats(node) {
  const empty = {
    online: false,
    hostname: node?.host || '—',
    cpuPercent: 0,
    cpuCores: 0,
    load1: 0,
    ramUsedMB: 0,
    ramTotalMB: 0,
    ramPercent: 0,
    diskUsedMB: 0,
    diskTotalMB: 0,
    diskPercent: 0,
    uptimeSeconds: 0,
    updatedAt: now(),
    error: null,
  };
  if (!node) return empty;

  try {
    const command = [
      "printf 'QH_NODE_STATS\\n'",
      "hostname",
      "nproc",
      "awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat",
      "sleep 2",
      "awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat",
      "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t, a}' /proc/meminfo",
      "df -Pm / | awk 'NR==2 {print $2,$3,$4}'",
      "awk '{print $1}' /proc/uptime",
      "awk '{print $1}' /proc/loadavg",
    ].join('; ');
    const lines = String(rfs.sshRun(node, command, { timeout: 10000 }) || '').split(/\r?\n/).filter(Boolean);
    if (lines[0] !== 'QH_NODE_STATS') throw new Error('Risposta del nodo non valida');

    const cpuA = readCpuSample(lines[3]);
    const cpuB = readCpuSample(lines[4]);
    let cpuPercent = 0;
    if (cpuA && cpuB) {
      const totalDelta = cpuB.total - cpuA.total;
      const idleDelta = cpuB.idle - cpuA.idle;
      if (totalDelta > 0) cpuPercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
    }

    const cores = Number(lines[2]) || 0;
    const mem = String(lines[5] || '').split(/\s+/).map(Number);
    const ramTotalMB = Math.max(0, (mem[0] || 0) / 1024);
    const ramAvailableMB = Math.max(0, (mem[1] || 0) / 1024);
    const ramUsedMB = Math.max(0, ramTotalMB - ramAvailableMB);

    const disk = String(lines[6] || '').split(/\s+/).map(Number);
    const diskTotalMB = Math.max(0, disk[0] || 0);
    const diskUsedMB = Math.max(0, disk[1] || 0);
    const uptimeSeconds = Math.max(0, Number(lines[7]) || 0);
    const load1 = Math.max(0, Number(lines[8]) || 0);

    return {
      online: true,
      hostname: lines[1] || node.host,
      cpuPercent: Number(cpuPercent.toFixed(1)),
      cpuCores: cores,
      load1: Number(load1.toFixed(2)),
      ramUsedMB: Number(ramUsedMB.toFixed(1)),
      ramTotalMB: Number(ramTotalMB.toFixed(1)),
      ramPercent: ramTotalMB > 0 ? Number(((ramUsedMB / ramTotalMB) * 100).toFixed(1)) : 0,
      diskUsedMB,
      diskTotalMB,
      diskPercent: diskTotalMB > 0 ? Number(((diskUsedMB / diskTotalMB) * 100).toFixed(1)) : 0,
      uptimeSeconds: Math.floor(uptimeSeconds),
      updatedAt: now(),
      error: null,
    };
  } catch (error) {
    return { ...empty, error: String(error?.message || error).slice(0, 300) };
  }
}

async function refresh() {
  let db;
  try { db = readDb(); } catch (_) { return; }
  const out = { generatedAt: now(), servers: {} };
  for (const s of (Array.isArray(db.servers) ? db.servers : [])) {
    if (!s || !s.id) continue;
    if (s.suspended || s.migrationStatus === 'pending') {
      out.servers[String(s.id)] = { running:false, cpuPercent:0, ramMB:0, diskMB:0, uptimeSeconds:0, updatedAt:now() };
      continue;
    }
    const node = getNode(s, db);
    const f = folder(s, db);
    if (!node || !f) {
      out.servers[String(s.id)] = { running:false, cpuPercent:0, ramMB:0, diskMB:0, uptimeSeconds:0, updatedAt:now() };
      continue;
    }
    try {
      const srv = { ...s, folder:f };
      const stats = pm.getStats(srv, node) || {};
      let diskMB = 0;
      try { diskMB = pm.refreshDiskUsageIfStale(srv, node, 10000); } catch (_) {}
      out.servers[String(s.id)] = {
        running: !!stats.running,
        cpuPercent: Number(stats.cpuPercent) || 0,
        ramMB: Number(stats.ramMB) || 0,
        diskMB: Number(diskMB) || 0,
        uptimeSeconds: Number(stats.uptimeSeconds) || 0,
        startedAt: stats.startedAt || null,
        updatedAt: now(),
      };
    } catch (_) {
      out.servers[String(s.id)] = { running:false, cpuPercent:0, ramMB:0, diskMB:0, uptimeSeconds:0, updatedAt:now() };
    }
  }
  out.nodes = {};
  for (const node of (Array.isArray(db.nodes) ? db.nodes : [])) {
    if (!node || !node.id) continue;
    out.nodes[String(node.id)] = collectNodeStats(node);
  }
  writeAtomic(STATUS_FILE, out);
}
async function main() {
  if (!lock()) process.exit(0);
  try {
    while (true) {
      await refresh();
      await sleep(5000);
    }
  } finally { unlock(); }
}
main().catch(() => { unlock(); process.exit(1); });
