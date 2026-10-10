const { execFileSync } = require('child_process');
const rfs = require('./remote-fs');

const RUNTIME_DIR = '.qbq-runtime';
const MAX_LOG_LINES = 300;
const diskCache = new Map();
const stateCache = new Map();
const STATE_TTL_MS = 2000;
const LOG_TTL_MS = 1000;
const logCache = new Map();

function q(s) { return rfs.q(s); }

function runtimePaths(folder) {
  const base = `${folder}/${RUNTIME_DIR}`;
  return {
    base,
    pidFile: `${base}/server.pid`,
    logFile: `${base}/server.log`,
    startFile: `${base}/started_at`,
    scriptFile: `${base}/start.sh`,
    inputFile: `${base}/stdin.pipe`,
    pgidFile: `${base}/server.pgid`,
  };
}

function parseEnvContent(content) {
  const env = {};
  if (!content) return env;
  const normalized = String(content).replace(/^\uFEFF/, '');
  for (const rawLine of normalized.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^export\s+/i.test(line)) line = line.replace(/^export\s+/i, '');
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.search(/\s+#/);
      if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    }
    env[key] = value;
  }
  return env;
}

function readAnyToken(fileEnv, fallbackToken = '') {
  const preferred = ['DISCORD_TOKEN', 'DISCORD_BOT_TOKEN', 'BOT_TOKEN', 'TOKEN'];
  for (const key of preferred) {
    const value = String(fileEnv[key] ?? '').trim();
    if (value) return value;
  }
  for (const [key, value] of Object.entries(fileEnv)) {
    if (/TOKEN/i.test(key) && String(value || '').trim()) return String(value).trim();
  }
  return String(fallbackToken || '').trim();
}

function findStartupFile(node, folder, language) {
  const candidates = language === 'python'
    ? ['main.py', 'bot.py', 'index.js', 'server.js']
    : ['index.js', 'server.js', 'main.py', 'bot.py'];

  for (const filename of candidates) {
    if (rfs.exists(node, `${folder}/${filename}`)) return filename;
  }

  return null;
}

