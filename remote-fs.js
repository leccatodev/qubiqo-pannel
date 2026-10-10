










const { execFileSync, spawnSync, spawn, execFile } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SSH_CONNECT_TIMEOUT = Number(process.env.QH_SSH_CONNECT_TIMEOUT || 10);
const SSH_CONTROL_DIR = path.join(os.tmpdir(), 'qbq-ssh-ctrl');
try { require('fs').mkdirSync(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}

function controlPathFor(node) {
  const key = `${node.username}@${node.host}:${node.port || 22}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
  return path.join(SSH_CONTROL_DIR, `${hash}.sock`);
}

function sshBaseArgs(node, fresh = false) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=4',
    '-o', 'ServerAliveCountMax=2',
  ];
  if (!fresh) {
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=120',
      '-o', `ControlPath=${controlPathFor(node)}`,
    );
  } else {
    
    
    
    args.push('-o', 'ControlMaster=no');
  }
  args.push('-p', String(node.port || 22));
  if (node.keyPath) args.push('-i', node.keyPath);
  args.push(`${node.username}@${node.host}`);
  return args;
}


function q(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function isRetryableSshError(error) {
  if (error?.killed || error?.signal) return false;
  const code = String(error?.code || '').toUpperCase();
  const msg = String(error?.message || error || '').toUpperCase();
  return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' ||
    msg.includes('CONTROL SOCKET CONNECT') || msg.includes('CONNECTION CLOSED');
}

function sshErrorWithContext(error, node) {
  const code = String(error?.code || '').trim();
  const detail = String(error?.stderr || error?.message || error || '').trim();
  const host = `${node?.username || 'utente'}@${node?.host || 'nodo'}:${node?.port || 22}`;
  if (code === 'ETIMEDOUT' || /timed out/i.test(detail)) {
    const err = new Error(`Connessione SSH al nodo remoto ${host} scaduta. Verifica che la VPS sia online, che la porta SSH sia raggiungibile e che la chiave configurata sia corretta.`);
    err.code = 'ETIMEDOUT';
    err.stderr = detail;
    return err;
  }
  return error;
}

function runSshProcess(node, remoteCommand, input, opts, withInput) {
  const timeout = opts.timeout || (withInput ? 30000 : 15000);
  const maxBuffer = opts.maxBuffer || (withInput ? 20 * 1024 * 1024 : 8 * 1024 * 1024);
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = attempt === 1;
    try {
      if (withInput) {
        const result = spawnSync('ssh', [...sshBaseArgs(node, fresh), remoteCommand], {
          input, timeout, maxBuffer, encoding: opts.encoding,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
          const err = new Error(`comando remoto fallito (${result.status}): ${String(result.stderr || '').slice(0, 500)}`);
          err.stderr = result.stderr; err.status = result.status;
          throw err;
        }
        return result.stdout;
      }

      return execFileSync('ssh', [...sshBaseArgs(node, fresh), remoteCommand], {
        encoding: 'utf8', timeout, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isRetryableSshError(error)) continue;
      throw sshErrorWithContext(error, node);
    }
  }

  throw sshErrorWithContext(lastError, node);
}

function sshRun(node, remoteCommand, opts = {}) {
  return runSshProcess(node, remoteCommand, undefined, opts, false);
}
function sshRunAsync(node, remoteCommand, opts = {}) {
  const timeout = opts.timeout || 15000;
  const maxBuffer = opts.maxBuffer || 8 * 1024 * 1024;
  const run = fresh => new Promise((resolve, reject) => {
    execFile('ssh', [...sshBaseArgs(node, fresh), remoteCommand], { encoding: 'utf8', timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; return reject(error); }
      resolve(stdout || '');
    });
  });
  return run(false).catch(error => {
    if (!isRetryableSshError(error)) throw sshErrorWithContext(error, node);
    return run(true).catch(error2 => { throw sshErrorWithContext(error2, node); });
  });
}


function sshRunWithInput(node, remoteCommand, input, opts = {}) {
  return runSshProcess(node, remoteCommand, input, opts, true);
}

function exists(node, remotePath) {
  try { sshRun(node, `test -e ${q(remotePath)}`, { timeout: 8000 }); return true; }
  catch (_) { return false; }
}

function isDirectory(node, remotePath) {
  try { sshRun(node, `test -d ${q(remotePath)}`, { timeout: 8000 }); return true; }
  catch (_) { return false; }
}

function mkdir(node, remotePath) {
  sshRun(node, `mkdir -p ${q(remotePath)} && chmod 755 ${q(remotePath)}`, { timeout: 15000 });
}

function remove(node, remotePath) {
  sshRun(node, `rm -rf ${q(remotePath)}`, { timeout: 30000 });
}

function rename(node, sourcePath, targetPath) {
  sshRun(node, `mv -T ${q(sourcePath)} ${q(targetPath)}`, { timeout: 15000 });
}

function list(node, remotePath) {
  const out = sshRun(
    node,
    `find ${q(remotePath)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\n'`,
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
  );
  return out.split(/\r?\n/).filter(Boolean).map(line => {
    const [type, size, ...nameParts] = line.split('\t');
    const name = nameParts.join('\t');
    return { name, isDir: type === 'd', size: type === 'd' ? 0 : (Number(size) || 0) };
  });
}

function readFile(node, remotePath) {
  return sshRun(node, `cat ${q(remotePath)}`, { timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
}

function readFileBuffer(node, remotePath, opts = {}) {
  return sshRunWithInput(node, `cat ${q(remotePath)}`, undefined, {
    timeout: opts.timeout || 30000,
    maxBuffer: opts.maxBuffer || 60 * 1024 * 1024,
  });
}

function writeFile(node, remotePath, content) {
  const dir = remotePath.slice(0, remotePath.lastIndexOf('/')) || '/';
  sshRun(node, `mkdir -p ${q(dir)}`, { timeout: 15000 });
  sshRunWithInput(node, `cat > ${q(remotePath)}`, content, { timeout: 30000, maxBuffer: 60 * 1024 * 1024 });
}

function unzipRemote(node, zipPath, destFolder) {
  sshRun(node, `cd ${q(destFolder)} && unzip -o ${q(zipPath)} -d ${q(destFolder)} >/dev/null 2>&1 && rm -f ${q(zipPath)}`, { timeout: 60000 });
}

function diskUsageMB(node, remotePath) {
  try {
    const out = sshRun(node, `du -sm --exclude=node_modules ${q(remotePath)} 2>/dev/null | awk '{print $1}'`, { timeout: 15000 });
    return Number.parseFloat(out.trim()) || 0;
  } catch (_) {
    return 0;
  }
}


function remoteFileSize(node, remotePath) {
  const out = sshRun(node, `stat -c %s ${q(remotePath)}`, { timeout: 10000, maxBuffer: 64 * 1024 });
  const size = Number(out.trim());
  if (!Number.isFinite(size) || size < 0) throw new Error('Dimensione file remota non valida');
  return size;
}

function createRemoteTar(node, sourceFolder, remoteTarPath, opts = {}) {
  const parent = remoteTarPath.slice(0, remoteTarPath.lastIndexOf('/')) || '/';
  sshRun(node, `mkdir -p ${q(parent)} && tar --exclude=./.qbq-runtime -czf ${q(remoteTarPath)} -C ${q(sourceFolder)} . && chmod 600 ${q(remoteTarPath)}`, { timeout: opts.timeout || 300000, maxBuffer: opts.maxBuffer || 2 * 1024 * 1024 });
  return remoteFileSize(node, remoteTarPath);
}

function extractRemoteTar(node, remoteTarPath, destinationFolder, opts = {}) {
  sshRun(node, `mkdir -p ${q(destinationFolder)} && tar -xzf ${q(remoteTarPath)} -C ${q(destinationFolder)}`, { timeout: opts.timeout || 300000, maxBuffer: opts.maxBuffer || 2 * 1024 * 1024 });
}

function scpBaseArgs(node) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=4',
    '-o', 'ServerAliveCountMax=2',
    '-P', String(node.port || 22),
  ];
  if (node.keyPath) args.push('-i', node.keyPath);
  return args;
}

function runScp(node, source, destination, opts = {}) {
  const timeout = opts.timeout || 180000;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const args = [...scpBaseArgs(node), source, destination];
      return execFileSync('scp', args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isRetryableSshError(error)) continue;
      throw sshErrorWithContext(error, node);
    }
  }
  throw sshErrorWithContext(lastError, node);
}