function installNodeDependencies(node, folder) {
  let pkgContent;

  try {
    pkgContent = rfs.readFile(node, `${folder}/package.json`);
  } catch (_) {
    return { ok: true };
  }

  if (!pkgContent || !pkgContent.trim()) return { ok: true };

  let packageData;

  try {
    packageData = JSON.parse(pkgContent);
  } catch (e) {
    return {
      ok: false,
      error: `package.json non valido: ${e.message}`
    };
  }

  const hasDependencies = packageData && (
    (packageData.dependencies && Object.keys(packageData.dependencies).length) ||
    (packageData.devDependencies && Object.keys(packageData.devDependencies).length)
  );

  if (!hasDependencies) return { ok: true };

  
  
  
  
  
  
  const rp = runtimePaths(folder);
  const hashFile = `${rp.base}/deps.hash`;
  const crypto = require('crypto');
  const currentHash = crypto.createHash('sha1').update(pkgContent).digest('hex');

  try {
    const hasNodeModules = rfs.exists(node, `${folder}/node_modules`);
    const previousHash = rfs.exists(node, hashFile)
      ? String(rfs.readFile(node, hashFile) || '').trim()
      : '';

    if (hasNodeModules && previousHash === currentHash) {
      return { ok: true };
    }
  } catch (_) {
    
  }

  try {
    rfs.sshRun(
      node,
      `cd ${q(folder)} && CI=1 npm install --no-audit --no-fund`,
      {
        timeout: 300000,
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    try {
      rfs.mkdir(node, rp.base);
      rfs.writeFile(node, hashFile, currentHash);
    } catch (_) {}

    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: 'npm install fallito sul nodo remoto: ' +
        String(e.stderr || e.message || e).slice(0, 500)
    };
  }
}

function processMatchesCommand(startupFile) {
  const base = String(startupFile || '').split('/').pop();
  return `case "$A" in *"/${base}"*|*" ${base}"*|*"${base}"*) echo "$P"; exit 0;; esac`;
}

function findRunningPid(server, node, writeRuntime = true) {
  if (!node || !server || !server.folder) return null;

  const folder = server.folder;
  const rp = runtimePaths(folder);
  let startupFile = null;
  try { startupFile = findStartupFile(node, folder, server.language); } catch (_) {}
  if (!startupFile) return null;

  const matcher = processMatchesCommand(startupFile);
  const command =
    `F=${q(folder)}; ` +
    `for P in $(ps -eo pid= 2>/dev/null); do ` +
    `[ "$P" = "$$" ] && continue; ` +
    `C=$(readlink -f "/proc/$P/cwd" 2>/dev/null) || continue; ` +
    `[ "$C" = "$F" ] || continue; ` +
    `A=$(tr '\0' ' ' < "/proc/$P/cmdline" 2>/dev/null) || continue; ` +
    `${matcher}; ` +
    `done; exit 1`;

  let pid = null;
  try {
    const out = rfs.sshRun(node, command, { timeout: 10000, maxBuffer: 512 * 1024 });
    const match = String(out).match(/^\s*(\d+)\s*$/m);
    if (match) pid = Number(match[1]);
  } catch (_) {}

  if (pid && writeRuntime) {
    try {
      rfs.mkdir(node, rp.base);
      rfs.sshRun(node, `echo ${q(String(pid))} > ${q(rp.pidFile)}`, { timeout: 8000 });
      if (!rfs.exists(node, rp.startFile)) rfs.sshRun(node, `date +%s > ${q(rp.startFile)}`, { timeout: 8000 });
    } catch (_) {}
  }
  return pid;
}

function getPidFromRuntime(server, node) {
  const rp = runtimePaths(server.folder);
  const folder = server.folder;
  let startupFile = null;
  try { startupFile = findStartupFile(node, folder, server.language); } catch (_) {}
  try {
    const command =
      `P=$(cat ${q(rp.pidFile)} 2>/dev/null); ` +
      `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then ` +
      `C=$(readlink -f "/proc/$P/cwd" 2>/dev/null); ` +
      `A=$(tr '\0' ' ' < "/proc/$P/cmdline" 2>/dev/null); ` +
      `if [ "$C" = ${q(folder)} ]; then ` +
      (startupFile
        ? `case "$A" in *"/${String(startupFile).split('/').pop()}"*|*" ${String(startupFile).split('/').pop()}"*) echo "$P";; esac;`
        : `echo "$P";`) +
      ` fi; fi`;
    const out = rfs.sshRun(node, command, { timeout: 8000 });
    const match = String(out).match(/^\s*(\d+)\s*$/m);
    return match ? Number(match[1]) : null;
  } catch (_) { return null; }
}

function getRunningPid(server, node, writeRuntime = true) {
  const actualPid = findRunningPid(server, node, writeRuntime);
  if (actualPid) return actualPid;
  return getPidFromRuntime(server, node);
}

function isRunning(server, node) {
  if (!node || !server || !server.folder) return false;
  const pid = getRunningPid(server, node, true);
  const running = !!pid;
  stateCache.set(server.id, { ts: Date.now(), running, pid: pid || null });
  return running;
}

function installNodeDependencies(node, folder) {
  let pkgContent;

  try {
    pkgContent = rfs.readFile(node, `${folder}/package.json`);
  } catch (_) {
    return { ok: true };
  }

  if (!pkgContent || !pkgContent.trim()) return { ok: true };

  let packageData;

  try {
    packageData = JSON.parse(pkgContent);
  } catch (e) {
    return {
      ok: false,
      error: `package.json non valido: ${e.message}`
    };
  }

  const hasDependencies = packageData && (
    (packageData.dependencies && Object.keys(packageData.dependencies).length) ||
    (packageData.devDependencies && Object.keys(packageData.devDependencies).length)
  );

  if (!hasDependencies) return { ok: true };

  
  
  
  
  
  
  const rp = runtimePaths(folder);
  const hashFile = `${rp.base}/deps.hash`;
  const crypto = require('crypto');
  const currentHash = crypto.createHash('sha1').update(pkgContent).digest('hex');

  try {
    const hasNodeModules = rfs.exists(node, `${folder}/node_modules`);
    const previousHash = rfs.exists(node, hashFile)
      ? String(rfs.readFile(node, hashFile) || '').trim()
      : '';

    if (hasNodeModules && previousHash === currentHash) {
      return { ok: true };
    }
  } catch (_) {
    
  }

  try {
    rfs.sshRun(
      node,
      `cd ${q(folder)} && CI=1 npm install --no-audit --no-fund`,
      {
        timeout: 300000,
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    try {
      rfs.mkdir(node, rp.base);
      rfs.writeFile(node, hashFile, currentHash);
    } catch (_) {}

    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: 'npm install fallito sul nodo remoto: ' +
        String(e.stderr || e.message || e).slice(0, 500)
    };
  }
}

function processMatchesCommand(startupFile) {
  const base = String(startupFile || '').split('/').pop();

  if (base === 'main.py' || base === 'bot.py') {
    return `case "$A" in *"python3 ${base}"*|*"python ${base}"*|*"/python3 ${base}"*|*"/python ${base}"*) echo "$P"; exit 0;; esac`;
  }

  return `case "$A" in *"node ${base}"*|*"nodejs ${base}"*|*"/node ${base}"*|*"/nodejs ${base}"*) echo "$P"; exit 0;; esac`;
}

function findRunningPid(server, node, writeRuntime = true) {
  if (!node || !server || !server.folder) return null;

  const folder = server.folder;
  const rp = runtimePaths(folder);

  let startupFile = null;

  try {
    startupFile = findStartupFile(node, folder, server.language);
  } catch (_) {}

  if (!startupFile) return null;

  const matcher = processMatchesCommand(startupFile);

  const command =
    `F=${q(folder)}; ` +
    `for P in $(ps -eo pid= 2>/dev/null); do ` +
    `[ "$P" = "$$" ] && continue; ` +
    `C=$(readlink -f "/proc/$P/cwd" 2>/dev/null) || continue; ` +
    `[ "$C" = "$F" ] || continue; ` +
    `A=$(tr '\\0' ' ' < "/proc/$P/cmdline" 2>/dev/null) || continue; ` +
    `case "$A" in *"${startupFile}"*) ${matcher};; esac; ` +
    `done; exit 1`;

  let pid = null;

  try {
    const out = rfs.sshRun(
      node,
      command,
      {
        timeout: 10000,
        maxBuffer: 512 * 1024
      }
    );

    const match = String(out).match(/\d+/);

    if (match) {
      pid = Number(match[0]);
    }
  } catch (_) {}

  if (pid && writeRuntime) {
    try {
      rfs.mkdir(node, rp.base);

      rfs.sshRun(
        node,
        `echo ${q(String(pid))} > ${q(rp.pidFile)}`,
        { timeout: 8000 }
      );

      if (!rfs.exists(node, rp.startFile)) {
        rfs.sshRun(
          node,
          `date +%s > ${q(rp.startFile)}`,
          { timeout: 8000 }
        );
      }
    } catch (_) {}
  }

  return pid;
}

function getPidFromRuntime(server, node) {
  const rp = runtimePaths(server.folder);
  const folder = server.folder;

  let startupFile = null;
  try {
    startupFile = findStartupFile(node, folder, server.language);
  } catch (_) {}

  try {
    const command =
      `P=$(cat ${q(rp.pidFile)} 2>/dev/null); ` +
      `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then ` +
      `C=$(readlink -f "/proc/$P/cwd" 2>/dev/null); ` +
      `A=$(tr '\\0' ' ' < "/proc/$P/cmdline" 2>/dev/null); ` +
      `if [ "$C" = ${q(folder)} ]; then ` +
      (startupFile
        ? `if printf '%s' "$A" | grep -F -- ${q(startupFile)} >/dev/null 2>&1; then echo "$P"; fi;`
        : `echo "$P";`) +
      ` fi; fi`;

    const out = rfs.sshRun(node, command, { timeout: 8000 });
    const match = String(out).match(/^\s*(\d+)\s*$/m);
    return match ? Number(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function getRunningPid(server, node, writeRuntime = true) {
  
  
  const actualPid = findRunningPid(server, node, writeRuntime);
  if (actualPid) return actualPid;

  return getPidFromRuntime(server, node);
}

function isRunning(server, node) {
  if (!node || !server || !server.folder) return false;

  const cached = stateCache.get(server.id);

  if (cached && Date.now() - cached.ts < STATE_TTL_MS) {
    return cached.running;
  }

  const pid = getRunningPid(server, node, true);
  const running = !!pid;

  stateCache.set(server.id, {
    ts: Date.now(),
    running,
    pid: pid || null
  });

  return running;
}

function start(server, node) {
  if (!node) {
    return {
      ok: false,
      error: 'Nessun nodo assegnato a questo server'
    };
  }

  const folder = server.folder;

  if (!folder) {
    return {
      ok: false,
      error: 'Cartella server non configurata'
    };
  }

  const alreadyRunningPid = getRunningPid(server, node, true);

  if (alreadyRunningPid) {
    stateCache.set(server.id, {
      ts: Date.now(),
      running: true,
      pid: alreadyRunningPid
    });

    return {
      ok: true,
      alreadyRunning: true,
      pid: alreadyRunningPid,
      message: 'Il server è già in esecuzione'
    };
  }

  rfs.mkdir(node, folder);

  const startupFile = findStartupFile(
    node,
    folder,
    server.language
  );

  if (!startupFile) {
    return {
      ok: false,
      error: 'File di avvio non trovato. Usa main.py, bot.py, index.js o server.js'
    };
  }

  if (startupFile.endsWith('.js')) {
    
    
    
    let hasNodeModules = false;
    try {
      hasNodeModules = rfs.isDirectory(node, `${folder}/node_modules`);
    } catch (_) {}

    if (!hasNodeModules) {
      const deps = installNodeDependencies(node, folder);
      if (!deps.ok) return deps;
    }
  }

  let fileEnvContent = '';

  try {
    fileEnvContent = rfs.readFile(
      node,
      `${folder}/.env`
    );
  } catch (_) {}

  const fileEnv = parseEnvContent(fileEnvContent);

  const detectedToken = readAnyToken(
    fileEnv,
    server.botToken || ''
  );

  if (!detectedToken) {
    return {
      ok: false,
      error: 'Nessun token trovato nel file .env'
    };
  }

  const rp = runtimePaths(folder);

  rfs.mkdir(node, rp.base);

  const envExports = Object.entries(fileEnv)
    .map(([k, v]) => `export ${k}=${q(v)}`)
    .join('\n');

  const tokenKeys = [
    'TOKEN',
    'BOT_TOKEN',
    'DISCORD_TOKEN',
    'DISCORD_BOT_TOKEN'
  ];

  const tokenExports = tokenKeys
    .filter(k => !fileEnv[k])
    .map(k => `export ${k}=${q(detectedToken)}`)
    .join('\n');

  const runCmd = startupFile.endsWith('.js')
    ? `exec node --max-old-space-size=${Number(server.ramMB) || 256} ${q(startupFile)}`
    : `exec python3 ${q(startupFile)}`;

  const script = [
    '#!/bin/sh',
    `cd ${q(folder)} || exit 1`,
    
    
    `exec >> ${q(rp.logFile)} 2>&1`,
    `rm -f ${q(rp.inputFile)}`,
    `mkfifo ${q(rp.inputFile)} || exit 1`,
    `exec 3<> ${q(rp.inputFile)}`,
    `exec 0<&3`,
    envExports,
    tokenExports,
    startupFile.endsWith('.py') ? 'export PYTHONUNBUFFERED=1' : '',
    runCmd,
    ''
  ].join('\n');

  try {
    rfs.writeFile(
      node,
      rp.scriptFile,
      script
    );

    const launchOutput = rfs.sshRun(
      node,
      `chmod +x ${q(rp.scriptFile)} && ` +
      `mkdir -p ${q(rp.base)} && ` +
      `rm -f ${q(rp.logFile)} && : > ${q(rp.logFile)} && ` +
      `if P0=$(cat ${q(rp.pidFile)} 2>/dev/null) && [ -n "$P0" ] && kill -0 "$P0" 2>/dev/null; then ` +
      `echo "$P0"; exit 0; fi; ` +
      `rm -f ${q(rp.pidFile)} ${q(rp.startFile)} ${q(rp.inputFile)} && ` +
      `cd ${q(folder)} && ` +
      `if P0=$(cat ${q(rp.pidFile)} 2>/dev/null) && [ -n "$P0" ] && kill -0 "$P0" 2>/dev/null; then ` +
      `echo "$P0"; exit 0; fi; ` +
      `nohup setsid ${q(rp.scriptFile)} < /dev/null >/dev/null 2>&1 & ` +
      `P=$!; i=0; while [ $i -lt 20 ] && ! kill -0 "$P" 2>/dev/null; do i=$((i+1)); sleep 0.05; done; ` +
      `G=$(ps -o pgid= -p "$P" 2>/dev/null | tr -d ' '); ` +
      `echo "$P" > ${q(rp.pidFile)}; ` +
      `echo "$G" > ${q(rp.pgidFile)}; ` +
      `date +%s > ${q(rp.startFile)}; ` +
      `echo "$P"; exit 0`,
      { timeout: 5000 }
    );

    const launchMatch = String(launchOutput || '').match(/(\d+)\s*$/);
    const launchPid = launchMatch ? Number(launchMatch[1]) : null;
    const confirmedPid = findRunningPid(server, node, true);
    if (!confirmedPid) {
      stateCache.delete(server.id);
      return { ok: false, error: 'Il processo non risulta realmente attivo sul nodo remoto dopo l avvio' };
    }
    stateCache.set(server.id, { ts: Date.now(), running: true, pid: confirmedPid || launchPid });
    logCache.delete(String(server.id || server.folder));
    return { ok: true, pid: confirmedPid || launchPid };
  } catch (e) {
    stateCache.delete(server.id);

    const recoveredPid = findRunningPid(
      server,
      node,
      true
    );

    if (recoveredPid) {
      stateCache.set(server.id, {
        ts: Date.now(),
        running: true,
        pid: recoveredPid
      });

      return { ok: true };
    }

    return {
      ok: false,
      error: 'Impossibile avviare il processo sul nodo remoto: ' +
        String(e.stderr || e.message || e).slice(0, 500)
    };
  }

  return { ok: false, error: 'Avvio non riuscito sul nodo remoto' };
}

function stop(server, node) {
  if (!node || !server || !server.folder) {
    return { ok: false, error: 'Nodo non disponibile' };
  }

  const rp = runtimePaths(server.folder);

  try {
    let startupFile = null;
    try {
      startupFile = findStartupFile(
        node,
        server.folder,
        server.language
      );
    } catch (_) {}

    if (!startupFile) {
      return {
        ok: false,
        error: 'File di avvio non trovato'
      };
    }

    const base = String(startupFile).split('/').pop();

    const command =
      `F=${q(server.folder)}; B=${q(base)}; ` +
      `PF=${q(rp.pidFile)}; GF=${q(rp.pgidFile)}; ` +

      `P=$(cat "$PF" 2>/dev/null || true); ` +
      `G=$(cat "$GF" 2>/dev/null || true); ` +

      `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then ` +
      `kill -TERM "$P" 2>/dev/null || true; ` +
      `fi; ` +

      `if [ -n "$G" ] && [ "$G" != "0" ] && [ "$G" != "$$" ]; then ` +
      `kill -TERM -- -"$G" 2>/dev/null || true; ` +
      `fi; ` +

      `i=0; ` +
      `while [ "$i" -lt 20 ]; do ` +
      `alive=0; ` +
      `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then alive=1; fi; ` +
      `if [ "$alive" -eq 0 ] && [ -n "$G" ] && [ "$G" != "0" ]; then ` +
      `if kill -0 -- -"$G" 2>/dev/null; then alive=1; fi; ` +
      `fi; ` +
      `[ "$alive" -eq 0 ] && break; ` +
      `i=$((i+1)); sleep 0.25; ` +
      `done; ` +

      `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then ` +
      `kill -KILL "$P" 2>/dev/null || true; ` +
      `fi; ` +

      `if [ -n "$G" ] && [ "$G" != "0" ] && [ "$G" != "$$" ]; then ` +
      `kill -KILL -- -"$G" 2>/dev/null || true; ` +
      `fi; ` +

      `for P2 in $(ps -eo pid= 2>/dev/null); do ` +
      `[ "$P2" = "$$" ] && continue; ` +
      `C=$(readlink -f "/proc/$P2/cwd" 2>/dev/null) || continue; ` +
      `[ "$C" = "$F" ] || continue; ` +
      `A=$(tr '\\0' ' ' < "/proc/$P2/cmdline" 2>/dev/null) || continue; ` +
      `case "$A" in *"/$B"*|*" $B"*|*"node $B"*|*"python $B"*|*"python3 $B"*) ` +
      `kill -KILL "$P2" 2>/dev/null || true;; esac; ` +
      `done; ` +

      `remaining=0; ` +
      `for P3 in $(ps -eo pid= 2>/dev/null); do ` +
      `[ "$P3" = "$$" ] && continue; ` +
      `C=$(readlink -f "/proc/$P3/cwd" 2>/dev/null) || continue; ` +
      `[ "$C" = "$F" ] || continue; ` +
      `A=$(tr '\\0' ' ' < "/proc/$P3/cmdline" 2>/dev/null) || continue; ` +
      `case "$A" in *"/$B"*|*" $B"*|*"node $B"*|*"python $B"*|*"python3 $B"*) remaining=1;; esac; ` +
      `done; ` +

      `rm -f ${q(rp.pidFile)} ${q(rp.pgidFile)} ${q(rp.startFile)} ${q(rp.inputFile)} ${q(rp.logFile)}; ` +
      `echo "$remaining"`;

    const verify = rfs.sshRun(
      node,
      command,
      {
        timeout: 20000,
        maxBuffer: 128 * 1024
      }
    );

    const stillRunning =
      String(verify).trim().split(/\s+/).pop() === '1';

    logCache.delete(String(server.id || server.folder));

    stateCache.set(server.id, {
      ts: Date.now(),
      running: stillRunning,
      pid: null
    });

    if (stillRunning) {
      return {
        ok: false,
        error: 'Il processo del server risulta ancora attivo sul nodo remoto'
      };
    }

    return { ok: true };

  } catch (e) {
    logCache.delete(String(server.id || server.folder));

    try {
      stateCache.delete(server.id);
    } catch (_) {}

    return {
      ok: false,
      error: String(e.message || e).slice(0, 300)
    };
  }
}
function restart(server, node) {
  const stopped = stop(server, node);
  if (!stopped.ok) return stopped;
  return start(server, node);
}

function getLogs(server, node) {
  if (!node || !server || !server.folder) return [];
  const key = String(server.id || server.folder);
  const cached = logCache.get(key);
  if (cached && Date.now() - cached.ts < LOG_TTL_MS) return cached.logs;

  const rp = runtimePaths(server.folder);
  try {
    
    
    
    const command =
      `if [ -s ${q(rp.logFile)} ]; then ` +
      `tail -n ${MAX_LOG_LINES} ${q(rp.logFile)}; ` +
      `else ` +
      `P=$(cat ${q(rp.pidFile)} 2>/dev/null); ` +
      `T=$(readlink -f /proc/$P/fd/1 2>/dev/null); ` +
      `case "$T" in /*) tail -n ${MAX_LOG_LINES} "$T" 2>/dev/null || true;; esac; ` +
      `fi`;
    const out = rfs.sshRun(node, command, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const logs = String(out || '').split(/\r?\n/).filter(Boolean);
    logCache.set(key, { ts: Date.now(), logs });
    return logs;
  } catch (_) {
    return cached?.logs || [];
  }
}

function getRuntime(server, node) {
  const running = isRunning(server, node);

  return {
    running,
    logs: getLogs(server, node)
  };
}

function getStats(server, node) {
  const notRunning = {
    running: false,
    startedAt: null,
    uptimeSeconds: 0,
    cpuPercent: 0,
    ramMB: 0
  };

  if (!node || !server || !server.folder) {
    return notRunning;
  }

  const pid = getRunningPid(
    server,
    node,
    true
  );

  if (!pid) {
    return notRunning;
  }

  const rp = runtimePaths(server.folder);

  try {
    const out = rfs.sshRun(
      node,
      `P=${q(String(pid))}; ` +
      `ps -p "$P" -o %cpu=,rss= 2>/dev/null; ` +
      `echo '---'; ` +
      `cat ${q(rp.startFile)} 2>/dev/null`,
      { timeout: 8000 }
    );

    const [statLine, , startedLine] =
      out.split(/\r?\n/);

    const parts =
      String(statLine || '')
        .trim()
        .split(/\s+/);

    const cpuPercent =
      Math.max(
        0,
        Number.parseFloat(parts[0]) || 0
      );

    const ramMB =
      Math.max(
        0,
        (Number.parseFloat(parts[1]) || 0) / 1024
      );

    const startedAtSec =
      Number(startedLine || 0);

    const startedAt =
      startedAtSec
        ? startedAtSec * 1000
        : null;

    const uptimeSeconds =
      startedAt
        ? Math.max(
            0,
            Math.floor(
              (Date.now() - startedAt) / 1000
            )
          )
        : 0;

    stateCache.set(server.id, {
      ts: Date.now(),
      running: true,
      pid
    });

    return {
      running: true,
      startedAt,
      uptimeSeconds,
      cpuPercent: Number(cpuPercent.toFixed(1)),
      ramMB: Number(ramMB.toFixed(1))
    };
  } catch (_) {
    return {
      running: true,
      startedAt: null,
      uptimeSeconds: 0,
      cpuPercent: 0,
      ramMB: 0
    };
  }
}

function refreshDiskUsageIfStale(
  server,
  node,
  staleMs = 5000
) {
  const now = Date.now();
  const cached = diskCache.get(server.id);

  if (
    cached &&
    now - cached.updatedAt < staleMs
  ) {
    return cached.diskMB;
  }

  const diskMB =
    (node && server.folder)
      ? rfs.diskUsageMB(
          node,
          server.folder
        )
      : 0;

  diskCache.set(server.id, {
    diskMB,
    updatedAt: now
  });

  return diskMB;
}

function sendCommand(server, node, command) {
  if (!node || !server || !server.folder) {
    return {
      ok: false,
      error: 'Nodo non disponibile'
    };
  }

  const pid = getRunningPid(
    server,
    node,
    true
  );

  if (!pid) {
    return {
      ok: false,
      error: 'Il server non è in esecuzione'
    };
  }

  try {
    const rp = runtimePaths(server.folder);
    rfs.sshRun(
      node,
      `P=${q(String(pid))}; F=${q(rp.inputFile)}; ` +
      `[ -p "$F" ] && kill -0 "$P" 2>/dev/null && ` +
      `printf '%s\n' ${q(String(command || ''))} > "$F"`,
      { timeout: 6000 }
    );

    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error:
        'Invio comando non riuscito ' +
        '(il processo potrebbe non leggere da stdin): ' +
        String(e.message || e).slice(0, 300)
    };
  }
}

module.exports = {
  start,
  stop,
  restart,
  isRunning,
  getLogs,
  getRuntime,
  getStats,
  refreshDiskUsageIfStale,
  sendCommand
};