function copyLocalFileToRemote(node, localFile, remoteFile, opts = {}) {
  const source = path.resolve(localFile);
  const parent = remoteFile.slice(0, remoteFile.lastIndexOf('/')) || '/';
  sshRun(node, `mkdir -p ${q(parent)}`, { timeout: 15000 });
  runScp(node, source, `${node.username}@${node.host}:${remoteFile}`, opts);
}

function copyLocalToRemote(node, localSource, remoteDestination, opts = {}) {
  const source = path.resolve(localSource);
  const remoteSpec = `${node.username}@${node.host}:${remoteDestination}/`;
  const timeout = opts.timeout || 180000;
  try {
    const sshArgs = scpBaseArgs(node).map(v => q(v)).join(' ');
    execFileSync('rsync', ['-az', '-e', `ssh ${sshArgs}`, `${source}/`, remoteSpec], {
      encoding: 'utf8',
      timeout,
      maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  } catch (error) {
    if (!isRetryableSshError(error)) {
      try {
        runScp(node, `${source}/.`, remoteSpec, opts);
        return;
      } catch (fallbackError) {
        throw sshErrorWithContext(fallbackError, node);
      }
    }
  }
  runScp(node, `${source}/.`, remoteSpec, opts);
}


function copyRemoteDirectoryToRemote(sourceNode, sourcePath, targetNode, targetPath, opts = {}) {
  const src = spawn('ssh', [...sshBaseArgs(sourceNode, true), `tar -C ${q(sourcePath)} -cf - .`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const dst = spawn('ssh', [...sshBaseArgs(targetNode, true), `mkdir -p ${q(targetPath)} && tar -C ${q(targetPath)} -xpf -`], { stdio: ['pipe', 'ignore', 'pipe'] });
  let srcErr = '';
  let dstErr = '';
  let settled = false;
  src.stderr.setEncoding('utf8');
  dst.stderr.setEncoding('utf8');
  src.stderr.on('data', d => { srcErr += d; if (srcErr.length > 8000) srcErr = srcErr.slice(-8000); });
  dst.stderr.on('data', d => { dstErr += d; if (dstErr.length > 8000) dstErr = dstErr.slice(-8000); });
  src.stdout.pipe(dst.stdin);
  return new Promise((resolve, reject) => {
    let sc = null;
    let dc = null;
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 20 * 60 * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { src.kill('SIGKILL'); } catch (_) {}
      try { dst.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Trasferimento directory remoto scaduto'));
    }, timeout);
    const done = () => {
      if (settled || sc === null || dc === null) return;
      settled = true;
      clearTimeout(timer);
      if (sc !== 0 || dc !== 0) {
        reject(new Error((srcErr || dstErr || `Trasferimento directory SSH fallito: ${sc}/${dc}`).trim().slice(0, 1200)));
        return;
      }
      resolve(true);
    };
    src.on('close', code => { sc = code; done(); });
    dst.on('close', code => { dc = code; done(); });
    src.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { dst.kill('SIGKILL'); } catch (_) {}
      reject(sshErrorWithContext(error, sourceNode));
    });
    dst.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { src.kill('SIGKILL'); } catch (_) {}
      reject(sshErrorWithContext(error, targetNode));
    });
  });
}

function copyRemoteFileToRemote(sourceNode, sourcePath, targetNode, targetPath, opts = {}) {
  const src = spawn('ssh', [...sshBaseArgs(sourceNode, true), `cat ${q(sourcePath)}`], { stdio:['ignore','pipe','pipe'] });
  const dstParent = targetPath.slice(0, targetPath.lastIndexOf('/')) || '/';
  const dst = spawn('ssh', [...sshBaseArgs(targetNode, true), `mkdir -p ${q(dstParent)} && cat > ${q(targetPath)} && chmod 600 ${q(targetPath)}`], { stdio:['pipe','ignore','pipe'] });
  let srcErr=''; let dstErr=''; let settled=false;
  src.stderr.setEncoding('utf8'); dst.stderr.setEncoding('utf8');
  src.stderr.on('data',d=>{srcErr+=d;if(srcErr.length>4000)srcErr=srcErr.slice(-4000)});
  dst.stderr.on('data',d=>{dstErr+=d;if(dstErr.length>4000)dstErr=dstErr.slice(-4000)});
  src.stdout.pipe(dst.stdin);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(settled)return;settled=true;src.kill('SIGKILL');dst.kill('SIGKILL');reject(new Error('Trasferimento backup remoto scaduto'));},opts.timeout||300000);
    let sc=null,dc=null;
    const done=()=>{
      if(settled||sc===null||dc===null)return;
      settled=true;clearTimeout(timer);
      if(sc!==0||dc!==0)return reject(new Error((srcErr||dstErr||`Trasferimento SSH fallito: ${sc}/${dc}`).slice(0,1000)));
      resolve(true);
    };
    src.on('close',c=>{sc=c;done()}); dst.on('close',c=>{dc=c;done()});
    src.on('error',e=>{if(!settled){settled=true;clearTimeout(timer);dst.kill('SIGKILL');reject(e)}});
    dst.on('error',e=>{if(!settled){settled=true;clearTimeout(timer);src.kill('SIGKILL');reject(e)}});
  });
}

function streamRemoteFile(node, remotePath, res, headers = {}) {
  const child = spawn('ssh', [...sshBaseArgs(node, true), `cat ${q(remotePath)}`], { stdio:['ignore','pipe','pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
  child.on('error', error => {
    if (!res.headersSent) res.writeHead(502, {'Content-Type':'application/json; charset=utf-8'});
    if (!res.writableEnded) res.end(JSON.stringify({ error: sshErrorWithContext(error, node).message }));
  });
  const transferTimeout = setTimeout(() => {
    if (res.writableEnded) return;
    try { child.kill('SIGKILL'); } catch (_) {}
    if (!res.headersSent) res.writeHead(504, {'Content-Type':'application/json; charset=utf-8'});
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'Download remoto scaduto' }));
  }, 10 * 60 * 1000);
  child.on('close', code => {
    clearTimeout(transferTimeout);
    if (code !== 0 && !res.writableEnded) {
      if (!res.headersSent) res.writeHead(502, {'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({ error: `Download remoto fallito: ${stderr.trim() || `ssh exit ${code}`}` }));
    } else if (!res.writableEnded) res.end();
  });
  res.writeHead(200, headers);
  res.on('close', () => { if (!child.killed) child.kill('SIGTERM'); });
  child.stdout.pipe(res);
  return child;
}

module.exports = {
  q,
  controlPathFor,
  sshRun,
  sshRunAsync,
  sshRunWithInput,
  exists,
  isDirectory,
  mkdir,
  remove,
  rename,
  list,
  readFile,
  readFileBuffer,
  writeFile,
  unzipRemote,
  diskUsageMB,
  remoteFileSize,
  createRemoteTar,
  extractRemoteTar,
  copyLocalToRemote,
  copyLocalFileToRemote,
  streamRemoteFile,
  copyRemoteFileToRemote,
  copyRemoteDirectoryToRemote,
};
