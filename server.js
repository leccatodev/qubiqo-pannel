const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, fork } = require('child_process');
const zlib = require('zlib');

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

const PANEL_MAINTENANCE = String(process.env.PANEL_MAINTENANCE || '').trim() === '1';

const { readDb, withDb } = require('./lib/store');
const auth = require('./lib/auth');
const pm = require('./lib/process-manager');
const templates = require('./lib/templates');
const rfs = require('./lib/remote-fs');
const storage = require('./lib/node-storage');
const nodeSelector = require('./lib/node-selector');
const net = require('net');
const tls = require('tls');

class SMTPConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.closed = false;
    this.onData = chunk => {
      this.buffer += chunk.toString('utf8');
      this.flush();
    };
    this.onError = err => this.fail(err);
    this.onClose = () => this.fail(new Error('Connessione SMTP chiusa'));
    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('close', this.onClose);
  }

  flush() {
    while (this.waiters.length) {
      const lines = this.buffer.split(/\r?\n/);
      let finalIndex = -1;
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) { finalIndex = i; break; }
      }
      if (finalIndex < 0) return;

      const responseLines = lines.slice(0, finalIndex + 1);
      this.buffer = lines.slice(finalIndex + 1).join('\r\n');
      const waiter = this.waiters.shift();
      waiter.resolve(responseLines.join('\r\n'));
    }
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  read(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex(w => w.resolve === wrappedResolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('Timeout risposta SMTP'));
      }, timeoutMs);
      const wrappedResolve = value => { clearTimeout(timer); resolve(value); };
      const wrappedReject = err => { clearTimeout(timer); reject(err); };
      this.waiters.push({ resolve: wrappedResolve, reject: wrappedReject });
      this.flush();
    });
  }

  write(line) {
    this.socket.write(String(line) + '\r\n');
  }

  async command(command, expected = null) {
    if (command !== null && command !== undefined) this.write(command);
    const response = await this.read();
    const code = Number(String(response).slice(0, 3));
    if (expected && !expected.includes(code)) throw new Error(`SMTP ${code || 'ERR'}: ${String(response).trim()}`);
    return { code, response };
  }

  destroy() {
    try { this.socket.destroy(); } catch (_) {}
  }
}

function smtpTlsUpgrade(connection, host) {
  return new Promise((resolve, reject) => {
    const old = connection.socket;
    old.removeListener('data', connection.onData);
    old.removeListener('error', connection.onError);
    old.removeListener('close', connection.onClose);
    const secureSocket = tls.connect({
      socket: old,
      host,
      servername: host,
      rejectUnauthorized: true,
    });
    secureSocket.setTimeout(15000);
    const cleanup = () => {
      secureSocket.removeListener('secureConnect', onSecure);
      secureSocket.removeListener('error', onError);
      secureSocket.removeListener('timeout', onTimeout);
    };
    const onSecure = () => { cleanup(); resolve(new SMTPConnection(secureSocket)); };
    const onError = e => { cleanup(); reject(e); };
    const onTimeout = () => { cleanup(); reject(new Error('Timeout TLS SMTP')); };
    secureSocket.once('secureConnect', onSecure);
    secureSocket.once('error', onError);
    secureSocket.once('timeout', onTimeout);
  });
}

async function smtpAuthenticate(connection, user, pass) {
  const ehlo = await connection.command('EHLO qubiqohost.it', [250]);
  const capabilities = String(ehlo.response).toUpperCase();
  if (capabilities.includes('AUTH PLAIN')) {
    const auth = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
    await connection.command(`AUTH PLAIN ${auth}`, [235]);
    return;
  }
  await connection.command('AUTH LOGIN', [334]);
  await connection.command(Buffer.from(user, 'utf8').toString('base64'), [334]);
  await connection.command(Buffer.from(pass, 'utf8').toString('base64'), [235]);
}

async function smtpSendOverConnection(connection, { user, pass, from, to, subject, text, html }) {
  await smtpAuthenticate(connection, user, pass);
  await connection.command(`MAIL FROM:<${from}>`, [250, 251]);
  await connection.command(`RCPT TO:<${to}>`, [250, 251]);
  await connection.command('DATA', [354]);

  const safeText = String(text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  const safeHtml = String(html || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  const safeSubject = String(subject || '').replace(/[\r\n]/g, ' ');
  const body = [
    `From: QubiqoHost <${from}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(safeSubject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="QUBIQOHOST_ALT"',
    '',
    '--QUBIQOHOST_ALT',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    safeText,
    '',
    '--QUBIQOHOST_ALT',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    safeHtml,
    '',
    '--QUBIQOHOST_ALT--',
    '',
    '.',
  ].join('\r\n');
  connection.write(body);
  await connection.command(null, [250]);
  await connection.command('QUIT', [221, 250]);
  connection.socket.end();
  return { simulated: false };
}

async function sendMail({ to, subject, text, html }) {
  const host = String(process.env.SMTP_HOST || 'authsmtp.securemail.pro').trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const user = String(process.env.SMTP_USER || 'info@qubiqohost.it').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const from = String(process.env.SMTP_FROM || user || 'info@qubiqohost.it').trim();

  if (!host || !user || !pass) throw new Error('Configurazione SMTP incompleta: servono SMTP_HOST, SMTP_USER e SMTP_PASS');
  if (![465, 587].includes(port)) throw new Error(`Porta SMTP non supportata: ${port}. Usa 465 o 587.`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Indirizzo destinatario non valido');

  let connection;
  try {
    if (port === 465) {
      const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
      socket.setTimeout(15000);
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.removeListener('secureConnect', onSecure);
          socket.removeListener('error', onError);
          socket.removeListener('timeout', onTimeout);
        };
        const onSecure = () => { cleanup(); resolve(); };
        const onError = e => { cleanup(); reject(e); };
        const onTimeout = () => { cleanup(); reject(new Error('Timeout connessione SMTP')); };
        socket.once('secureConnect', onSecure);
        socket.once('error', onError);
        socket.once('timeout', onTimeout);
      });
      connection = new SMTPConnection(socket);
      await connection.command(null, [220]);
    } else {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(15000);
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.removeListener('connect', onConnect);
          socket.removeListener('error', onError);
          socket.removeListener('timeout', onTimeout);
        };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = e => { cleanup(); reject(e); };
        const onTimeout = () => { cleanup(); reject(new Error('Timeout connessione SMTP')); };
        socket.once('connect', onConnect);
        socket.once('error', onError);
        socket.once('timeout', onTimeout);
      });
      connection = new SMTPConnection(socket);
      await connection.command(null, [220]);
      await connection.command('EHLO qubiqohost.it', [250]);
      await connection.command('STARTTLS', [220]);
      connection = await smtpTlsUpgrade(connection, host);
    }

    return await smtpSendOverConnection(connection, { user, pass, from, to, subject, text, html });
  } catch (error) {
    try { connection?.destroy(); } catch (_) {}
    const code = error?.code ? ` [${error.code}]` : '';
    throw new Error(`Invio email SMTP fallito${code}: ${error?.message || error}`);
  }
}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const RAM_PRESET_MB = 256;
const CPU_PRESET_CORES = 0.5;
const DEFAULT_SLOTS = 1;
const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 30;

const IP_HASH_SECRET = process.env.IP_HASH_SECRET || process.env.SESSION_SECRET || 'qubiqohost-ip-hash-change-me';
const DEVICE_HASH_SECRET = process.env.DEVICE_HASH_SECRET || IP_HASH_SECRET;
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const MAX_TRACKED_IPS = 10000;
const MAX_TRACKED_DEVICE_HASHES = 10000;
const MAX_ACCOUNTS_PER_IP_RISK = 2;

function normalizeIp(ip) {
  ip = String(ip || '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isTrustedProxyAddress(ip) {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return /^(fc|fd)[0-9a-f]{2}:/i.test(ip);
}

function getClientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  const cloudflareIp = normalizeIp(String(req.headers['cf-connecting-ip'] || '').trim());
  const forwarded = normalizeIp(String(req.headers['x-forwarded-for'] || '').split(',')[0].trim());
  const realIp = normalizeIp(String(req.headers['x-real-ip'] || '').trim());
  if (cloudflareIp && socketIp) return cloudflareIp;
  if (TRUST_PROXY || isTrustedProxyAddress(socketIp)) return forwarded || realIp || socketIp;
  return socketIp;
}

function hashClientIp(ip) {
  if (!ip) return '';
  return crypto.createHmac('sha256', IP_HASH_SECRET).update(ip).digest('hex');
}

function authProvider(user) {
  if (user?.discordId) return 'discord';
  if (user?.googleId) return 'google';
  return 'manual';
}

const IP_INTEL_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const ipIntelCache = new Map();
const IP_INTEL_PROVIDER_URL = process.env.IP_INTEL_URL || '';

function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  return ip === '127.0.0.1' || ip === '::1' || isTrustedProxyAddress(ip);
}

function fetchIpIntel(ip) {
  return new Promise((resolve) => {
    if (!IP_INTEL_PROVIDER_URL || isPrivateOrLocalIp(ip)) return resolve(null);
    const url = IP_INTEL_PROVIDER_URL.replace('{ip}', encodeURIComponent(ip));
    let client;
    try { client = new URL(url).protocol === 'https:' ? require('https') : http; } catch { return resolve(null); }
    const reqIntel = client.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({
            isVpnOrProxy: Boolean(json.proxy || json.hosting),
            isp: json.isp || json.org || '',
            country: json.countryCode || json.country || '',
          });
        } catch { resolve(null); }
      });
    });
    reqIntel.on('timeout', () => { reqIntel.destroy(); resolve(null); });
    reqIntel.on('error', () => resolve(null));
  });
}

async function getIpIntel(ip) {
  if (!ip) return null;
  const cached = ipIntelCache.get(ip);
  if (cached && Date.now() - cached.at < IP_INTEL_CACHE_TTL_MS) return cached.data;
  const data = await fetchIpIntel(ip);
  ipIntelCache.set(ip, { data, at: Date.now() });
  return data;
}

function scheduleIpIntelLookup(userId, ip) {
  if (!IP_INTEL_PROVIDER_URL || isPrivateOrLocalIp(ip)) return;
  const cached = ipIntelCache.get(ip);
  if (cached && Date.now() - cached.at < IP_INTEL_CACHE_TTL_MS) return;
  getIpIntel(ip).then((intel) => {
    if (!intel) return;
    withDb((db) => {
      const u = db.users.find((x) => x.id === userId);
      if (!u) return;
      u.ipIntel = Object.assign({}, u.ipIntel, { [ip]: intel });
    });
  }).catch(() => {});
}

const MAX_TRACKED_RAW_IPS = 30;

function recordUserIp(user, req) {
  const ip = getClientIp(req);
  if (!ip) return;
  const hash = hashClientIp(ip);

  user.ipHashes = Array.isArray(user.ipHashes) ? user.ipHashes.filter(Boolean) : [];
  if (!user.firstIpHash) user.firstIpHash = hash;
  if (!user.ipHashes.includes(hash)) user.ipHashes.push(hash);
  if (user.ipHashes.length > MAX_TRACKED_IPS) user.ipHashes = user.ipHashes.slice(-MAX_TRACKED_IPS);
  user.lastIpHash = hash;
  user.lastIpAt = Date.now();

  user.ipAddresses = Array.isArray(user.ipAddresses) ? user.ipAddresses.filter(Boolean) : [];
  if (!user.ipAddresses.includes(ip)) user.ipAddresses.push(ip);
  if (user.ipAddresses.length > MAX_TRACKED_RAW_IPS) user.ipAddresses = user.ipAddresses.slice(-MAX_TRACKED_RAW_IPS);
  if (!user.firstIp) user.firstIp = ip;
  user.lastIp = ip;

  scheduleIpIntelLookup(user.id, ip);
}

function hashDeviceId(deviceId) {
  if (!deviceId) return '';
  return crypto.createHmac('sha256', DEVICE_HASH_SECRET).update(deviceId).digest('hex');
}

function recordUserDevice(user, req) {
  const deviceId = String(auth.parseCookies(req).qh_device || '').trim();
  if (!/^[a-f0-9-]{24,80}$/i.test(deviceId)) return;
  const hash = hashDeviceId(deviceId);
  user.deviceHashes = Array.isArray(user.deviceHashes) ? user.deviceHashes.filter(Boolean) : [];
  if (!user.deviceHashes.includes(hash)) user.deviceHashes.push(hash);
  if (user.deviceHashes.length > MAX_TRACKED_DEVICE_HASHES) user.deviceHashes = user.deviceHashes.slice(-MAX_TRACKED_DEVICE_HASHES);
  user.lastDeviceAt = Date.now();
}

function normalizedEmail(user) {
  return String(user?.email || '').trim().toLowerCase();
}

function hasSameAccountIdentity(first, second) {
  const firstEmail = normalizedEmail(first);
  const secondEmail = normalizedEmail(second);
  return Boolean(
    (firstEmail && firstEmail === secondEmail) ||
    (first?.discordId && first.discordId === second?.discordId) ||
    (first?.googleId && first.googleId === second?.googleId)
  );
}

function getUserIpRisk(user, users) {
  if (user?.role === 'admin') {
    return { linkedAccounts: [], linkedEmails: [], matchCount: 0, ipMatchCount: 0, weakLinkCount: 0 };
  }

  const nonAdminUsers = Array.isArray(users) ? users.filter(account => account?.role !== 'admin') : [];
  const userIpHashes = new Set([
    ...(Array.isArray(user.ipHashes) ? user.ipHashes.filter(Boolean) : []),
    ...(user.firstIpHash ? [user.firstIpHash] : []),
    ...(user.lastIpHash ? [user.lastIpHash] : []),
  ]);
  const userDeviceHashes = new Set(Array.isArray(user.deviceHashes) ? user.deviceHashes.filter(Boolean) : []);

  if (!userIpHashes.size && !userDeviceHashes.size) {
    return { linkedAccounts: [], linkedEmails: [], matchCount: 0, ipMatchCount: 0, weakLinkCount: 0 };
  }

  const ipAccountCounts = new Map();
  for (const account of nonAdminUsers) {
    const hashes = new Set([
      ...(Array.isArray(account.ipHashes) ? account.ipHashes.filter(Boolean) : []),
      ...(account.firstIpHash ? [account.firstIpHash] : []),
      ...(account.lastIpHash ? [account.lastIpHash] : []),
    ]);
    for (const hash of hashes) ipAccountCounts.set(hash, (ipAccountCounts.get(hash) || 0) + 1);
  }

  const candidates = nonAdminUsers
    .filter(other => other.id !== user.id && !hasSameAccountIdentity(user, other))
    .map(other => {
      const otherIpHashes = new Set([
        ...(Array.isArray(other.ipHashes) ? other.ipHashes.filter(Boolean) : []),
        ...(other.firstIpHash ? [other.firstIpHash] : []),
        ...(other.lastIpHash ? [other.lastIpHash] : []),
      ]);
      const otherDeviceHashes = new Set(Array.isArray(other.deviceHashes) ? other.deviceHashes.filter(Boolean) : []);
      const sharedDeviceCount = [...userDeviceHashes].filter(hash => otherDeviceHashes.has(hash)).length;
      const sharedIpHashes = [...userIpHashes].filter(hash => otherIpHashes.has(hash));
      const usefulSharedIpCount = sharedIpHashes.filter(
        hash => (ipAccountCounts.get(hash) || 0) <= MAX_ACCOUNTS_PER_IP_RISK
      ).length;
      const sharedIpCount = usefulSharedIpCount;
      return { other, sharedIpCount, usefulSharedIpCount, sharedDeviceCount };
    })
    .filter(({ usefulSharedIpCount, sharedDeviceCount }) => sharedDeviceCount > 0 || usefulSharedIpCount > 0);

  return {
    linkedAccounts: candidates.map(({ other, sharedIpCount, sharedDeviceCount }) => ({
      id: other.id,
      username: other.username,
      email: other.email || '',
      provider: authProvider(other),
      createdAt: other.createdAt || null,
      sharedIpCount,
      sharedDeviceCount,
    })),
    linkedEmails: candidates.map(({ other }) => other.email).filter(Boolean),
    matchCount: candidates.length,
    ipMatchCount: candidates.filter(({ sharedIpCount }) => sharedIpCount > 0).length,
    weakLinkCount: candidates.filter(({ sharedDeviceCount, usefulSharedIpCount }) => sharedDeviceCount === 0 && usefulSharedIpCount > 0).length,
  };
}

function safeAdminUser(u, users) {
  const base = safeUser(u);
  const risk = getUserIpRisk(u, users);
  const ipAddresses = Array.isArray(u.ipAddresses) ? u.ipAddresses.slice(-5).reverse() : [];
  const ipIntel = u.ipIntel || {};
  return {
    ...base,
    authProvider: authProvider(u),
    hasDiscord: Boolean(u.discordId),
    hasGoogle: Boolean(u.googleId),
    ipTracked: Array.isArray(u.ipHashes) && u.ipHashes.length > 0,
    accessCount: Array.isArray(u.ipHashes) ? u.ipHashes.length : 0,
    linkedAccountCount: risk.matchCount,
    ipMatchCount: risk.ipMatchCount || 0,
    linkedEmails: risk.linkedEmails,
    linkedAccounts: risk.linkedAccounts,
    possibleDoubleAccount: risk.matchCount > 0,
    weakIpLinkCount: risk.weakLinkCount,
    lastIpAt: u.lastIpAt || null,
    lastIp: u.lastIp || null,
    ipAddresses: ipAddresses.map((ip) => ({
      ip,
      vpnOrProxy: Boolean(ipIntel[ip]?.isVpnOrProxy),
      isp: ipIntel[ip]?.isp || '',
    })),
  };
}

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'https://panel.qubiqobots.it/auth/discord/callback';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const DISCORD_TICKET_CATEGORY_ID = process.env.DISCORD_TICKET_CATEGORY_ID || '';
const DISCORD_TICKET_STAFF_ROLE_ID = process.env.DISCORD_TICKET_STAFF_ROLE_ID || '';
const DISCORD_INTERNAL_SECRET = process.env.DISCORD_INTERNAL_SECRET || '';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://panel.qubiqohost.it/auth/google/callback';
const GOOGLE_TOKEN_API = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_API = 'https://openidconnect.googleapis.com/v1/userinfo';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_MODE = String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const PAYPAL_API = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://panel.qubiqohost.it').replace(/\/+$/, '');
const PUBLIC_BASE_HOST = (() => { try { return new URL(PUBLIC_BASE_URL).hostname.toLowerCase(); } catch (_) { return 'panel.qubiqohost.it'; } })();
const AUTH_ALLOWED_HOSTS = new Set(String(process.env.AUTH_ALLOWED_HOSTS || PUBLIC_BASE_HOST).split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const SLOT_CREDIT_COST = Math.max(1, Number(process.env.SLOT_CREDIT_COST || 100));

const DEFAULT_CREDIT_PACKAGES = [
  { id: 'credits_100', credits: 100, amountCents: 500, label: '100 crediti' },
  { id: 'credits_250', credits: 250, amountCents: 1000, label: '250 crediti' },
  { id: 'credits_600', credits: 600, amountCents: 2000, label: '600 crediti' },
];
const DEFAULT_BILLING_SETTINGS = { slotCreditCost: 100, currency: 'EUR' };

function getBillingConfig(db) {
  db.billing ||= {};
  db.billing.transactions ||= [];
  db.billing.packages ||= DEFAULT_CREDIT_PACKAGES.map(x => ({ ...x }));
  db.billing.coupons ||= [];
  db.billing.settings ||= { ...DEFAULT_BILLING_SETTINGS };
  if (!Number.isFinite(db.billing.settings.slotCreditCost) || db.billing.settings.slotCreditCost < 1) {
    db.billing.settings.slotCreditCost = DEFAULT_BILLING_SETTINGS.slotCreditCost;
  }
  db.billing.settings.currency = 'EUR';
  return db.billing;
}

function getCreditPackages(db) {
  const billing = getBillingConfig(db);
  return billing.packages
    .map((p, i) => ({
      id: String(p.id || `credits_${i + 1}`),
      credits: Math.max(1, Math.floor(Number(p.credits))),
      amountCents: Math.max(50, Math.floor(Number(p.amountCents))),
      label: String(p.label || `${p.credits} crediti`).slice(0, 80),
    }))
    .filter(p => Number.isFinite(p.credits) && Number.isFinite(p.amountCents));
}

async function discordBotRequest(endpoint, options = {}) {
  if (!DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN non configurato');
  const response = await fetch(`${DISCORD_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Discord API ${response.status}`);
  return data;
}

async function createDiscordTicketChannel(ticket, user) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return null;
  const safeName = `ticket-${ticket.number}-${String(user.username).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 35)}`;
  const overwrites = [
    { id: DISCORD_GUILD_ID, type: 0, deny: '1024', allow: '0' },
  ];
  if (DISCORD_TICKET_STAFF_ROLE_ID) overwrites.push({ id: DISCORD_TICKET_STAFF_ROLE_ID, type: 0, allow: '1024', deny: '0' });
  const channel = await discordBotRequest(`/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      name: safeName,
      type: 0,
      parent_id: DISCORD_TICKET_CATEGORY_ID || null,
      topic: `QubiqoHost ticket #${ticket.number} • ${ticket.subject}`.slice(0, 1024),
      permission_overwrites: overwrites,
    }),
  });
  const content = `🎫 **Ticket #${ticket.number}**\n**Utente:** ${user.username}\n**Categoria:** ${ticket.category}\n**Oggetto:** ${ticket.subject}\n\n${ticket.messages[0]?.content || 'Nessun messaggio.'}`;
  await discordBotRequest(`/channels/${channel.id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
  return channel.id;
}

async function sendDiscordTicketMessage(channelId, ticket, author, content) {
  if (!channelId || !DISCORD_BOT_TOKEN) return;
  await discordBotRequest(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: `**${author}** · Ticket #${ticket.number}\n${content}` }) });
}

function billingConfigured() {
  return Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);
}

async function paypalAccessToken() {
  if (!billingConfigured()) throw new Error('Billing non configurato: mancano PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET');
  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.message || 'Impossibile ottenere il token PayPal');
  return data.access_token;
}

async function paypalRequest(endpoint, options = {}) {
  const token = await paypalAccessToken();
  const response = await fetch(`${PAYPAL_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.details?.map(x => x.description).filter(Boolean).join(', ');
    throw new Error(detail || data.message || data.name || 'Errore PayPal');
  }
  return data;
}

function billingTransactionExists(db, providerId) {
  return db.billing.transactions.some(t => t.providerId === providerId && t.status === 'completed');
}

function finalizeCreditPurchase(providerId, userId, eventType) {
  let result = { ok: false, reason: 'unknown' };
  withDb(db => {
    if (billingTransactionExists(db, providerId)) {
      result = { ok: true, duplicate: true };
      return;
    }
    const pending = db.billing.transactions.find(t => t.providerId === providerId && t.userId === userId && t.status === 'pending');
    if (!pending) {
      result = { ok: false, reason: 'transazione non trovata' };
      return;
    }
    const user = db.users.find(u => u.id === userId);
    if (!user) {
      result = { ok: false, reason: 'utente non trovato' };
      return;
    }
    const credits = Math.floor(Number(pending.credits));
    if (!Number.isFinite(credits) || credits <= 0) {
      result = { ok: false, reason: 'crediti non validi' };
      return;
    }
    user.credits = (Number.isFinite(user.credits) ? user.credits : 0) + credits;
    pending.status = 'completed';
    pending.completedAt = Date.now();
    pending.eventType = eventType;
    pending.provider = 'paypal';
    result = { ok: true, userId, credits };
  });
  return result;
}


const adminLoginAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of adminLoginAttempts) {
    if (now - Number(value.firstAt || 0) > 15 * 60 * 1000 && Number(value.blockedUntil || 0) < now) adminLoginAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

function generatePin(db) {
  let pin;
  do {
    pin = crypto.randomBytes(4).toString('hex').toUpperCase();
    pin = pin.slice(0, 4) + '-' + pin.slice(4);
  } while (db.users.some(u => u.pin === pin));
  return pin;
}

withDb(db => {
  if (db.users.length === 0) {
    const initialPassword = String(process.env.ADMIN_DEFAULT_PASSWORD || crypto.randomBytes(18).toString('base64url'));
    const { salt, hash } = auth.hashPassword(initialPassword);
    db.users.push({
      id: crypto.randomUUID(),
      username: 'admin',
      email: 'admin@qubiqohost.local',
      pin: generatePin(db),
      salt, hash,
      role: 'admin',
      suspended: false,
      slots: DEFAULT_SLOTS,
      createdAt: Date.now(),
    });
    if (!process.env.ADMIN_DEFAULT_PASSWORD) console.log(`[QubiqoHost] Password iniziale admin: ${initialPassword}`);
  }
});

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object';
  const payload = isJson ? JSON.stringify(body) : body;
  const baseHeaders = {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  };
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const acceptEncoding = res.__acceptEncoding || '';
  if (payloadBuffer.length > 800 && /\bgzip\b/.test(acceptEncoding) && !res.headersSent) {
    zlib.gzip(payloadBuffer, { level: 6 }, (err, compressed) => {
      if (err || res.headersSent) {
        res.writeHead(status, { ...baseHeaders, 'Vary': 'Accept-Encoding' });
        return res.end(payloadBuffer);
      }
      res.writeHead(status, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(compressed);
    });
    return;
  }
  res.writeHead(status, { ...baseHeaders, 'Vary': 'Accept-Encoding' });
  res.end(payloadBuffer);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    const fail = error => {
      if (rejected) return;
      rejected = true;
      try { req.resume(); } catch (_) {}
      reject(error);
    };
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > maxBytes) {
      const error = new Error(`Payload massimo ${Math.floor(maxBytes / 1024 / 1024)} MB`);
      error.code = 'PAYLOAD_TOO_LARGE';
      return fail(error);
    }
    req.on('data', c => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        const error = new Error(`Payload massimo ${Math.floor(maxBytes / 1024 / 1024)} MB`);
        error.code = 'PAYLOAD_TOO_LARGE';
        fail(error);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks, total)); });
    req.on('error', error => { if (!rejected) reject(error); });
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!match) return { files: [] };
  const boundary = '--' + (match[1] || match[2]);
  const parts = splitBuffer(buffer, Buffer.from(boundary));
  const files = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf8');
    let content = part.slice(headerEnd + 4);
    if (content.slice(-2).toString() === '\r\n') content = content.slice(0, -2);
    const filenameMatch = /filename="([^"]*)"/.exec(headerStr);
    if (filenameMatch && filenameMatch[1]) {
      files.push({ filename: filenameMatch[1], data: content });
    }
  }
  return { files };
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buffer.indexOf(delimiter, start)) !== -1) {
    if (start !== 0) parts.push(buffer.slice(start, idx));
    start = idx + delimiter.length;
  }
  return parts;
}

function getCurrentUser(req) {
  const cookies = auth.parseCookies(req);
  const session = auth.getSession(cookies.session);
  if (!session) return null;
  const db = readDb();
  const user = db.users.find(u => u.id === session.userId);
  if (!user || user.suspended) return null;
  return user;
}

const AUDIT_MAX_ENTRIES = 10000;

function auditCategoryLabel(category) {
  return ['account', 'movement', 'action', 'admin'].includes(category) ? category : 'movement';
}

function auditEvent(req, user, category, action, details = '') {
  if (!user) return;
  try {
    const ip = getClientIp(req);
    const safeAction = String(action || '').trim().slice(0, 180);
    const safeDetails = String(details || '').trim().slice(0, 500);
    if (!safeAction) return;
    withDb(db => {
      db.auditLogs ||= [];
      db.auditLogs.push({
        id: crypto.randomUUID(),
        category: auditCategoryLabel(category),
        userId: user.id,
        username: String(user.username || '—'),
        email: String(user.email || '—'),
        ip: String(ip || '—'),
        action: safeAction,
        details: safeDetails,
        createdAt: Date.now(),
      });
      if (db.auditLogs.length > AUDIT_MAX_ENTRIES) {
        db.auditLogs.splice(0, db.auditLogs.length - AUDIT_MAX_ENTRIES);
      }
    });
  } catch (error) {
    console.warn('[audit] Impossibile salvare evento:', error.message || error);
  }
}

function auditAdminRequest(req, user, pathname, method) {
  if (!user || user.role !== 'admin' || method === 'GET') return;
  if (req._qhAdminAuditRecorded) return;
  const clean = String(pathname || '');
  if (/^\/api\/admin\/(email|users|backups)(?:\/|$)/.test(clean)) return;
  let action = 'Operazione amministrativa';
  if (/\/email$/.test(clean)) action = 'Invio email';
  else if (/\/users$/.test(clean)) action = method === 'POST' ? 'Creazione utente' : 'Gestione utenti';
  else if (/\/users\//.test(clean)) action = method === 'DELETE' ? 'Eliminazione utente' : 'Modifica utente';
  else if (/\/backups$/.test(clean)) action = 'Creazione backup';
  else if (/\/backups\//.test(clean)) action = method === 'DELETE' ? 'Eliminazione backup' : 'Gestione backup';
  else if (/\/billing\/settings/.test(clean)) action = 'Modifica impostazioni fatturazione';
  else if (/\/billing\/packages/.test(clean)) action = method === 'POST' ? 'Creazione piano crediti' : method === 'DELETE' ? 'Eliminazione piano crediti' : 'Modifica piano crediti';
  else if (/\/billing\/coupons/.test(clean)) action = 'Gestione coupon';
  else if (/\/servers/.test(clean)) action = method === 'POST' ? 'Creazione server' : method === 'DELETE' ? 'Eliminazione server' : 'Modifica server';
  else if (/\/nodes/.test(clean)) action = method === 'POST' ? 'Creazione nodo' : method === 'DELETE' ? 'Eliminazione nodo' : 'Gestione nodo';
  else if (/\/databases/.test(clean)) action = method === 'POST' ? 'Creazione database' : method === 'DELETE' ? 'Eliminazione database' : 'Modifica database';
  else if (/\/network/.test(clean)) action = method === 'POST' ? 'Creazione regola network' : method === 'DELETE' ? 'Eliminazione regola network' : 'Modifica regola network';
  else if (/\/tickets/.test(clean)) action = 'Gestione ticket';
  else if (/\/file/.test(clean) || /\/files/.test(clean) || /\/folders/.test(clean) || /\/upload/.test(clean)) action = 'Gestione file server';
  auditEvent(req, user, 'admin', action);
  req._qhAdminAuditRecorded = true;
}

function auditUserMovementRequest(req, user, pathname, method) {
  if (!user || user.role === 'admin' || method === 'GET') return;
  const clean = String(pathname || '');
  if (/^\/api\/audit\//.test(clean)) return;
  if (/^\/api\/billing\/buy-slot$/.test(clean) || /^\/api\/servers\/[^/]+\/(start|stop|restart)$/.test(clean) || /^\/api\/panel\/backups(?:\/[^/]+)?$/.test(clean)) return;
  let action = 'Operazione nel pannello';
  if (/^\/api\/servers$/.test(clean)) action = method === 'POST' ? 'Creazione bot' : 'Gestione bot';
  else if (/^\/api\/servers\/[^/]+\/command$/.test(clean)) action = 'Comando console';
  else if (/^\/api\/servers\/[^/]+\/file/.test(clean) || /\/files(?:\/create)?$/.test(clean) || /\/folders\/create$/.test(clean) || /\/upload$/.test(clean)) action = 'Gestione file';
  else if (/^\/api\/panel\/databases/.test(clean)) action = method === 'POST' ? 'Creazione database' : 'Gestione database';
  else if (/^\/api\/panel\/network/.test(clean)) action = method === 'POST' ? 'Creazione regola network' : 'Gestione network';
  else if (/^\/api\/panel\/subusers/.test(clean)) action = method === 'POST' ? 'Creazione collaboratore' : 'Gestione collaboratori';
  else if (/^\/api\/panel\/tickets/.test(clean)) action = method === 'POST' ? 'Apertura ticket' : 'Aggiornamento ticket';
  else if (/^\/api\/panel\/settings$/.test(clean)) action = 'Modifica impostazioni account';
  else if (/^\/api\/billing\/(redeem|checkout|confirm)$/.test(clean)) action = 'Operazione fatturazione';
  auditEvent(req, user, 'movement', action);
}

function auditCreatedAccount(req, user, provider = 'manuale') {
  auditEvent(req, user, 'account', 'Account creato', `Registrazione ${provider}`);
}

function safeUser(u) {
  return {
    id: u.id, username: u.username, email: u.email,
    emailVerified: u.emailVerified !== false, pin: u.pin,
    discordConnected: Boolean(u.discordId),
    googleConnected: Boolean(u.googleId),
    role: u.role, suspended: u.suspended, createdAt: u.createdAt,
    slots: Number.isFinite(u.slots) ? u.slots : DEFAULT_SLOTS,
    credits: Number.isFinite(u.credits) ? u.credits : 0,
  };
}

const runtimeStatusCache = new Map();
const runtimeStatusRefresh = new Set();
const runtimeDiskCache = new Map();
const runtimeStatsCache = new Map();
const runtimeNodeStatsCache = new Map();
let runtimeStatsRefreshRunning = false;

function refreshAllRuntimeStats() {
  const statusFile = path.join(DATA_DIR, 'runtime-stats.json');
  try {
    if (!fs.existsSync(statusFile)) return;
    const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.servers) return;
    for (const [id, stats] of Object.entries(parsed.servers)) {
      if (!stats || typeof stats !== 'object') continue;
      runtimeStatsCache.set(String(id), {
        running: !!stats.running,
        cpuPercent: Number(stats.cpuPercent) || 0,
        ramMB: Number(stats.ramMB) || 0,
        diskMB: Number(stats.diskMB) || 0,
        uptimeSeconds: Number(stats.uptimeSeconds) || 0,
        startedAt: stats.startedAt || null,
        updatedAt: Number(stats.updatedAt) || Date.now(),
      });
    }
    for (const [id, stats] of Object.entries(parsed.nodes || {})) {
      if (!stats || typeof stats !== 'object') continue;
      runtimeNodeStatsCache.set(String(id), {
        online: !!stats.online,
        hostname: stats.hostname || null,
        cpuPercent: Number(stats.cpuPercent) || 0,
        cpuCores: Number(stats.cpuCores) || 0,
        load1: Number(stats.load1) || 0,
        ramUsedMB: Number(stats.ramUsedMB) || 0,
        ramTotalMB: Number(stats.ramTotalMB) || 0,
        ramPercent: Number(stats.ramPercent) || 0,
        diskUsedMB: Number(stats.diskUsedMB) || 0,
        diskTotalMB: Number(stats.diskTotalMB) || 0,
        diskPercent: Number(stats.diskPercent) || 0,
        uptimeSeconds: Number(stats.uptimeSeconds) || 0,
        updatedAt: Number(stats.updatedAt) || Date.now(),
        error: stats.error || null,
      });
    }
  } catch (_) {}
}


function serverStatusKey(server) {
  return String(server?.id || '');
}

function getCachedRunning(server) {
  const key = serverStatusKey(server);
  if (!key) return false;

  // Un'azione appena richiesta ha priorità assoluta sui dati runtime
  // precedenti: evita che una vecchia lettura faccia tornare la card
  // momentaneamente a Online/Offline dopo Start, Stop o Riavvia.
  const action = runtimeStatusCache.get(key);
  if (action) {
    const age = Date.now() - Number(action.updatedAt || 0);
    if (action.pending || age < 10000) return !!action.running;
  }

  const stats = runtimeStatsCache.get(key);
  if (stats) {
    const age = Date.now() - Number(stats.updatedAt || 0);

    // Il runtime worker è la fonte primaria dello stato reale quando il dato
    // è recente.
    if (age < 30000) return !!stats.running;
  }

  // Persistenza: se il pannello viene riavviato o il runtime worker non ha
  // ancora pubblicato le statistiche, usa lo stato salvato del server.
  return server.status === 'running';
}
function refreshServerRuntimeStatus(server, db) {
  return getCachedRunning(server);
}

function refreshServerDisk(server, db, staleMs = 15000) {
  const key = serverStatusKey(server);
  if (!key) return 0;
  const cached = runtimeStatsCache.get(key);
  if (cached && Number(cached.updatedAt || 0) + staleMs >= Date.now()) return Number(cached.diskMB) || 0;
  return Number(cached?.diskMB) || 0;
}

function safeServer(s, db) {
  const { botToken, folder, ...rest } = s;
  const running = getCachedRunning(s);
  return { ...rest, running };
}

const COLLABORATOR_PERMISSIONS = ['console.read','files.read','files.write','server.start','server.stop','server.restart'];
function getCollaboratorLink(user, server, db) {
  if (!user || !server || user.role === 'admin' || server.ownerId === user.id) return null;
  return (db.subusers || []).find(x => {
    const linked = x.userId || (db.users || []).find(u => String(u.username||'').toLowerCase() === String(x.username||'').toLowerCase() || String(u.email||'').toLowerCase() === String(x.username||'').toLowerCase())?.id;
    return linked === user.id && x.ownerId === server.ownerId && Array.isArray(x.serverIds) && x.serverIds.map(String).includes(String(server.id));
  }) || null;
}
function canAccessServer(user, server, db, permission='server.view') {
  if (!user || !server) return false;
  if (user.role === 'admin' || server.ownerId === user.id) return true;
  const link=getCollaboratorLink(user,server,db);
  return !!link && (permission==='server.view' || (link.permissions||[]).includes(permission));
}
function collaboratorPermissionsForServer(user,server,db) {
  if (user?.role === 'admin' || server?.ownerId === user?.id) return COLLABORATOR_PERMISSIONS.slice();
  return (getCollaboratorLink(user,server,db)?.permissions || []).filter(x=>COLLABORATOR_PERMISSIONS.includes(x));
}
function findExistingAccount(db, identifier) {
  const v=String(identifier||'').trim().toLowerCase();
  return v ? (db.users||[]).find(u=>String(u.username||'').trim().toLowerCase()===v || String(u.email||'').trim().toLowerCase()===v) || null : null;
}

function runNodeSsh(node, command, timeout = 12000) {
  return rfs.sshRun(node, command, { timeout, maxBuffer: 2 * 1024 * 1024 });
}

function runNodeSshAsync(node, command, timeout = 12000) {
  return rfs.sshRunAsync(node, command, { timeout, maxBuffer: 2 * 1024 * 1024 });
}

async function testNodeConnectionAsync(node) {
  const output = await runNodeSshAsync(node, "printf 'QUBIQOHOST_NODE_OK\n'; hostname; uname -s; nproc; awk '/MemTotal:/ {print $2}' /proc/meminfo; df -Pm / | awk 'NR==2 {print $2, $3, $4}'");
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines[0] !== 'QUBIQOHOST_NODE_OK') throw new Error('Risposta SSH del nodo non valida');
  return {
    hostname: lines[1] || node.host,
    os: lines[2] || 'Linux',
    cpuCores: Number(lines[3]) || 0,
    memoryMB: Math.round((Number(lines[4]) || 0) / 1024),
    disk: (() => {
      const p = String(lines[5] || '').split(/\s+/).map(Number);
      return { totalMB: p[0] || 0, usedMB: p[1] || 0, freeMB: p[2] || 0 };
    })(),
  };
}

function testNodeConnection(node) {
  const output = runNodeSsh(node, "printf 'QUBIQOHOST_NODE_OK\\n'; hostname; uname -s; nproc; awk '/MemTotal:/ {print $2}' /proc/meminfo; df -Pm / | awk 'NR==2 {print $2, $3, $4}'");
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines[0] !== 'QUBIQOHOST_NODE_OK') throw new Error('Risposta SSH del nodo non valida');
  return {
    hostname: lines[1] || node.host,
    os: lines[2] || 'Linux',
    cpuCores: Number(lines[3]) || 0,
    memoryMB: Math.round((Number(lines[4]) || 0) / 1024),
    disk: (() => {
      const p = String(lines[5] || '').split(/\s+/).map(Number);
      return { totalMB: p[0] || 0, usedMB: p[1] || 0, freeMB: p[2] || 0 };
    })(),
  };
}

const getDefaultNode = nodeSelector.getDefaultNode;

function assignUserToDefaultNode(db, userId) {
  if (!userId) return null;
  const defaultNode = getDefaultNode(db);
  for (const n of (db.nodes || [])) n.userIds = Array.isArray(n.userIds) ? n.userIds.filter(id => id !== userId) : [];
  if (defaultNode) {
    defaultNode.userIds = Array.isArray(defaultNode.userIds) ? defaultNode.userIds : [];
    if (!defaultNode.userIds.includes(userId)) defaultNode.userIds.push(userId);
  }
  for (const s of (db.servers || [])) if (s.ownerId === userId) s.nodeId = defaultNode ? defaultNode.id : null;
  return defaultNode;
}

function getOrAssignUserNode(db, userId) {
  const assigned = (db.nodes || []).find(node => Array.isArray(node.userIds) && node.userIds.includes(userId));
  return assigned || assignUserToDefaultNode(db, userId);
}

function serverFolder(server) {
  if (!server?.id) throw new Error('Server non valido');
  const db = readDb();
  const node = getServerNode(server, db);
  if (!node) throw new Error('Nessun nodo predefinito disponibile per lo storage del server');
  return storage.serverStorageFolder({ ...server, nodeId: node.id }, db, node);
}

function getServerNode(server, db) {
  if (!server) return null;
  const state = db || {};
  if (server.nodeId) {
    return (state.nodes || []).find(n => String(n.id) === String(server.nodeId)) || null;
  }
  return getDefaultNode(state);
}

function fileOps(node) {
  if (!node) throw new Error('Nessun nodo remoto disponibile per l operazione sul filesystem');
  return { remote: true, exists: p => rfs.exists(node, p), isDir: p => rfs.isDirectory(node, p), mkdir: p => rfs.mkdir(node, p), remove: p => rfs.remove(node, p), rename: (a, b) => rfs.rename(node, a, b), list: p => rfs.list(node, p), readFile: p => rfs.readFile(node, p), readFileBuffer: p => rfs.readFileBuffer(node, p), writeFile: (p, c) => rfs.writeFile(node, p, c) };
}

function nodeStorageBase(node) { return storage.nodeStorageBase(node); }
function userStorageFolder(user, node) { return storage.userStorageFolder(user, node); }
function ensureUserStorageRoot(user, node) {
  const folder = userStorageFolder(user, node);
  runNodeSsh(node, `mkdir -p ${rfs.q(folder)} && chmod 755 ${rfs.q(folder)}`, 15000);
  return folder;
}
function safeStorageName(value, fallback = 'server') { return storage.safeName(value, fallback); }
function serverStorageFolder(server, db) {
  const node = getServerNode(server, db);
  if (!node) throw new Error('Nessun nodo disponibile per lo storage del server');
  return storage.serverStorageFolder({ ...server, nodeId: node.id }, db, node);
}

function legacyServerStorageCandidates(server, db) {
  if (!server?.nodeId) return [];
  const node = (db?.nodes || []).find(n => n.id === server.nodeId);
  if (!node) return [];
  const owner = (db?.users || []).find(u => u.id === server.ownerId);
  const userKey = storage.userKey(owner || { id: server.ownerId });
  const oldName = safeStorageName(server.name, String(server.id || 'server'));
  const base = nodeStorageBase(node);
  const values = [path.posix.join(base, userKey, String(server.id)), path.posix.join(base, userKey, oldName)];
  if (server.folder && String(server.folder).startsWith(base + '/')) values.push(String(server.folder));
  return [...new Set(values)];
}

function moveServerStorage(server, db) {
  if (!server || !server.id) throw new Error('Server non valido');
  const state = db || {};
  const node = getServerNode(server, state);
  const target = serverStorageFolder({ ...server, nodeId: node?.id || server.nodeId }, state);
  const isRemote = Boolean(node);

  if (!node) throw new Error('Nodo non trovato per lo storage remoto');
  const qPath = v => String(v).replace(/'/g, `'\\''`);

  runNodeSsh(node, `mkdir -p '${qPath(target)}' && chmod 755 '${qPath(target)}'`, 20000);

  const candidates = legacyServerStorageCandidates(server, db)
    .filter(candidate => candidate !== target);
  for (const legacy of candidates) {
    try {
      const command = [
        `if [ -d '${qPath(legacy)}' ] && [ '${qPath(legacy)}' != '${qPath(target)}' ]; then`,
        `  cp -an '${qPath(legacy)}/.' '${qPath(target)}/' 2>/dev/null || true;`,
        `  find '${qPath(legacy)}' -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true;`,
        `  rmdir '${qPath(legacy)}' 2>/dev/null || true;`,
        `fi`,
      ].join(' ');
      runNodeSsh(node, command, 60000);
    } catch (e) {
      console.warn(`[storage] Migrazione legacy ${legacy} -> ${target}: ${e.message}`);
    }
  }

  return target;
}

function migrateLegacyBackups() { return; }

function migrateAllServerStorage() {
  const db = readDb();
  if (!Array.isArray(db.servers)) return;
  const defaultNode = getDefaultNode(db);
  if (!defaultNode) return;
  for (const user of (db.users || [])) {
    try { ensureUserStorageRoot(user, defaultNode); } catch (_) {}
  }
  for (const server of db.servers) {
    try {
      if (!server.nodeId) {
        withDb(d => { const item=d.servers.find(x=>x.id===server.id); if(item) { item.nodeId=defaultNode.id; item.folder=serverStorageFolder(item,d); } });
        server.nodeId=defaultNode.id;
      }
      if (String(server.nodeId) !== String(defaultNode.id)) continue;
      const folder=moveServerStorage(server,db);
      if(server.folder!==folder) withDb(d=>{const item=d.servers.find(x=>x.id===server.id);if(item)item.folder=folder;});
    } catch (e) {
      console.warn(`[migrate] Server ${server.id}: ${e.message}`);
    }
  }
}

function resolveServerRelativePath(server, relativePath = '') {
  const root = serverFolder(server);
  const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.posix.resolve(root, rel || '.');
  const rootResolved = path.posix.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + '/')) throw new Error('Percorso non valido');
  return target;
}

function statSafeIsDirectory(target) {
  try { return fs.existsSync(target) && fs.statSync(target).isDirectory(); } catch (_) { return false; }
}

function safeFileName(name) {
  const value = String(name || '').trim();
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) return null;
  return value;
}

function sessionCookie(token, req) {
  const secure = req?.socket?.encrypted || req?.headers?.['x-forwarded-proto'] === 'https';
  return `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`;
}

function requestHost(req) {
  return String(req.headers.host || '').split(':')[0].trim().toLowerCase();
}

function isAllowedAuthHost(req) {
  return AUTH_ALLOWED_HOSTS.has(requestHost(req));
}

function isAuthPagePath(p) {
  return p === '/' || p === '/index.html' || p === '/register.html' || p === '/login.html' || p === '/admin.html' || p === '/admin' || p === '/forgot-password' || p === '/reset-password';
}

function isAuthEndpoint(p) {
  return p === '/api/login' || p === '/api/register' || p === '/api/admin/login' || p === '/api/resend-verification' || p === '/api/forgot-password' || p === '/api/reset-password' || p === '/auth/discord' || p === '/auth/discord/callback' || p === '/auth/google' || p === '/auth/google/callback';
}

function clearSessionCookie(req) {
  const secure = req?.socket?.encrypted || req?.headers?.['x-forwarded-proto'] === 'https';
  return `session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function cookieValue(name, value, maxAge = 600) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}; Secure`;
}

function clearCookie(name) {
  return `${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure`;
}

function normalizeUsername(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 24);
}

function uniqueUsername(db, base) {
  let username = normalizeUsername(base) || 'discorduser';
  if (username.length < 3) username = `user${username}`.slice(0, 24);
  const original = username;
  let n = 1;
  while (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    const suffix = String(n++);
    username = `${original.slice(0, Math.max(3, 24 - suffix.length))}${suffix}`;
  }
  return username;
}

function discordConfigured() {
  return Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI);
}

function discordAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: DISCORD_REDIRECT_URI,
    scope: 'identify email',
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeDiscordCode(code) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: DISCORD_REDIRECT_URI,
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.message || 'Autorizzazione Discord non riuscita');
  }
  return data.access_token;
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    throw new Error(data.message || 'Impossibile leggere il profilo Discord');
  }
  return data;
}

function googleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
}

function googleAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: GOOGLE_REDIRECT_URI,
  });

  const response = await fetch(GOOGLE_TOKEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Autorizzazione Google non riuscita');
  }
  return data.access_token;
}

async function fetchGoogleUser(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_API, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.sub) {
    throw new Error(data.error_description || data.error || 'Impossibile leggere il profilo Google');
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createEmailVerification(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + EMAIL_VERIFICATION_TTL_MS;
  withDb(db => {
    const current = db.users.find(u => u.id === user.id);
    if (!current) throw new Error('Utente non trovato');
    current.emailVerified = false;
    current.emailVerificationTokenHash = tokenHash;
    current.emailVerificationExpiresAt = expiresAt;
  });
  return { token, expiresAt };
}

function verificationEmailHtml(user, verifyUrl) {
  const username = escapeHtml(user.username);
  const url = escapeHtml(verifyUrl);
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>Verifica il tuo indirizzo email — QubiqoHost</title>
</head>
<body style="margin:0;padding:0;background:#f3f6f6;color:#10212c;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f3f6f6;">
    <tr>
      <td align="center" style="padding:28px 14px;">
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:620px;background:#ffffff;border:1px solid rgba(2,167,189,.18);border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:3px;background:linear-gradient(135deg,#087f93,#02a7bd);font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 24px 24px;background:#f3f6f6;border-bottom:1px solid #dfe7e8;">
              <div style="font-size:25px;line-height:32px;font-weight:800;color:#10212c;">QubiqoHost</div>
              <div style="margin-top:6px;font-size:12px;line-height:18px;color:#687781;">Hosting control center</div>
            </td>
          </tr>
          <tr>
            <td style="padding:38px 32px 34px;background:#ffffff;">
              <div style="font-size:12px;line-height:18px;color:#007f93;text-transform:uppercase;letter-spacing:2px;font-weight:800;margin-bottom:12px;">Verifica account</div>
              <h1 style="margin:0 0 18px;font-size:27px;line-height:35px;font-weight:800;color:#10212c;">Verifica il tuo indirizzo email</h1>
              <p style="margin:0 0 12px;font-size:16px;line-height:25px;color:#233740;">Ciao <strong style="color:#10212c;">${username}</strong>,</p>
              <p style="margin:0 0 28px;font-size:15px;line-height:25px;color:#687781;">Grazie per esserti registrato a QubiqoHost. Per completare la registrazione e accedere al pannello, conferma il tuo indirizzo email tramite il pulsante qui sotto.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 28px;">
                <tr>
                  <td align="center" style="border-radius:10px;background:linear-gradient(135deg,#087f93,#02a7bd);">
                    <a href="${url}" style="display:inline-block;padding:15px 30px;border-radius:10px;color:#ffffff;text-decoration:none;font-size:15px;line-height:20px;font-weight:800;">Verifica email</a>
                  </td>
                </tr>
              </table>
              <div style="height:1px;background:#dfe7e8;margin:0 0 22px;">&nbsp;</div>
              <p style="margin:0 0 10px;font-size:13px;line-height:21px;color:#687781;">Il link di verifica è valido per 30 minuti.</p>
              <p style="margin:0 0 20px;font-size:13px;line-height:21px;color:#687781;">Se non hai creato tu questo account, puoi ignorare questa email.</p>
              <p style="margin:0;font-size:12px;line-height:19px;color:#687781;word-break:break-all;">Se il pulsante non funziona, copia e incolla questo indirizzo nel browser:<br><span style="color:#2f7fda;">${url}</span></p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px 24px 26px;background:#f3f6f6;border-top:1px solid #dfe7e8;">
              <div style="font-size:14px;line-height:20px;font-weight:800;color:#10212c;">QubiqoHost</div>
              <div style="margin-top:5px;font-size:12px;line-height:18px;color:#687781;">Managed by Variune Studios</div>
              <div style="margin-top:9px;font-size:12px;line-height:18px;color:#687781;">info@qubiqohost.it · qubiqohost.it</div>
            </td>
          </tr>
        </table>
        <div style="max-width:620px;padding:14px 16px 0;font-size:10px;line-height:16px;color:#454d63;text-align:center;">Email automatica di verifica account QubiqoHost. Non rispondere a questo messaggio.</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
function manualEmailHtml(subject, message) {
  const safeSubject = escapeHtml(String(subject || '').trim());
  const safeMessage = escapeHtml(String(message || '').trim());
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${safeSubject} — QubiqoHost</title>
</head>
<body style="margin:0;padding:0;background:#0b0d12;color:#eef5f7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#0b0d12;">
    <tr>
      <td align="center" style="padding:28px 14px;">
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:620px;background:#12161a;border:1px solid rgba(2,167,189,.22);border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:3px;background:linear-gradient(135deg,#087f93,#02a7bd);font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 24px 24px;background:#171c20;border-bottom:1px solid #293137;">
              <div style="font-size:25px;line-height:32px;font-weight:800;color:#f2f8fa;">QubiqoHost</div>
              <div style="margin-top:6px;font-size:12px;line-height:18px;color:#91a0a8;">Hosting control center</div>
            </td>
          </tr>
          <tr>
            <td style="padding:38px 32px 40px;background:#0f1113;">
              <h1 style="margin:0 0 22px;font-size:27px;line-height:35px;font-weight:800;color:#f2f8fa;">${safeSubject}</h1>
              <div style="font-size:15px;line-height:25px;color:#a4b0b7;white-space:pre-wrap;word-break:break-word;">${safeMessage}</div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px 24px 26px;background:#171c20;border-top:1px solid #293137;">
              <div style="font-size:14px;line-height:20px;font-weight:800;color:#f2f8fa;">QubiqoHost</div>
              <div style="margin-top:5px;font-size:12px;line-height:18px;color:#91a0a8;">Managed by Variune Studios</div>
              <div style="margin-top:9px;font-size:12px;line-height:18px;color:#91a0a8;">info@qubiqohost.it · qubiqohost.it</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendManualAdminEmail(user, subject, message) {
  const cleanSubject = String(subject || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanSubject) throw new Error("Inserisci il titolo dell'email");
  if (!cleanMessage) throw new Error("Inserisci il messaggio dell'email");
  if (cleanSubject.length > 180) throw new Error('Il titolo è troppo lungo');
  if (cleanMessage.length > 20000) throw new Error('Il messaggio è troppo lungo');
  return sendMail({
    to: user.email,
    subject: cleanSubject,
    text: `${cleanMessage}\n\nQubiqoHost - Managed by Variune Studios\ninfo@qubiqohost.it\nqubiqohost.it`,
    html: manualEmailHtml(cleanSubject, cleanMessage),
  });
}

async function sendVerificationEmail(user) {
  const { token } = createEmailVerification(user);
  const verifyUrl = `${PUBLIC_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  return sendMail({
    to: user.email,
    subject: 'Verifica il tuo indirizzo email — QubiqoHost',
    text: `Ciao ${user.username}, verifica il tuo indirizzo email aprendo questo link: ${verifyUrl}\n\nIl link è valido per 30 minuti.\n\nQubiqoHost — Managed by Variune Studios\ninfo@qubiqohost.it`,
    html: verificationEmailHtml(user, verifyUrl),
    required: true,
  });
}

function emailVerificationRequiredHtml() {
  return verifyPageHtml('Email non verificata', 'Controlla la tua casella email e clicca sul pulsante di verifica. Il link è valido per 30 minuti.', false, true);
}

function verifyPageHtml(title, message, ok, emailPending = false) {
  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — QubiqoHost</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;
    font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#f2f3f5;padding:20px;}
  .box{max-width:380px;text-align:center;border:1px solid #3a3c42;background:#2b2d31;border-radius:12px;padding:32px 26px;}
  .mark{width:38px;height:38px;border-radius:10px;margin:0 auto 18px;background:${ok ? '#39d98a' : '#ff6b6b'};
    display:flex;align-items:center;justify-content:center;font-weight:700;color:#101018;font-size:18px;}
  h1{font-size:17px;margin:0 0 8px;}
  p{color:#b5bac1;font-size:13.5px;line-height:1.6;margin:0 0 22px;}
  a{display:inline-block;background:#5865f2;color:#101018;text-decoration:none;font-weight:600;
    padding:10px 18px;border-radius:8px;font-size:13.5px;}
</style></head>
<body><div class="box">
  <div class="mark">${ok ? '\u2713' : '\u2715'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="/index.html">Vai al login</a>
</div></body></html>`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/manifest+json; charset=utf-8',
};

const COMPRESSIBLE_EXT = new Set(['.html', '.css', '.js', '.svg', '.json']);

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: 'Non trovato' });
    const ext = path.extname(filePath).toLowerCase();
    const isStaticAsset = ['.js','.css','.png','.jpg','.jpeg','.webp','.gif','.svg','.ico','.woff','.woff2','.ttf'].includes(ext);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isStaticAsset ? 'public, max-age=3600, stale-while-revalidate=86400' : 'no-cache',
      'Vary': 'Accept-Encoding',
    };
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (COMPRESSIBLE_EXT.has(ext) && data.length > 800 && /\bgzip\b/.test(acceptEncoding)) {
      zlib.gzip(data, { level: 6 }, (gzErr, compressed) => {
        if (gzErr) {
          res.writeHead(200, headers);
          return res.end(data);
        }
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
        res.end(compressed);
      });
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}


const PASSWORD_RESET_TTL_MS = 1000 * 60 * 30;
const passwordResetAttempts = new Map();

function passwordResetPageHtml() {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<meta name="theme-color" content="#f5f7f7">
<title>Password dimenticata — QubiqoHost</title>
<link rel="stylesheet" href="/css/style.css?v=20260914-password-reset">
<style>
.password-reset-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:radial-gradient(circle at 85% 5%,rgba(2,167,189,.08),transparent 28%),#f4f7f7}
.password-reset-card{width:min(100%,460px);padding:34px;border:1px solid rgba(120,140,150,.22);border-radius:22px;background:var(--card-bg,#fff);box-shadow:0 20px 60px rgba(0,0,0,.08)}
.password-reset-brand{text-align:center;font-size:24px;font-weight:800;margin-bottom:28px}.password-reset-brand span{color:#28a9e0}
.password-reset-card h1{margin:0 0 10px;font-size:28px}.password-reset-card p{margin:0 0 24px;line-height:1.55;color:var(--muted,#66727a)}
.password-reset-card label{display:block;font-weight:700;margin:0 0 8px}.password-reset-card input{width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #cbd4d9!important;border-radius:12px;background:#fff!important;color:#10212c!important;font:inherit;outline:none;color-scheme:light}
.password-reset-card input:focus{border-color:#28a9e0;box-shadow:0 0 0 3px rgba(40,169,224,.13)}
.password-reset-submit{width:100%;margin-top:18px}body.auth-page .password-reset-submit{background:#fff;border:1px solid #cbd4d9;color:#10212c;box-shadow:none}body.auth-page .password-reset-submit:hover{background:#f4f7f7}.password-reset-back{display:block;text-align:center;margin-top:18px;color:#28a9e0;text-decoration:none;font-weight:700}
.password-reset-message{display:none;margin-top:18px;padding:12px 14px;border-radius:12px;line-height:1.45}
.password-reset-message.ok{display:block;background:rgba(40,169,224,.1);color:#1682b2}.password-reset-message.err{display:block;background:rgba(220,60,70,.1);color:#b52d38}
.password-reset-hint{font-size:13px!important;margin-top:10px!important;margin-bottom:0!important}
</style>
</head>
<body class="auth-page">
<div class="password-reset-wrap">
<div class="password-reset-card">
<div class="password-reset-brand">Qubiqo<span>Host</span></div>
<h1>Password dimenticata?</h1>
<p>Inserisci l'indirizzo email associato al tuo account. Se l'account esiste, riceverai un'email con il pulsante per reimpostare la password.</p>
<form id="forgotForm">
<label for="forgotEmail">Email</label>
<input id="forgotEmail" type="email" autocomplete="email" placeholder="nome@esempio.it" required>
<button class="btn auth-submit password-reset-submit" type="submit">Invia email di reimpostazione</button>
</form>
<div id="forgotMessage" class="password-reset-message"></div>
<a class="password-reset-back" href="/">← Torna al login</a>
</div>
</div>
<script>
const form=document.getElementById('forgotForm'), msg=document.getElementById('forgotMessage');
form.addEventListener('submit',async e=>{
 e.preventDefault(); msg.className='password-reset-message'; msg.textContent='';
 const button=form.querySelector('button'); button.disabled=true;
 try{
   const r=await fetch('/api/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('forgotEmail').value})});
   const data=await r.json().catch(()=>({}));
   if(!r.ok) throw new Error(data.error||'Non è stato possibile completare la richiesta.');
   msg.className='password-reset-message ok';
   msg.textContent='Se l’indirizzo è associato a un account, abbiamo inviato un’email con le istruzioni per reimpostare la password.';
   form.reset();
 }catch(err){msg.className='password-reset-message err';msg.textContent=err.message}
 finally{button.disabled=false}
});
</script>
</body>
</html>`;
}

function resetPasswordPageHtml(token) {
  const safeToken = escapeHtml(token);
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<meta name="theme-color" content="#f5f7f7">
<title>Reimposta password — QubiqoHost</title>
<link rel="stylesheet" href="/css/style.css?v=20260914-password-reset">
<style>
.password-reset-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:radial-gradient(circle at 85% 5%,rgba(2,167,189,.08),transparent 28%),#f4f7f7}
.password-reset-card{width:min(100%,460px);padding:34px;border:1px solid rgba(120,140,150,.22);border-radius:22px;background:var(--card-bg,#fff);box-shadow:0 20px 60px rgba(0,0,0,.08)}
.password-reset-brand{text-align:center;font-size:24px;font-weight:800;margin-bottom:28px}.password-reset-brand span{color:#28a9e0}
.password-reset-card h1{margin:0 0 10px;font-size:28px}.password-reset-card p{margin:0 0 24px;line-height:1.55;color:var(--muted,#66727a)}
.password-reset-card label{display:block;font-weight:700;margin:0 0 8px}.password-reset-card input{width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #cbd4d9!important;border-radius:12px;background:#fff!important;color:#10212c!important;font:inherit;outline:none;margin-bottom:14px;color-scheme:light}
.password-reset-card input:focus{border-color:#28a9e0;box-shadow:0 0 0 3px rgba(40,169,224,.13)}
.password-reset-submit{width:100%;margin-top:4px}body.auth-page .password-reset-submit{background:#fff;border:1px solid #cbd4d9;color:#10212c;box-shadow:none}body.auth-page .password-reset-submit:hover{background:#f4f7f7}.password-reset-back{display:block;text-align:center;margin-top:18px;color:#28a9e0;text-decoration:none;font-weight:700}
.password-reset-message{display:none;margin-top:18px;padding:12px 14px;border-radius:12px;line-height:1.45}.password-reset-message.ok{display:block;background:rgba(40,169,224,.1);color:#1682b2}.password-reset-message.err{display:block;background:rgba(220,60,70,.1);color:#b52d38}
.password-reset-hint{font-size:13px!important;margin:0 0 18px!important}
</style>
</head>
<body class="auth-page">
<div class="password-reset-wrap">
<div class="password-reset-card">
<div class="password-reset-brand">Qubiqo<span>Host</span></div>
<h1>Reimposta la password</h1>
<p class="password-reset-hint">Imposta una nuova password e confermala per completare la procedura.</p>
<form id="resetForm">
<label for="newPassword">Nuova password</label>
<input id="newPassword" type="password" autocomplete="new-password" minlength="6" required>
<label for="confirmPassword">Conferma nuova password</label>
<input id="confirmPassword" type="password" autocomplete="new-password" minlength="6" required>
<button class="btn auth-submit password-reset-submit" type="submit">Conferma nuova password</button>
</form>
<div id="resetMessage" class="password-reset-message"></div>
<a id="resetBack" class="password-reset-back" href="/">← Torna al login</a>
</div>
</div>
<script>
const token=${JSON.stringify(token)}, form=document.getElementById('resetForm'), msg=document.getElementById('resetMessage');
form.addEventListener('submit',async e=>{
 e.preventDefault(); msg.className='password-reset-message'; msg.textContent='';
 const password=document.getElementById('newPassword').value, confirm=document.getElementById('confirmPassword').value;
 if(password.length<6){msg.className='password-reset-message err';msg.textContent='La password deve contenere almeno 6 caratteri.';return}
 if(password!==confirm){msg.className='password-reset-message err';msg.textContent='Le due password non coincidono.';return}
 const button=form.querySelector('button');button.disabled=true;
 try{
   const r=await fetch('/api/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password,confirmPassword:confirm})});
   const data=await r.json().catch(()=>({}));
   if(!r.ok) throw new Error(data.error||'Link non valido o scaduto.');
   form.style.display='none'; msg.className='password-reset-message ok'; msg.textContent='Password reimpostata con successo. Ora puoi effettuare il login.';
   document.getElementById('resetBack').textContent='Vai al login';
 }catch(err){msg.className='password-reset-message err';msg.textContent=err.message;button.disabled=false}
});
</script>
</body>
</html>`;
}

function passwordResetEmailHtml(user, resetUrl) {
  const username = escapeHtml(user.username);
  const url = escapeHtml(resetUrl);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reimposta la password — QubiqoHost</title></head>
<body style="margin:0;padding:0;background:#f3f6f6;color:#10212c;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6f6;width:100%;"><tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:620px;background:#fff;border:1px solid #dfe6e9;border-radius:18px;overflow:hidden;">
<tr><td style="padding:28px 32px;border-bottom:1px solid #e7edef;font-size:24px;font-weight:800;">Qubiqo<span style="color:#28a9e0;">Host</span></td></tr>
<tr><td style="padding:38px 32px 40px;"><h1 style="margin:0 0 16px;font-size:27px;color:#10212c;">Reimposta la tua password</h1>
<p style="font-size:15px;line-height:25px;color:#53636c;">Ciao ${username}, abbiamo ricevuto una richiesta per reimpostare la password del tuo account QubiqoHost.</p>
<p style="font-size:15px;line-height:25px;color:#53636c;">Usa il pulsante qui sotto per impostare una nuova password.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;"><tr><td style="border-radius:10px;background:#28a9e0;"><a href="${url}" style="display:inline-block;padding:14px 22px;color:#fff;text-decoration:none;font-weight:800;">Reimposta password</a></td></tr></table>
<p style="font-size:13px;line-height:21px;color:#7a8991;">Il link è valido per 30 minuti e può essere utilizzato una sola volta. Se non hai richiesto tu questa operazione, puoi ignorare questa email.</p>
</td></tr>
<tr><td align="center" style="padding:22px 24px 26px;background:#171c20;border-top:1px solid #293137;"><div style="font-size:14px;font-weight:800;color:#f2f8fa;">QubiqoHost</div><div style="margin-top:5px;font-size:12px;color:#91a0a8;">Managed by Variune Studios</div><div style="margin-top:9px;font-size:12px;color:#91a0a8;">info@qubiqohost.it · qubiqohost.it</div></td></tr>
</table></td></tr></table></body></html>`;
}

function createPasswordReset(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + PASSWORD_RESET_TTL_MS;
  withDb(db => {
    const current = db.users.find(u => u.id === user.id);
    if (!current) throw new Error('Utente non trovato');
    current.passwordResetTokenHash = tokenHash;
    current.passwordResetExpiresAt = expiresAt;
  });
  return { token, expiresAt };
}

function consumePasswordReset(token, password) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let result = null;
  withDb(db => {
    const user = db.users.find(u => u.passwordResetTokenHash === tokenHash);
    if (!user || !Number.isFinite(Number(user.passwordResetExpiresAt)) || Number(user.passwordResetExpiresAt) < Date.now()) return;
    const { salt, hash } = auth.hashPassword(password);
    user.salt = salt;
    user.hash = hash;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    user.authProvider = 'manual';
    result = { id: user.id, username: user.username };
  });

  if (result?.id) {
    try {
      auth.destroyUserSessions(result.id);
    } catch (error) {
      console.error('[password-reset] Impossibile revocare le sessioni:', error.message || error);
    }
  }

  return result;
}

function passwordResetRateLimited(req) {
  const key = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  const now = Date.now();
  const record = passwordResetAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (record.resetAt <= now) {
    record.count = 0;
    record.resetAt = now + 15 * 60 * 1000;
  }
  record.count += 1;
  passwordResetAttempts.set(key, record);
  return record.count > 5;
}

async function sendPasswordResetEmail(user) {
  const { token } = createPasswordReset(user);
  const resetUrl = `${PUBLIC_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;

  try {
    return await sendMail({
      to: user.email,
      subject: 'Reimposta la tua password — QubiqoHost',
      text: `Ciao ${user.username}, per reimpostare la password apri questo link: ${resetUrl}\n\nIl link è valido per 30 minuti e può essere utilizzato una sola volta.\n\nQubiqoHost — Managed by Variune Studios\ninfo@qubiqohost.it`,
      html: passwordResetEmailHtml(user, resetUrl),
      required: true,
    });
  } catch (error) {
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      withDb(db => {
        const current = db.users.find(u => u.id === user.id);
        if (current && current.passwordResetTokenHash === tokenHash) {
          current.passwordResetTokenHash = null;
          current.passwordResetExpiresAt = null;
        }
      });
    } catch (rollbackError) {
      console.error('[password-reset] Rollback token fallito:', rollbackError.message || rollbackError);
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method;
  res.__acceptEncoding = String(req.headers['accept-encoding'] || '');

  try {
    if (PANEL_MAINTENANCE) {
      const maintenancePath = p === '/manutenzione' || p === '/maintenance' || p === '/maintenance.html';
      if (maintenancePath && (method === 'GET' || method === 'HEAD')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return serveStatic(req, res, '/maintenance.html');
      }
      if (p.startsWith('/api/')) {
        return send(res, 503, { error: 'Pannello in manutenzione' });
      }
      res.writeHead(302, { Location: '/maintenance', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' });
      return res.end();
    }

    if ((isAuthPagePath(p) || isAuthEndpoint(p)) && !isAllowedAuthHost(req)) {
      const target = `${PUBLIC_BASE_URL}${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      return res.end();
    }


    if (p === '/forgot-password' && (method === 'GET' || method === 'HEAD')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      return res.end(method === 'HEAD' ? '' : passwordResetPageHtml());
    }

    if (p === '/reset-password' && method === 'GET') {
      const token = String(url.searchParams.get('token') || '').trim();
      if (!/^[a-f0-9]{64}$/i.test(token)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(verifyPageHtml('Link non valido', 'Il link per reimpostare la password non è valido.', false));
      }
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const db = readDb();
      const user = db.users.find(u => u.passwordResetTokenHash === tokenHash && Number(u.passwordResetExpiresAt) >= Date.now());
      if (!user) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(verifyPageHtml('Link scaduto', 'Il link per reimpostare la password è scaduto o è già stato utilizzato. Richiedi una nuova email.', false));
      }
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      return res.end(resetPasswordPageHtml(token));
    }

    // Compatibility route: some previously generated reset emails used
    // /api/reset-password?token=... . Opening that link in a browser is a GET,
    // so render the reset form instead of returning {"error":"Non trovato"}.
    if (p === '/api/reset-password' && (method === 'GET' || method === 'HEAD')) {
      const token = String(url.searchParams.get('token') || '').trim();
      if (!/^[a-f0-9]{64}$/i.test(token)) {
        res.writeHead(302, {
          Location: '/forgot-password',
          'Cache-Control': 'no-store',
        });
        return res.end();
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const db = readDb();
      const user = db.users.find(u =>
        u.passwordResetTokenHash === tokenHash &&
        Number.isFinite(Number(u.passwordResetExpiresAt)) &&
        Number(u.passwordResetExpiresAt) >= Date.now()
      );

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      if (!user) {
        return res.end(verifyPageHtml(
          'Link scaduto',
          'Il link per reimpostare la password è scaduto o è già stato utilizzato. Richiedi una nuova email.',
          false
        ));
      }

      return res.end(method === 'HEAD' ? '' : resetPasswordPageHtml(token));
    }

    if (p === '/api/forgot-password' && method === 'POST') {
      if (passwordResetRateLimited(req)) return send(res, 429, { error: 'Troppe richieste. Riprova più tardi.' });
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Inserisci un indirizzo email valido' });
      const db = readDb();
      const user = db.users.find(u => (u.email || '').toLowerCase() === email && u.role !== 'admin');
      if (user) {
        try {
          await sendPasswordResetEmail(user);
        } catch (error) {
          console.error('[password-reset] Invio fallito:', error.message || error, { to: user.email });
          return send(res, 502, {
            error: 'Impossibile inviare l’email di reimpostazione. Controlla la configurazione SMTP del pannello.'
          });
        }
      }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/reset-password' && method === 'POST') {
      const body = await readJsonBody(req);
      const token = String(body.token || '').trim();
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');
      if (!/^[a-f0-9]{64}$/i.test(token)) return send(res, 400, { error: 'Link non valido o scaduto' });
      if (password.length < 6) return send(res, 400, { error: 'La password deve contenere almeno 6 caratteri' });
      if (password !== confirmPassword) return send(res, 400, { error: 'Le due password non coincidono' });
      const result = consumePasswordReset(token, password);
      if (!result) return send(res, 400, { error: 'Link non valido, scaduto o già utilizzato' });
      return send(res, 200, { ok: true });
    }

    if (p === '/auth/discord' && method === 'GET') {
      if (!discordConfigured()) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Discord non configurato', 'Configura DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET e DISCORD_REDIRECT_URI nel file .env.', false));
      }
      const state = crypto.randomBytes(32).toString('hex');
      res.writeHead(302, {
        Location: discordAuthorizeUrl(state),
        'Set-Cookie': cookieValue('discord_oauth_state', state, 600),
      });
      return res.end();
    }

    if (p === '/auth/discord/callback' && method === 'GET') {
      if (!discordConfigured()) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Discord non configurato', 'Il login Discord non è ancora configurato.', false));
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const cookies = auth.parseCookies(req);

      if (error) {
        res.writeHead(302, {
          Location: '/index.html?discord=cancelled',
          'Set-Cookie': clearCookie('discord_oauth_state'),
        });
        return res.end();
      }

      if (!code || !state || !cookies.discord_oauth_state || state !== cookies.discord_oauth_state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Accesso non valido', 'La sessione di autorizzazione Discord non è valida o è scaduta. Riprova.', false));
      }

      try {
        const accessToken = await exchangeDiscordCode(code);
        const discordUser = await fetchDiscordUser(accessToken);
        const discordEmail = typeof discordUser.email === 'string' ? discordUser.email.trim().toLowerCase() : '';

        if (!discordEmail) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Email Discord non disponibile', 'Discord non ha restituito un indirizzo email. Autorizza la richiesta email e riprova.', false));
        }

        let user = null;
        let created = false;

        withDb(db => {
          user = db.users.find(u => u.discordId === discordUser.id) || db.users.find(u => (u.email || '').toLowerCase() === discordEmail);

          if (!user) {
            const { salt, hash } = auth.hashPassword(crypto.randomBytes(32).toString('hex'));
            user = {
              id: crypto.randomUUID(),
              username: uniqueUsername(db, discordUser.global_name || discordUser.username),
              email: discordEmail,
              salt,
              hash,
              discordId: discordUser.id,
              discordUsername: discordUser.username || null,
              discordAvatar: discordUser.avatar || null,
              role: 'user',
              suspended: false,
              emailVerified: true,
              slots: DEFAULT_SLOTS,
              credits: 0,
              pin: generatePin(db),
              createdAt: Date.now(),
              authProvider: 'discord',
              ipHashes: [],
              lastIpHash: null,
              lastIpAt: null,
            };
            recordUserIp(user, req);
            recordUserDevice(user, req);
            db.users.push(user);
            assignUserToDefaultNode(db, user.id);
            created = true;
          } else {
            if (user.suspended) return;
            user.discordId = discordUser.id;
            user.discordUsername = discordUser.username || null;
            user.discordAvatar = discordUser.avatar || null;
            user.emailVerified = true;
            user.authProvider ||= authProvider(user);
            recordUserIp(user, req);
            recordUserDevice(user, req);
          }
        });

        if (created) {
          try { ensureUserStorageRoot(user, getDefaultNode(readDb())); } catch (_) {}
          auditCreatedAccount(req, user, 'Discord');
        }
        if (!user) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Account sospeso', 'Il tuo account QubiqoHost è sospeso.', false));
        }

        if (user.suspended) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Account sospeso', 'Il tuo account QubiqoHost è sospeso.', false));
        }
        if (user.role === 'admin') {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Accesso Admin separato', 'Gli amministratori devono usare la pagina di accesso Admin.', false));
        }

        const sessionToken = auth.createSession(user.id);
        const destination = user.role === 'admin' ? '/admin.html' : '/dashboard.html';
        res.writeHead(302, {
          Location: destination,
          'Set-Cookie': [
            `session=${encodeURIComponent(sessionToken)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000; Secure`,
            clearCookie('discord_oauth_state'),
          ],
        });
        return res.end();
      } catch (oauthError) {
        console.error('Discord OAuth error:', oauthError);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Errore Discord', "Non è stato possibile completare l'accesso con Discord. Riprova.", false));
      }
    }

    if (p === '/auth/google' && method === 'GET') {
      if (!googleConfigured()) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Google non configurato', 'Configura GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI nel file .env.', false));
      }

      const state = crypto.randomBytes(32).toString('hex');
      res.writeHead(302, {
        Location: googleAuthorizeUrl(state),
        'Set-Cookie': cookieValue('google_oauth_state', state, 600),
      });
      return res.end();
    }

    if (p === '/auth/google/callback' && method === 'GET') {
      if (!googleConfigured()) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Google non configurato', 'Il login Google non è ancora configurato.', false));
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const cookies = auth.parseCookies(req);

      if (error) {
        res.writeHead(302, {
          Location: '/index.html?google=cancelled',
          'Set-Cookie': clearCookie('google_oauth_state'),
        });
        return res.end();
      }

      if (!code || !state || !cookies.google_oauth_state || state !== cookies.google_oauth_state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Accesso non valido', 'La sessione di autorizzazione Google non è valida o è scaduta. Riprova.', false));
      }

      try {
        const accessToken = await exchangeGoogleCode(code);
        const googleUser = await fetchGoogleUser(accessToken);
        const googleEmail = typeof googleUser.email === 'string' ? googleUser.email.trim().toLowerCase() : '';

        if (!googleEmail) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Email Google non disponibile', 'Google non ha restituito un indirizzo email. Controlla i permessi richiesti e riprova.', false));
        }

        let user = null;
        let created = false;

        withDb(db => {
          const byGoogle = db.users.find(u => u.googleId === googleUser.sub);
          const byEmail = db.users.find(u => (u.email || '').toLowerCase() === googleEmail);

          if (byGoogle && byEmail && byGoogle.id !== byEmail.id) {
            throw new Error('L account Google e l email appartengono a due account QubiqoHost diversi.');
          }

          user = byGoogle || byEmail;

          if (created) {
          try { ensureUserStorageRoot(user, getDefaultNode(readDb())); } catch (_) {}
          auditCreatedAccount(req, user, 'Google');
        }
        if (!user) {
            const { salt, hash } = auth.hashPassword(crypto.randomBytes(32).toString('hex'));
            user = {
              id: crypto.randomUUID(),
              username: uniqueUsername(db, googleUser.name || googleUser.email.split('@')[0] || 'googleuser'),
              email: googleEmail,
              salt,
              hash,
              googleId: googleUser.sub,
              googleName: googleUser.name || null,
              googleAvatar: googleUser.picture || null,
              role: 'user',
              suspended: false,
              emailVerified: googleUser.email_verified !== false,
              slots: DEFAULT_SLOTS,
              credits: 0,
              pin: generatePin(db),
              createdAt: Date.now(),
              authProvider: 'google',
              ipHashes: [],
              lastIpHash: null,
              lastIpAt: null,
            };
            recordUserIp(user, req);
            recordUserDevice(user, req);
            db.users.push(user);
            assignUserToDefaultNode(db, user.id);
            created = true;
          } else {
            if (user.suspended) return;
            user.googleId = googleUser.sub;
            user.googleName = googleUser.name || null;
            user.googleAvatar = googleUser.picture || null;
            user.emailVerified = googleUser.email_verified !== false;
            user.authProvider ||= authProvider(user);
            recordUserIp(user, req);
            recordUserDevice(user, req);
          }
        });

        if (!user) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Account sospeso', 'Il tuo account QubiqoHost è sospeso.', false));
        }

        if (user.suspended) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Account sospeso', 'Il tuo account QubiqoHost è sospeso.', false));
        }
        if (user.role === 'admin') {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(verifyPageHtml('Accesso Admin separato', 'Gli amministratori devono usare la pagina di accesso Admin.', false));
        }

        const sessionToken = auth.createSession(user.id);
        const destination = '/dashboard.html';
        res.writeHead(302, {
          Location: destination,
          'Set-Cookie': [
            `session=${encodeURIComponent(sessionToken)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000; Secure`,
            clearCookie('google_oauth_state'),
          ],
        });
        return res.end();
      } catch (oauthError) {
        console.error('Google OAuth error:', oauthError);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Errore Google', "Non è stato possibile completare l'accesso con Google. Riprova.", false));
      }
    }

    if (p === '/admin.html' || p === '/admin') {
      const currentUser = getCurrentUser(req);
      if (!currentUser || currentUser.role !== 'admin') {
        const destination = currentUser ? '/dashboard.html' : '/index.html';
        res.writeHead(302, {
          Location: destination,
          'Cache-Control': 'no-store, no-cache, must-revalidate, private',
          Pragma: 'no-cache',
        });
        return res.end();
      }

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      return serveStatic(req, res, '/admin.html');
    }

    if (p === '/dashboard-tester.html') {
      const currentUser = getCurrentUser(req);
      if (!currentUser || !['tester', 'admin'].includes(currentUser.role)) {
        res.writeHead(302, {
          Location: currentUser ? '/dashboard.html' : '/index.html',
          'Cache-Control': 'no-store, no-cache, must-revalidate, private',
          Pragma: 'no-cache',
        });
        return res.end();
      }
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      return serveStatic(req, res, '/dashboard-tester.html');
    }

    if (p === '/dashboard.html') {
      const currentUser = getCurrentUser(req);
      if (currentUser?.role === 'tester') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        return serveStatic(req, res, '/dashboard-tester.html');
      }
    }

    if (p === '/verify-email' && method === 'GET') {
      const token = String(url.searchParams.get('token') || '').trim();
      if (!/^[a-f0-9]{64}$/i.test(token)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(verifyPageHtml('Link non valido', 'Il link di verifica non è valido. Richiedi una nuova email di verifica dal pannello.', false));
      }
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      let verifiedUser = null;
      let error = null;
      withDb(db => {
        const found = db.users.find(u => u.emailVerificationTokenHash === tokenHash);
        if (!found) { error = 'Link di verifica non valido o già utilizzato.'; return; }
        if (Number(found.emailVerificationExpiresAt || 0) < Date.now()) { error = 'Il link di verifica è scaduto. Effettua una nuova richiesta di verifica.'; return; }
        found.emailVerified = true;
        delete found.emailVerificationTokenHash;
        delete found.emailVerificationExpiresAt;
        verifiedUser = found;
      });
      res.writeHead(error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(verifyPageHtml(error ? 'Verifica non completata' : 'Email verificata', error || `Perfetto, l'indirizzo email di ${verifiedUser.username} è stato verificato. Ora puoi accedere al pannello.`, !error));
    }

    if (!p.startsWith('/api/')) {
      return serveStatic(req, res, p);
    }

    if (p.startsWith('/api/discord/tickets/') && method === 'POST') {
      if (!DISCORD_INTERNAL_SECRET || req.headers['x-qubiqohost-secret'] !== DISCORD_INTERNAL_SECRET) return send(res, 403, { error: 'Non autorizzato' });
      const match = p.match(/^\/api\/discord\/tickets\/([^/]+)$/);
      const body = await readJsonBody(req);
      const ticketId = match ? match[1] : '';
      const content = String(body.message || '').trim();
      const author = String(body.author || 'Discord Staff').trim().slice(0, 80);
      if (!content) return send(res, 400, { error: 'Messaggio vuoto' });
      let ticket;
      withDb(db => { ticket=db.tickets.find(x=>x.id===ticketId); if(ticket){ticket.messages.push({id:crypto.randomUUID(),author,role:'staff',content,createdAt:Date.now()});ticket.updatedAt=Date.now();} });
      if (!ticket) return send(res, 404, { error: 'Ticket non trovato' });
      return send(res, 200, { ok: true, ticket });
    }

    if (p === '/api/register' && method === 'POST') {
      const body = await readJsonBody(req);
      const username = (body.username || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (username.length < 3 || password.length < 6 || !emailOk) {
        return send(res, 400, { error: 'Controlla username (min 3), email e password (min 6 caratteri)' });
      }
      let result;
      withDb(db => {
        if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
          result = { error: 'Username già in uso' };
          return;
        }
        if (db.users.find(u => u.email === email)) {
          result = { error: 'Email già registrata' };
          return;
        }
        const { salt, hash } = auth.hashPassword(password);
        const user = {
          id: crypto.randomUUID(), username, email, salt, hash,
          role: 'user', suspended: false, emailVerified: false, createdAt: Date.now(),
          slots: DEFAULT_SLOTS,
          credits: 0,
          pin: generatePin(db),
          authProvider: 'manual',
          ipHashes: [],
          lastIpHash: null,
          lastIpAt: null,
        };
        recordUserIp(user, req);
        recordUserDevice(user, req);
        db.users.push(user);
        assignUserToDefaultNode(db, user.id);
        result = { user };
      });
      if (result.error) return send(res, 400, { error: result.error });
      try { ensureUserStorageRoot(result.user, getDefaultNode(readDb())); } catch (_) {}
      let emailSent = false;
      let emailError = null;
      try {
        await sendVerificationEmail(result.user);
        emailSent = true;
      } catch (error) {
        emailError = error.message || String(error);
        console.error('[email-verification] Invio fallito:', emailError, { to: result.user.email, smtpHost: process.env.SMTP_HOST || 'authsmtp.securemail.pro', smtpPort: Number(process.env.SMTP_PORT || 465), smtpUser: process.env.SMTP_USER ? '[configured]' : '[missing]', smtpPass: process.env.SMTP_PASS ? '[configured]' : '[missing]' });
      }
      auditCreatedAccount(req, result.user, 'email');
      return send(res, 200, {
        ok: true,
        emailVerificationRequired: true,
        emailSent,
        message: emailSent
          ? 'Account creato! Ti è arrivata un email per verificare il tuo account.'
          : 'Account creato! Non siamo riusciti a inviare l’email di verifica. Puoi richiederne un nuovo invio dalla schermata di accesso.',
        emailError: emailSent ? undefined : emailError,
        user: safeUser(result.user)
      });
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readJsonBody(req);
      const db = readDb();
      const user = db.users.find(u => u.username.toLowerCase() === (body.username || '').toLowerCase());
      if (!user || user.role === 'admin' || !auth.verifyPassword(body.password || '', user.salt, user.hash)) {
        return send(res, 401, { error: 'Credenziali non valide' });
      }
      if (user.suspended) return send(res, 403, { error: 'Account sospeso' });
      if (user.emailVerified === false && user.authProvider === 'manual') {
        try {
          await sendVerificationEmail(user);
        } catch (error) {
          console.error('[email-verification] Reinvio al login fallito:', error.message || error);
        }
        return send(res, 403, { error: 'Email non verificata! Ti abbiamo inviato una nuova email per verificare il tuo account.', emailVerificationRequired: true });
      }
      withDb(db2 => {
        const fresh = db2.users.find(x => x.id === user.id);
        if (fresh) {
          fresh.authProvider ||= authProvider(fresh);
          recordUserIp(fresh, req);
          recordUserDevice(fresh, req);
        }
      });
      const token = auth.createSession(user.id);
      return send(res, 200, { user: safeUser(user) }, {
        'Set-Cookie': sessionCookie(token, req),
      });
    }

    if (p === '/api/resend-verification' && method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Inserisci un indirizzo email valido' });
      const db = readDb();
      const user = db.users.find(u => (u.email || '').toLowerCase() === email && u.role !== 'admin');
      if (!user) return send(res, 404, { error: 'Nessun account trovato con questa email' });
      if (user.emailVerified !== false) return send(res, 400, { error: 'Questa email è già verificata' });
      try {
        await sendVerificationEmail(user);
      } catch (error) {
        console.error('[email-verification] Reinvia fallito:', error.message || error);
        return send(res, 503, { error: 'Non è stato possibile inviare l\'email di verifica. Riprova più tardi.' });
      }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/admin/login' && method === 'POST') {
      const now = Date.now();
      const key = String(req.socket.remoteAddress || 'unknown');
      const record = adminLoginAttempts.get(key) || { count: 0, firstAt: now, blockedUntil: 0 };
      if (record.blockedUntil > now) return send(res, 429, { error: 'Troppi tentativi di accesso. Riprova tra qualche minuto.' });
      if (now - record.firstAt > 15 * 60 * 1000) { record.count = 0; record.firstAt = now; record.blockedUntil = 0; }
      const body = await readJsonBody(req);
      const db = readDb();
      const username = String(body.username || '').trim().toLowerCase();
      const user = db.users.find(u => String(u.username || '').toLowerCase() === username);
      if (!user || user.role !== 'admin' || !auth.verifyPassword(body.password || '', user.salt, user.hash)) {
        record.count += 1;
        if (record.count >= 5) record.blockedUntil = now + 15 * 60 * 1000;
        adminLoginAttempts.set(key, record);
        return send(res, record.blockedUntil > now ? 429 : 401, { error: record.blockedUntil > now ? 'Troppi tentativi di accesso. Riprova tra qualche minuto.' : 'Credenziali amministratore non valide' });
      }
      adminLoginAttempts.delete(key);
      if (user.suspended) return send(res, 403, { error: 'Account amministratore sospeso' });
      auditEvent(req, user, 'admin', 'Accesso Admin', 'Login amministratore');
      withDb(db2 => {
        const fresh = db2.users.find(x => x.id === user.id);
        if (fresh) {
          fresh.authProvider ||= authProvider(fresh);
          recordUserIp(fresh, req);
          recordUserDevice(fresh, req);
        }
      });
      const token = auth.createSession(user.id);
      return send(res, 200, { user: safeUser(user) }, {
        'Set-Cookie': sessionCookie(token, req),
      });
    }

    if (p === '/api/logout' && method === 'POST') {
      const cookies = auth.parseCookies(req);
      auth.destroySession(cookies.session);
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
    }

    const user = getCurrentUser(req);
    if (p === '/api/me') {
      if (!user) return send(res, 401, { error: 'Non autenticato' });
      return send(res, 200, { user: safeUser(user) });
    }
    if (!user) return send(res, 401, { error: 'Non autenticato' });
    auditUserMovementRequest(req, user, p, method);

    if (p === '/api/audit/movement' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const action = String(body.action || '').trim().slice(0, 160);
        if (action) auditEvent(req, user, user.role === 'admin' ? 'admin' : 'movement', action);
      } catch (_) {}
      return send(res, 200, { ok: true });
    }

    if (p === '/api/billing' && method === 'GET') {
      const db = readDb();
      const billing = getBillingConfig(db);
      return send(res, 200, {
        credits: Number.isFinite(user.credits) ? user.credits : 0,
        slotCost: billing.settings.slotCreditCost,
        packages: getCreditPackages(db).map(({ id, credits, amountCents, label }) => ({
          id, credits, amountCents, label, currency: 'EUR',
        })),
        paypalConfigured: billingConfigured(),
        paypalMode: PAYPAL_MODE,
      });
    }

    if (p === '/api/billing/transactions' && method === 'GET') {
      const db = readDb();
      const transactions = db.billing.transactions
        .filter(t => t.userId === user.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50)
        .map(t => ({
          id: t.id,
          type: t.type,
          status: t.status,
          credits: t.credits || 0,
          amountCents: t.amountCents || 0,
          description: t.description,
          createdAt: t.createdAt,
        }));
      return send(res, 200, { transactions });
    }

    if (p === '/api/billing/checkout' && method === 'POST') {
      if (!billingConfigured()) return send(res, 503, { error: 'Billing non ancora configurato' });
      const body = await readJsonBody(req);
      const pkg = getCreditPackages(readDb()).find(x => x.id === String(body.packageId || ''));
      if (!pkg) return send(res, 400, { error: 'Pacchetto crediti non valido' });

      const value = (pkg.amountCents / 100).toFixed(2);
      const orderId = crypto.randomUUID();
      try {
        const order = await paypalRequest('/v2/checkout/orders', {
          method: 'POST',
          headers: { 'PayPal-Request-Id': orderId },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
              reference_id: orderId,
              custom_id: user.id,
              description: `QubiqoHost — ${pkg.label}`.slice(0, 127),
              amount: { currency_code: 'EUR', value },
            }],
            application_context: {
              brand_name: 'QubiqoHost',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: `${PUBLIC_BASE_URL}/billing.html?payment=success`,
              cancel_url: `${PUBLIC_BASE_URL}/billing.html?payment=cancelled`,
            },
          }),
        });
        const approval = order.links?.find(link => link.rel === 'approve')?.href;
        if (!approval || !order.id) throw new Error('PayPal non ha restituito il link di pagamento');

        withDb(db => {
          db.billing.transactions.push({
            id: crypto.randomUUID(),
            userId: user.id,
            type: 'credit_purchase',
            status: 'pending',
            credits: pkg.credits,
            amountCents: pkg.amountCents,
            provider: 'paypal',
            providerId: order.id,
            description: `Acquisto ${pkg.credits} crediti`,
            createdAt: Date.now(),
          });
        });
        return send(res, 200, { ok: true, url: approval, orderId: order.id });
      } catch (e) {
        console.error('PayPal checkout error:', e);
        return send(res, 502, { error: e.message });
      }
    }

    if (p === '/api/billing/confirm' && method === 'POST') {
      if (!billingConfigured()) return send(res, 503, { error: 'Billing non ancora configurato' });
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || '').trim();
      if (!orderId || !/^[A-Z0-9-]+$/i.test(orderId)) return send(res, 400, { error: 'Ordine PayPal non valido' });
      try {
        const db = readDb();
        const pending = db.billing.transactions.find(t => t.providerId === orderId && t.userId === user.id && t.status === 'pending');
        if (!pending) {
          const already = db.billing.transactions.find(t => t.providerId === orderId && t.userId === user.id && t.status === 'completed');
          if (already) {
            const fresh = readDb().users.find(u => u.id === user.id);
            return send(res, 200, { ok: true, paid: true, duplicate: true, credited: already.credits || 0, credits: fresh?.credits || 0 });
          }
          return send(res, 404, { error: 'Ordine non associato al tuo account' });
        }

        const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
        if (order.status === 'APPROVED') {
          const captured = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
            method: 'POST',
            headers: { 'PayPal-Request-Id': orderId },
            body: JSON.stringify({}),
          });
          if (captured.status !== 'COMPLETED') {
            return send(res, 200, { ok: false, paid: false, credits: user.credits || 0, status: captured.status });
          }
        } else if (order.status !== 'COMPLETED') {
          return send(res, 200, { ok: false, paid: false, credits: user.credits || 0, status: order.status });
        }

        const result = finalizeCreditPurchase(orderId, user.id, 'paypal_capture');
        const fresh = readDb().users.find(u => u.id === user.id);
        return send(res, 200, { ok: true, paid: true, credited: result.credits || 0, credits: fresh?.credits || 0 });
      } catch (e) {
        console.error('PayPal capture error:', e);
        return send(res, 502, { error: e.message });
      }
    }

    if (p === '/api/billing/buy-slot' && method === 'POST') {
      const body = await readJsonBody(req);
      const quantity = Math.min(20, Math.max(1, Math.floor(Number(body.quantity || 1))));
      const billing = getBillingConfig(readDb());
      const total = billing.settings.slotCreditCost * quantity;
      let result = null;
      withDb(db => {
        const u = db.users.find(x => x.id === user.id);
        const credits = Number.isFinite(u.credits) ? u.credits : 0;
        if (credits < total) {
          result = { error: `Crediti insufficienti. Servono ${total} crediti.` };
          return;
        }
        u.credits = credits - total;
        u.slots = (Number.isFinite(u.slots) ? u.slots : DEFAULT_SLOTS) + quantity;
        db.billing.transactions.push({
          id: crypto.randomUUID(),
          userId: user.id,
          type: 'slot_purchase',
          status: 'completed',
          credits: -total,
          amountCents: 0,
          description: `Acquisto ${quantity} slot`,
          createdAt: Date.now(),
          completedAt: Date.now(),
        });
        result = { ok: true, credits: u.credits, slots: u.slots };
      });
      if (result?.error) return send(res, 400, result);
      auditEvent(req, user, 'action', 'Acquisto slot', `${quantity} slot acquistati`);
      return send(res, 200, result);
    }

    if (p === '/api/billing/redeem' && method === 'POST') {
      const body = await readJsonBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) return send(res, 400, { error: 'Inserisci un codice coupon' });

      let result = null;
      withDb(db => {
        const billing = getBillingConfig(db);
        const coupon = billing.coupons.find(c => c.code === code);
        if (!coupon) {
          result = { error: 'Codice coupon non valido' };
          return;
        }
        if (!coupon.enabled) {
          result = { error: 'Questo coupon non è più attivo' };
          return;
        }
        if (Number.isFinite(coupon.maxUses) && coupon.usedCount >= coupon.maxUses) {
          result = { error: 'Questo coupon ha raggiunto il limite di utilizzi' };
          return;
        }
        coupon.usedBy ||= [];
        if (coupon.usedBy.includes(user.id)) {
          result = { error: 'Hai già riscattato questo coupon' };
          return;
        }

        const u = db.users.find(x => x.id === user.id);
        let description;
        if (coupon.type === 'slots') {
          u.slots = (Number.isFinite(u.slots) ? u.slots : DEFAULT_SLOTS) + coupon.amount;
          description = `Coupon ${coupon.code}: +${coupon.amount} slot`;
        } else {
          u.credits = (Number.isFinite(u.credits) ? u.credits : 0) + coupon.amount;
          description = `Coupon ${coupon.code}: +${coupon.amount} crediti`;
        }

        coupon.usedCount = (coupon.usedCount || 0) + 1;
        coupon.usedBy.push(user.id);

        db.billing.transactions.push({
          id: crypto.randomUUID(),
          userId: user.id,
          type: 'coupon_redeem',
          status: 'completed',
          credits: coupon.type === 'credits' ? coupon.amount : 0,
          amountCents: 0,
          description,
          createdAt: Date.now(),
          completedAt: Date.now(),
        });

        result = { ok: true, type: coupon.type, amount: coupon.amount, credits: u.credits, slots: u.slots };
      });
      if (result?.error) return send(res, 400, result);
      return send(res, 200, result);
    }

    if (p === '/api/servers' && method === 'GET') {
      refreshAllRuntimeStats();
      const db = readDb();
      const visible = db.servers.filter(s => canAccessServer(user,s,db));
      const servers = visible.map(s => ({...safeServer(s,db), collaboratorPermissions: collaboratorPermissionsForServer(user,s,db)}));
      const ownedCount=db.servers.filter(s=>s.ownerId===user.id).length;
      const slots=Number.isFinite(user.slots)?Math.max(0,user.slots):DEFAULT_SLOTS;
      return send(res,200,{servers,slots,emptySlots:Math.max(0,slots-ownedCount),collaborator:visible.some(s=>s.ownerId!==user.id)});
    }

    if (p === '/api/servers' && method === 'POST') {
      const body = await readJsonBody(req);
      const name = (body.name || '').trim();
      const language = body.language;
      const botToken = (body.botToken || '').trim();
      if (!name || !['nodejs', 'python'].includes(language) || !botToken) {
        return send(res, 400, { error: 'Dati mancanti o non validi' });
      }
      let db = readDb();
      const mineCount = db.servers.filter(s => s.ownerId === user.id).length;
      const mySlots = Number.isFinite(user.slots) ? user.slots : DEFAULT_SLOTS;
      if (mineCount >= mySlots) {
        return send(res, 400, { error: mySlots === 0 ? 'Non hai slot disponibili, contatta un amministratore' : `Hai raggiunto il limite di ${mySlots} slot` });
      }
      const ownerNode = getDefaultNode(db);
      if (!ownerNode) {
        return send(res, 503, { error: 'Nessun nodo VPS predefinito è collegato al pannello. Configura e imposta un nodo predefinito prima di creare server.' });
      }
      const newServer = {
        id: crypto.randomUUID(),
        ownerId: user.id,
        nodeId: ownerNode.id,
        name, language,
        ramMB: RAM_PRESET_MB,
        cpuCores: CPU_PRESET_CORES,
        status: 'stopped',
        suspended: false,
        createdAt: Date.now(),
      };
      const targetFolder = serverStorageFolder(newServer, db);
      newServer.folder = targetFolder;
      const ops = fileOps(ownerNode);
      try {
        ops.mkdir(targetFolder);
        const envContent = `${language === "nodejs" ? "DISCORD_TOKEN" : "BOT_TOKEN"}=${JSON.stringify(botToken)}\n`;
        const envTarget = path.posix.join(targetFolder, '.env');
        ops.writeFile(envTarget, envContent);
        rfs.sshRun(ownerNode, `chmod 600 ${rfs.q(envTarget)}`, { timeout: 8000 });
        const tpl = language === 'nodejs' ? templates.nodeTemplate() : templates.pythonTemplate();
        for (const [fname, content] of Object.entries(tpl)) ops.writeFile(path.posix.join(targetFolder, fname), content);
        withDb(db2 => { db2.servers.push(newServer); });
      } catch (e) {
        try { rfs.remove(ownerNode, targetFolder); } catch (_) {}
        return send(res, 502, { error: 'Impossibile creare il server sul nodo predefinito: ' + (e.message || e) });
      }
      return send(res, 200, { server: safeServer(newServer, db) });
    }

    const commandMatch = p.match(/^\/api\/servers\/([^/]+)\/command$/);
    if (commandMatch && method === 'POST') {
      const db = readDb();
      const srv = db.servers.find(s => s.id === commandMatch[1]);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, 'console.read')) return send(res, 403, { error: 'Non autorizzato' });
      const body = await readJsonBody(req);
      const node = getServerNode(srv, db);
      if (!node) return send(res, 400, { ok:false, error:'Nessun nodo VPS assegnato a questo server' });
      const command = String(body.command || '').trim();
      if (!command) return send(res, 400, { ok:false, error:'Comando vuoto' });
      const jobId = startPmActionWorker('command', { ...srv, folder: serverFolder(srv) }, { ...node }, { command });
      if (!jobId) return send(res, 503, { ok:false, error:'Impossibile avviare il controllo remoto' });
      return send(res, 200, { ok:true, pending:true, jobId });
    }

    const serverActionMatch = p.match(/^\/api\/servers\/([^/]+)\/(start|stop|restart|logs|stats)$/);
    if (serverActionMatch) {
      const [, serverId, action] = serverActionMatch;
      const db = readDb();
      const srv = db.servers.find(s => s.id === serverId);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, (action === 'logs' || action === 'stats') ? 'console.read' : `server.${action}`)) return send(res, 403, { error: 'Non autorizzato' });
      if (srv.suspended) return send(res, 403, { error: 'Server sospeso da un amministratore' });

      const node = getServerNode(srv, db);
      const srvWithFolder = { ...srv, folder: serverFolder(srv) };

      if (action === 'logs') {
        const key = serverStatusKey(srv);
        const actionStatus = runtimeStatusCache.get(key);

        // Durante AVVIO/RIAVVIO non mostrare i log della sessione precedente.
        if (
          actionStatus?.pending &&
          (actionStatus.action === 'start' || actionStatus.action === 'restart')
        ) {
          return send(res, 200, { logs: [] });
        }

        if (actionStatus && actionStatus.running === false && !actionStatus.pending) {
          return send(res, 200, { logs: [] });
        }

        if (!node) return send(res, 200, { logs: [] });

        const logs = pm.getLogs(srvWithFolder, node);
        return send(res, 200, { logs: Array.isArray(logs) ? logs : [] });
      }
      if (action === 'stats') {
        const key = serverStatusKey(srv);
        const cached = runtimeStatsCache.get(String(srv.id)) || {};
        const actionStatus = runtimeStatusCache.get(key);
        const actionStatusFresh = actionStatus && Date.now() - Number(actionStatus.updatedAt || 0) < 30000;
        return send(res, 200, { stats: {
          running: actionStatusFresh ? !!actionStatus.running : (cached.updatedAt ? !!cached.running : srv.status === 'running'),
          cpuPercent: Number(cached.cpuPercent) || 0,
          ramMB: Number(cached.ramMB) || 0,
          diskMB: Number(cached.diskMB) || 0,
          uptimeSeconds: Number(cached.uptimeSeconds) || 0,
          startedAt: cached.startedAt || null,
          updatedAt: Number(cached.updatedAt) || 0,
        }});
      }

      if (action === 'start' || action === 'stop' || action === 'restart') {
        if ((action === 'start' || action === 'restart') && srv.migrationStatus === 'pending') return send(res, 409, { error: 'Server in migrazione sul nuovo nodo. Riprova tra poco.' });
        if (!node) return send(res, 400, { error: 'Nessun nodo VPS assegnato a questo server' });
        const key = serverStatusKey(srv);
        const existingAction = runtimeStatusCache.get(key);

        if (action === 'start' && existingAction?.pending) {
          return send(res, 200, {
            ok: true,
            pending: true,
            jobId: existingAction.jobId || null,
            message: 'Avvio già in corso'
          });
        }

        if (action === 'start' && getCachedRunning(srv)) {
          return send(res, 200, {
            ok: true,
            pending: false,
            message: 'Bot già online'
          });
        }

        const previous = getCachedRunning(srv);
        if (action === 'start' || action === 'restart') runtimeStatusCache.set(key, { running: true, updatedAt: Date.now(), pending: true, action });
        if (action === 'stop') {
          runtimeStatusCache.set(key, { running: false, updatedAt: Date.now(), pending: true, action });
          withDb(db2 => {
            const current = db2.servers.find(x => x.id === serverId);
            if (current) current.status = 'stopped';
          });
        }
        const actionLabel = action === 'start' ? 'Avvio bot' : action === 'stop' ? 'Arresto bot' : 'Riavvio bot';
        auditEvent(req, user, user.role === 'admin' ? 'admin' : 'action', actionLabel, `Bot "${srv.name}"`);
        const jobId = startPmActionWorker(action, { ...srv, folder: serverFolder(srv) }, { ...node }, { previousRunning: previous });
        if (jobId && (action === 'start' || action === 'restart')) {
          runtimeStatusCache.set(key, { running: true, updatedAt: Date.now(), pending: true, action, jobId });
        }
        if (!jobId) {
          runtimeStatusCache.set(key, { running: previous, updatedAt: Date.now() });
          return send(res, 503, { ok: false, error: 'Impossibile avviare il processo di controllo remoto' });
        }
        return send(res, 200, { ok: true, pending: true, jobId, message: action === 'start' ? 'Avvio richiesto al nodo remoto' : action === 'stop' ? 'Arresto richiesto al nodo remoto' : 'Riavvio richiesto al nodo remoto' });
      }
    }


    const serverDeleteMatch = p.match(/^\/api\/servers\/([^/]+)\/delete$/);
    if (serverDeleteMatch && method === 'POST') {
      const id = serverDeleteMatch[1];
      const db = readDb();
      const srv = db.servers.find(s => s.id === id);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, 'server.delete') || (srv.ownerId !== user.id && user.role !== 'admin')) return send(res, 403, { error: 'Non autorizzato' });
      const node = getServerNode(srv, db);
      const srvWithFolder = { ...srv, folder: serverFolder(srv) };
      withDb(db2 => { db2.servers = db2.servers.filter(s => s.id !== id); });
      const jobId = startPmActionWorker('delete', srvWithFolder, node);
      return send(res, 202, { ok: true, pending: true, jobId });
    }


    if (p === '/api/panel/overview' && method === 'GET') {
      const db = readDb();
      const mine = db.servers.filter(s => canAccessServer(user,s,db));
      const ram = mine.reduce((a, s) => a + Number(s.ramMB || 0), 0);
      const running = mine.reduce((count, s) => {
        const r = runtimeStatsCache.get(String(s.id));
        return count + (r ? !!r.running : s.status === 'running');
      }, 0);
      const diskMB = mine.reduce((total, s) => {
        const r = runtimeStatsCache.get(String(s.id));
        return total + (Number(r?.diskMB) || 0);
      }, 0);
      return send(res, 200, {
        servers: mine.length,
        running,
        ramMB: ram,
        cpuCores: mine.reduce((a, s) => a + Number(s.cpuCores || CPU_PRESET_CORES), 0),
        diskMB,
        recent: mine.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,5).map(s => ({
          id:s.id,name:s.name,running:getCachedRunning(s),createdAt:s.createdAt
        }))
      });
    }

    if (p === '/api/panel/databases' && method === 'GET') {
      const db = readDb();
      return send(res, 200, { databases: db.databases.filter(x => x.ownerId === user.id) });
    }

    if (p === '/api/panel/databases' && method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim().replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
      if (!name) return send(res,400,{error:'Nome database non valido'});
      let created;
      withDb(db => {
        if (db.databases.some(x => x.ownerId === user.id && x.name.toLowerCase() === name.toLowerCase())) return;
        created = { id:crypto.randomUUID(), ownerId:user.id, name, type:'MySQL 8.0', username:`qh_${crypto.randomBytes(3).toString('hex')}`, sizeMB:0, createdAt:Date.now() };
        db.databases.push(created);
      });
      if (!created) return send(res,409,{error:'Database già esistente'});
      return send(res,200,{database:created});
    }

    const databaseItem = p.match(/^\/api\/panel\/databases\/([^/]+)$/);
    if (databaseItem && method === 'DELETE') {
      const id=databaseItem[1];
      withDb(db => { db.databases = db.databases.filter(x => !(x.id===id && x.ownerId===user.id)); });
      return send(res,200,{ok:true});
    }

    if (p === '/api/panel/backups' && method === 'GET') {
      const db = readDb();
      const backups=db.backups.filter(x=>x.ownerId===user.id).sort((a,b)=>b.createdAt-a.createdAt).map(({path:_,...b})=>b);
      return send(res,200,{backups});
    }

    if (p === '/api/panel/backups' && method === 'POST') {
      const body=await readJsonBody(req);
      const db=readDb();
      const srv=db.servers.find(x=>x.id===body.serverId && x.ownerId===user.id);
      if(!srv) return send(res,404,{error:'Server non trovato'});
      const node=getServerNode(srv, db);
      if(!node) return send(res,503,{error:'Il nodo assegnato al server non è disponibile'});
      const folder=serverStorageFolder(srv,db);
      const id=crypto.randomUUID();
      const filename=`${safeStorageName(srv.name,String(srv.id)).replace(/[^a-zA-Z0-9_-]/g,'_')}-${Date.now()}.tar.gz`;
      const backupBase=path.posix.join(nodeStorageBase(node), '.qubiqohost-backups', String(user.id));
      const target=path.posix.join(backupBase, filename);
      const job=startBackupWorker({...srv,folder},{...node},user.id,filename,target);
      auditEvent(req,user,'action','Creazione backup',`Backup "${filename}" del bot "${srv.name}" avviato`);
      return send(res,202,{pending:true,jobId:job.jobId,backupId:job.backupId,filename});
    }

    const panelBackupJob = p.match(/^\/api\/panel\/backups\/jobs\/([^/]+)$/);
    if (panelBackupJob && method === 'GET') {
      const st=readBackupJobStatus(panelBackupJob[1]);
      if(!st) return send(res,404,{error:'Job backup non trovato'});
      if(st.backup && st.backup.ownerId!==user.id) return send(res,403,{error:'Non autorizzato'});
      return send(res,200,st);
    }

    const backupItem = p.match(/^\/api\/panel\/backups\/([^/]+)$/);
    if (backupItem && method === 'DELETE') {
      const b = readDb().backups.find(x => x.id === backupItem[1] && x.ownerId === user.id);
      if (!b) return send(res, 404, { error: 'Backup non trovato' });
      const db=readDb();
      const srvForBackup=db.servers.find(x=>x.id===b.serverId);
      const node=(db.nodes||[]).find(n=>String(n.id)===String(b.nodeId || srvForBackup?.nodeId));
      if(node && b.path) { try { rfs.remove(node,b.path); } catch(e) { return send(res,502,{error:'Impossibile eliminare il backup remoto: '+e.message}); } }
      withDb(db2 => { db2.backups = db2.backups.filter(x => x.id !== b.id); });
      auditEvent(req, user, 'action', 'Eliminazione backup', `Backup "${b.filename}"`);
      return send(res, 200, { ok: true });
    }

    if (backupItem && method === 'PATCH') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'Nome non valido' });
      if (name.length > 120) return send(res, 400, { error: 'Nome troppo lungo' });

      const db = readDb();
      const b = db.backups.find(x => x.id === backupItem[1] && x.ownerId === user.id);
      if (!b) return send(res, 404, { error: 'Backup non trovato' });

      withDb(db2 => {
        const item = db2.backups.find(x => x.id === b.id && x.ownerId === user.id);
        if (item) item.filename = name;
      });

      auditEvent(req, user, 'action', 'Rinomina backup', `Backup "${b.filename}" → "${name}"`);
      return send(res, 200, { ok: true, filename: name });
    }
    if (backupItem && method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action !== 'restore') return send(res, 400, { error: 'Azione non valida' });
      const db = readDb();
      const b = db.backups.find(x => x.id === backupItem[1] && x.ownerId === user.id);
      if (!b || !b.path) return send(res,404,{error:'Backup non trovato'});
      const srv = db.servers.find(x => x.id === b.serverId && x.ownerId === user.id);
      if (!srv) return send(res,404,{error:'Server associato non trovato'});
      const node = (db.nodes||[]).find(n=>String(n.id)===String(b.nodeId || srv.nodeId));
      if (!node) return send(res,503,{error:'Nodo VPS predefinito non disponibile'});
      const folder=serverStorageFolder({...srv,nodeId:node.id},db);
      const jobId=startBackupRestoreWorker({...srv,folder},{...node},b.path);
      if (!jobId) {
        return send(res,500,{error:'Impossibile avviare il ripristino del backup'});
      }
      auditEvent(req,user,'action','Ripristino backup',`Backup "${b.filename}" del bot "${srv.name}" avviato`);
      return send(res,202,{pending:true,jobId});
    }

    const backupDownload = p.match(/^\/api\/panel\/backups\/([^/]+)\/download$/);
    if (backupDownload && method === 'GET') {
      const db=readDb();
      const b=db.backups.find(x=>x.id===backupDownload[1]&&x.ownerId===user.id);
      if(!b||!b.path)return send(res,404,{error:'Backup non trovato'});
      const srvForBackup=db.servers.find(x=>x.id===b.serverId);
      const node=(db.nodes||[]).find(n=>String(n.id)===String(b.nodeId || srvForBackup?.nodeId));
      if(!node)return send(res,503,{error:'Nodo VPS non disponibile'});
      let size;
      try { size=rfs.remoteFileSize(node,b.path); } catch(e) { return send(res,502,{error:'Backup non raggiungibile: '+e.message}); }
      return rfs.streamRemoteFile(node,b.path,res,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${String(b.filename).replace(/"/g,'')}"`,'Content-Length':String(size)});
    }

    if (p === '/api/panel/network' && method === 'GET') {
      const db=readDb();
      return send(res,200,{network:db.network.filter(x=>x.ownerId===user.id)});
    }

    if (p === '/api/panel/network' && method === 'POST') {
      const body=await readJsonBody(req);
      const port=Math.floor(Number(body.port));
      const protocol=String(body.protocol||'TCP').toUpperCase();
      if(!Number.isInteger(port)||port<1||port>65535||!['TCP','UDP'].includes(protocol)) return send(res,400,{error:'Porta o protocollo non valido'});
      let item;
      withDb(db=>{
        item={id:crypto.randomUUID(),ownerId:user.id,port,protocol,service:String(body.service||'Custom').slice(0,50),enabled:body.enabled!==false,createdAt:Date.now()};
        db.network.push(item);
      });
      return send(res,200,{rule:item});
    }

    const networkItem=p.match(/^\/api\/panel\/network\/([^/]+)$/);
    if(networkItem&&method==='PATCH'){
      const body=await readJsonBody(req); let item;
      withDb(db=>{item=db.network.find(x=>x.id===networkItem[1]&&x.ownerId===user.id);if(item&&typeof body.enabled==='boolean')item.enabled=body.enabled;});
      if(!item)return send(res,404,{error:'Regola non trovata'});
      return send(res,200,{rule:item});
    }
    if(networkItem&&method==='DELETE'){
      withDb(db=>{db.network=db.network.filter(x=>!(x.id===networkItem[1]&&x.ownerId===user.id));});
      return send(res,200,{ok:true});
    }

    if (p === '/api/panel/subusers' && method === 'GET') {
      const db=readDb();
      if (user.role==='admin'||user.role==='staff') return send(res,403,{error:'Solo il proprietario può gestire i collaboratori'});
      return send(res,200,{subusers:(db.subusers||[]).filter(x=>x.ownerId===user.id).map(x=>{const target=(db.users||[]).find(u=>u.id===x.userId)||findExistingAccount(db,x.username);return {...x,userId:target?.id||x.userId||null,username:target?.username||x.username,email:target?.email||x.email||null};})});
    }
    if (p === '/api/panel/subusers' && method === 'POST') {
      if (user.role==='admin'||user.role==='staff') return send(res,403,{error:'Solo il proprietario può gestire i collaboratori'});
      const body=await readJsonBody(req), db=readDb();
      const identifier=String(body.identifier||body.username||body.email||'').trim();
      const target=findExistingAccount(db,identifier);
      if(!target) return send(res,404,{error:'Account non trovato. Inserisci username o email di un utente già registrato.'});
      if(target.id===user.id) return send(res,400,{error:'Non puoi aggiungere il tuo stesso account come collaboratore'});
      if(target.role==='admin') return send(res,400,{error:'Non puoi aggiungere un amministratore come collaboratore'});
      if((db.subusers||[]).some(x=>x.ownerId===user.id && (x.userId===target.id || (!x.userId && String(x.username||'').toLowerCase()===String(target.username||'').toLowerCase())))) return send(res,409,{error:'Questo utente è già un collaboratore'});
      const owned=new Set(db.servers.filter(s=>s.ownerId===user.id).map(s=>String(s.id)));
      const serverIds=Array.isArray(body.serverIds)?body.serverIds.map(String).filter(id=>owned.has(id)):[];
      const permissions=Array.isArray(body.permissions)?body.permissions.filter(x=>COLLABORATOR_PERMISSIONS.includes(x)).slice(0,30):['console.read'];
      let sub; withDb(db2=>{sub={id:crypto.randomUUID(),ownerId:user.id,userId:target.id,username:target.username,email:target.email,permissions,serverIds,createdAt:Date.now()};db2.subusers.push(sub);});
      return send(res,200,{subuser:sub});
    }
    const subuserItem=p.match(/^\/api\/panel\/subusers\/([^/]+)$/);
    if(subuserItem&&method==='PATCH'){
      if (user.role==='admin'||user.role==='staff') return send(res,403,{error:'Solo il proprietario può gestire i collaboratori'});
      const body=await readJsonBody(req);
      const before=readDb();
      const subusers=Array.isArray(before.subusers)?before.subusers:[];
      const exists=subusers.find(x=>x&&x.id===subuserItem[1]&&x.ownerId===user.id);
      if(!exists)return send(res,404,{error:'Collaboratore non trovato'});
      const owned=new Set((before.servers||[]).filter(x=>x&&x.ownerId===user.id).map(x=>String(x.id)));
      let updated=null;
      withDb(db2=>{
        if(!Array.isArray(db2.subusers)) db2.subusers=[];
        const row=db2.subusers.find(x=>x&&x.id===subuserItem[1]&&x.ownerId===user.id);
        if(!row)return;
        const nextServerIds=Array.isArray(body.serverIds)?body.serverIds.map(String).filter(id=>owned.has(id)):(Array.isArray(row.serverIds)?row.serverIds.map(String).filter(id=>owned.has(id)):[]);
        const nextPermissions=Array.isArray(body.permissions)?body.permissions.map(String).filter(x=>COLLABORATOR_PERMISSIONS.includes(x)):(Array.isArray(row.permissions)?row.permissions:[]).filter(x=>COLLABORATOR_PERMISSIONS.includes(x));
        row.serverIds=nextServerIds;
        row.permissions=nextPermissions;
        updated={...row,serverIds:nextServerIds.slice(),permissions:nextPermissions.slice()};
      });
      if(!updated)return send(res,404,{error:'Collaboratore non trovato'});
      return send(res,200,{subuser:updated});
    }
    if(subuserItem&&method==='DELETE'){
      if (user.role==='admin'||user.role==='staff') return send(res,403,{error:'Solo il proprietario può gestire i collaboratori'});
      withDb(db=>{db.subusers=db.subusers.filter(x=>!(x.id===subuserItem[1]&&x.ownerId===user.id));});
      return send(res,200,{ok:true});
    }

    if (p === '/api/panel/settings' && method === 'GET') {
      const db=readDb();
      db.settings ||= {};
      const saved=db.settings[user.id]||{};
      return send(res,200,{settings:{username:user.username,email:user.email,discordConnected:Boolean(user.discordId),twoFactor:Boolean(saved.twoFactor),theme:saved.theme||'light',language:saved.language||'Italiano'}});
    }
    if (p === '/api/panel/settings' && method === 'PATCH') {
      const body=await readJsonBody(req);
      const wantsUsername = Object.prototype.hasOwnProperty.call(body, 'username');
      const wantsEmail = Object.prototype.hasOwnProperty.call(body, 'email');
      const wantsPassword = Object.prototype.hasOwnProperty.call(body, 'newPassword');
      const changingCredentials = wantsUsername || wantsEmail || wantsPassword;

      if (changingCredentials) {
        const currentPassword = String(body.currentPassword || '');
        if (!currentPassword || !auth.verifyPassword(currentPassword, user.salt, user.hash)) {
          return send(res,400,{error:'Password attuale non corretta'});
        }
      }

      let result;
      withDb(db=>{
        db.settings ||= {};
        const current = db.users.find(u=>u.id===user.id);
        if (!current) return;

        if (wantsUsername) {
          const username = String(body.username || '').trim();
          if (username.length < 3 || username.length > 24) { result={error:'Username: minimo 3 e massimo 24 caratteri'}; return; }
          if (!/^[a-zA-Z0-9_.-]+$/.test(username)) { result={error:'Username non valido: usa lettere, numeri, punto, trattino o underscore'}; return; }
          const duplicate = db.users.find(u=>u.id!==user.id && u.username.toLowerCase()===username.toLowerCase());
          if (duplicate) { result={error:'Username già in uso'}; return; }
          current.username=username;
        }

        if (wantsEmail) {
          const email=String(body.email || '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { result={error:'Email non valida'}; return; }
          const duplicate=db.users.find(u=>u.id!==user.id && (u.email||'').toLowerCase()===email);
          if (duplicate) { result={error:'Email già in uso'}; return; }
          if (email !== String(current.email || '').toLowerCase()) {
            current.email=email;
            current.emailVerified=false;
            delete current.emailVerificationTokenHash;
            delete current.emailVerificationExpiresAt;
          }
        }

        if (wantsPassword) {
          const newPassword=String(body.newPassword || '');
          if (newPassword.length < 6) { result={error:'La nuova password deve avere almeno 6 caratteri'}; return; }
          const {salt,hash}=auth.hashPassword(newPassword);
          current.salt=salt;
          current.hash=hash;
        }

        const saved=db.settings[user.id]||{};
        db.settings[user.id]={...saved,
          theme:['dark','light'].includes(body.theme)?body.theme:(saved.theme||'light'),
          language:['Italiano','English'].includes(body.language)?body.language:(saved.language||'Italiano'),
          twoFactor:typeof body.twoFactor==='boolean'?body.twoFactor:Boolean(saved.twoFactor)
        };
        result={settings:{username:current.username,email:current.email,discordConnected:Boolean(current.discordId),twoFactor:Boolean(db.settings[user.id].twoFactor),theme:db.settings[user.id].theme,language:db.settings[user.id].language}};
      });

      if (result?.error) return send(res,400,{error:result.error});
      const dbAfter=readDb();
      const freshForEmail=dbAfter.users.find(u=>u.id===user.id);
      if (wantsEmail && freshForEmail && freshForEmail.emailVerified === false) {
        try {
          await sendVerificationEmail(freshForEmail);
        } catch (error) {
          console.error('[email-verification] Cambio email: invio fallito:', error.message || error);
          return send(res,503,{error:"Email aggiornata, ma non è stato possibile inviare il link di verifica. Controlla la configurazione SMTP."});
        }
      }
      dbAfter.settings ||= {};
      const saved=dbAfter.settings[user.id]||{};
      const fresh=dbAfter.users.find(u=>u.id===user.id);
      if (!fresh) return send(res,404,{error:'Utente non trovato'});
      return send(res,200,{ok:true,settings:{username:fresh.username,email:fresh.email,discordConnected:Boolean(fresh.discordId),twoFactor:Boolean(saved.twoFactor),theme:saved.theme||'light',language:saved.language||'Italiano'}});
    }

    if (p === '/api/panel/tickets' && method === 'GET') {
      const db=readDb();
      return send(res,200,{tickets:db.tickets.filter(x=>x.ownerId===user.id).sort((a,b)=>b.updatedAt-a.updatedAt)});
    }
    if (p === '/api/panel/tickets' && method === 'POST') {
      const body=await readJsonBody(req); const subject=String(body.subject||'').trim(); const category=String(body.category||'Supporto Tecnico').trim();
      if(!subject)return send(res,400,{error:'Inserisci un oggetto'});
      let ticket; withDb(db=>{ticket={id:crypto.randomUUID(),number:1024+db.tickets.length,ownerId:user.id,category,status:'open',subject,messages:[{id:crypto.randomUUID(),author:user.username,role:'client',content:String(body.message||''),createdAt:Date.now()}],createdAt:Date.now(),updatedAt:Date.now(),discordChannelId:null};db.tickets.push(ticket);});
      try {
        const channelId = await createDiscordTicketChannel(ticket, user);
        if (channelId) withDb(db => { const t=db.tickets.find(x=>x.id===ticket.id); if(t) t.discordChannelId=channelId; });
      } catch (discordError) { console.warn('Discord ticket sync:', discordError.message); }
      return send(res,200,{ticket:readDb().tickets.find(x=>x.id===ticket.id) || ticket});
    }
    const ticketItem=p.match(/^\/api\/panel\/tickets\/([^/]+)$/);
    if(ticketItem&&method==='GET'){
      const t=readDb().tickets.find(x=>x.id===ticketItem[1]&&x.ownerId===user.id);
      if(!t)return send(res,404,{error:'Ticket non trovato'}); return send(res,200,{ticket:t});
    }
    if(ticketItem&&method==='POST'){
      const body=await readJsonBody(req); let ticket;
      const content = String(body.message||'').trim();
      withDb(db=>{ticket=db.tickets.find(x=>x.id===ticketItem[1]&&x.ownerId===user.id);if(ticket&&content){ticket.messages.push({id:crypto.randomUUID(),author:user.username,role:'client',content,createdAt:Date.now()});ticket.updatedAt=Date.now();}});
      if(!ticket)return send(res,404,{error:'Ticket non trovato'});
      if (content && ticket.discordChannelId) { try { await sendDiscordTicketMessage(ticket.discordChannelId, ticket, user.username, content); } catch(e) { console.warn('Discord ticket reply:', e.message); } }
      return send(res,200,{ticket});
    }
    if(ticketItem&&method==='PATCH'){
      const body=await readJsonBody(req); let ticket;
      withDb(db=>{ticket=db.tickets.find(x=>x.id===ticketItem[1]&&x.ownerId===user.id);if(ticket&&['open','pending'].includes(body.status)){ticket.status=body.status;ticket.updatedAt=Date.now();}});
      if(!ticket)return send(res,404,{error:'Ticket non trovato'}); return send(res,200,{ticket});
    }

    const filesListMatch = p.match(/^\/api\/servers\/([^/]+)\/files$/);
    if (filesListMatch && method === 'GET') {
      const db = readDb();
      const srv = db.servers.find(s => s.id === filesListMatch[1]);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, method === 'GET' ? 'files.read' : 'files.write')) return send(res, 403, { error: 'Non autorizzato: permesso file insufficiente' });
      const node = getServerNode(srv, db);
      const ops = fileOps(node);
      let relativePath = '';
      try { relativePath = String(url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, ''); }
      catch (_) { return send(res, 400, { error: 'Percorso non valido' }); }
      let folder;
      try { folder = resolveServerRelativePath(srv, relativePath); } catch (_) { return send(res, 403, { error: 'Percorso non valido' }); }
      if (!ops.exists(folder) || !ops.isDir(folder)) return send(res, 404, { error: 'Cartella non trovata' });
      const list = ops.list(folder).map(ent => ({
        name: ent.name, path: path.posix.join(relativePath, ent.name), size: ent.size, isDir: ent.isDir,
      })).sort((a,b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'it'));
      return send(res, 200, { files: list, path: relativePath });
    }

    const fileItemMatch = p.match(/^\/api\/servers\/([^/]+)\/files\/(.*)$/);
    if (fileItemMatch) {
      const [, serverId, filenameRaw] = fileItemMatch;
      const filename = decodeURIComponent(filenameRaw || '');
      const db = readDb();
      const srv = db.servers.find(s => s.id === serverId);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, method === 'GET' ? 'files.read' : 'files.write')) return send(res, 403, { error: 'Non autorizzato: permesso file insufficiente' });
      const node = getServerNode(srv, db);
      const ops = fileOps(node);
      let target;
      try { target = resolveServerRelativePath(srv, filename); } catch (_) { return send(res, 403, { error: 'Percorso non valido' }); }
      if (target === serverFolder(srv)) return send(res, 400, { error: 'Percorso non valido' });

      if (method === 'GET') {
        if (!ops.exists(target)) return send(res, 404, { error: 'File non trovato' });
        if (ops.isDir(target)) return send(res, 400, { error: 'Le cartelle vanno aperte dal File Manager' });
        if (url.searchParams.get('download') === '1') {
          const buf = ops.readFileBuffer(target);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${path.posix.basename(target).replace(/"/g, '')}"`,
            'Content-Length': buf.length,
          });
          return res.end(buf);
        }
        return send(res, 200, { content: ops.readFile(target), path: path.posix.relative(serverFolder(srv), target) });
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        if (ops.isDir(target)) return send(res, 400, { error: 'Non puoi modificare una cartella' });
        ops.writeFile(target, typeof body.content === 'string' ? body.content : '');
        return send(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        if (!ops.exists(target)) return send(res, 404, { error: 'Elemento non trovato' });
        ops.remove(target);
        return send(res, 200, { ok: true });
      }
    }

    const createFileMatch = p.match(/^\/api\/servers\/([^/]+)\/files\/create$/);
    if (createFileMatch && method === 'POST') {
      const db = readDb();
      const srv = db.servers.find(s => s.id === createFileMatch[1]);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, method === 'GET' ? 'files.read' : 'files.write')) return send(res, 403, { error: 'Non autorizzato: permesso file insufficiente' });
      const node = getServerNode(srv, db);
      const ops = fileOps(node);
      const body = await readJsonBody(req);
      const filename = safeFileName(body.name);
      const content = typeof body.content === 'string' ? body.content : '';
      if (!filename) return send(res, 400, { error: 'Nome file non valido' });
      let folder;
      try { folder = resolveServerRelativePath(srv, body.path || ''); } catch (_) { return send(res, 403, { error: 'Percorso non valido' }); }
      if (!ops.exists(folder) || !ops.isDir(folder)) return send(res, 404, { error: 'Cartella non trovata' });
      const target = path.posix.join(folder, filename);
      if (ops.exists(target)) return send(res, 409, { error: 'Esiste già un elemento con questo nome' });
      ops.writeFile(target, content);
      return send(res, 200, { ok: true, file: { name: filename, path: path.posix.relative(serverFolder(srv), target), size: Buffer.byteLength(content), isDir: false } });
    }

    const createFolderMatch = p.match(/^\/api\/servers\/([^/]+)\/folders\/create$/);
    if (createFolderMatch && method === 'POST') {
      const db = readDb();
      const srv = db.servers.find(s => s.id === createFolderMatch[1]);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, method === 'GET' ? 'files.read' : 'files.write')) return send(res, 403, { error: 'Non autorizzato: permesso file insufficiente' });
      const node = getServerNode(srv, db);
      const ops = fileOps(node);
      const body = await readJsonBody(req);
      const name = safeFileName(body.name);
      if (!name) return send(res, 400, { error: 'Nome cartella non valido' });
      let folder;
      try { folder = resolveServerRelativePath(srv, body.path || ''); } catch (_) { return send(res, 403, { error: 'Percorso non valido' }); }
      if (!ops.exists(folder) || !ops.isDir(folder)) return send(res, 404, { error: 'Cartella non trovata' });
      const target = path.posix.join(folder, name);
      if (ops.exists(target)) return send(res, 409, { error: 'Esiste già un elemento con questo nome' });
      ops.mkdir(target);
      return send(res, 200, { ok: true, folder: { name, path: path.posix.relative(serverFolder(srv), target), isDir: true } });
    }

    const renameFileMatch = p.match(/^\/api\/servers\/([^/]+)\/files\/rename$/);
    if (renameFileMatch && method === 'POST') {
      const db = readDb();
      const srv = db.servers.find(s => s.id === renameFileMatch[1]);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, method === 'GET' ? 'files.read' : 'files.write')) return send(res, 403, { error: 'Non autorizzato: permesso file insufficiente' });
      const node = getServerNode(srv, db);
      const ops = fileOps(node);
      const body = await readJsonBody(req);
      const oldName = String(body.oldName || '').trim();
      const newName = safeFileName(body.newName);
      if (!oldName || !newName) return send(res, 400, { error: 'Nome non valido' });
      let folder;
      try { folder = resolveServerRelativePath(srv, body.path || ''); } catch (_) { return send(res, 403, { error: 'Percorso non valido' }); }
      const source = path.posix.join(folder, oldName);
      const target = path.posix.join(folder, newName);
      const root = serverFolder(srv);
      const sr = path.posix.relative(root, source), tr = path.posix.relative(root, target);
      if (sr.startsWith('..') || tr.startsWith('..') || path.posix.isAbsolute(sr) || path.posix.isAbsolute(tr)) return send(res, 403, { error: 'Percorso non valido' });
      if (!ops.exists(source)) return send(res, 404, { error: 'Elemento non trovato' });
      if (ops.exists(target)) return send(res, 409, { error: 'Esiste già un elemento con questo nome' });
      ops.rename(source, target);
      return send(res, 200, { ok: true, path: path.posix.relative(root, target) });
    }

    const uploadMatch = p.match(/^\/api\/servers\/([^/]+)\/upload$/);
    if (uploadMatch && method === 'POST') {
      const db = readDb();
      const srv = db.servers.find(s => s.id === uploadMatch[1]);
      if (!srv) return send(res, 404, { error: 'Server non trovato' });
      if (!canAccessServer(user, srv, db, method === 'GET' ? 'files.read' : 'files.write')) return send(res, 403, { error: 'Non autorizzato: permesso file insufficiente' });
      const node = getServerNode(srv, db);
      const ops = fileOps(node);
      let folder;
      try { folder = resolveServerRelativePath(srv, url.searchParams.get('path') || ''); } catch (_) { return send(res, 403, { error: 'Percorso non valido' }); }
      if (!ops.exists(folder)) ops.mkdir(folder);
      if (!ops.isDir(folder)) return send(res, 400, { error: 'Destinazione non valida' });
      const raw = await readRawBody(req);
      if (raw.length > 50 * 1024 * 1024) return send(res, 413, { error: 'Upload massimo 50 MB' });
      const { files } = parseMultipart(raw, req.headers['content-type']);
      if (files.length === 0) return send(res, 400, { error: 'Nessun file ricevuto' });
      const root = serverFolder(srv);
      let uploaded = 0;
      for (const f of files) {
        const relativeName = String(f.filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relativeName) continue;
        const dest = path.posix.resolve(folder, relativeName);
        if (dest !== path.posix.resolve(root) && !dest.startsWith(path.posix.resolve(root) + '/')) return send(res, 403, { error: 'Percorso upload non valido' });
        ops.writeFile(dest, f.data);
        uploaded++;
        if (dest.toLowerCase().endsWith('.zip')) {
          if (node) { try { rfs.unzipRemote(node, dest, path.posix.dirname(dest)); } catch (_) {} }
          else {
            execFile('unzip', ['-o', dest, '-d', path.dirname(dest)], err => {
              if (!err) { try { fs.unlinkSync(dest); } catch (_) {} }
            });
          }
        }
      }
      return send(res, 200, { ok: true, uploaded });
    }

    if (p === '/api/staff/tickets' && method === 'GET') {
      if (user.role !== 'staff' && user.role !== 'admin') return send(res, 403, { error: 'Accesso riservato allo staff' });
      const db = readDb();
      const tickets = (db.tickets || []).slice().sort((a,b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).map(t => {
        const owner = db.users.find(x => x.id === t.ownerId);
        return { ...t, ownerUsername: owner?.username || '—', ownerEmail: owner?.email || '—' };
      });
      return send(res, 200, { tickets });
    }
    const staffTicketItem = p.match(/^\/api\/staff\/tickets\/([^/]+)$/);
    if (staffTicketItem) {
      if (user.role !== 'staff' && user.role !== 'admin') return send(res, 403, { error: 'Accesso riservato allo staff' });
      if (method === 'GET') {
        const db = readDb();
        const ticket = (db.tickets || []).find(t => t.id === staffTicketItem[1]);
        if (!ticket) return send(res, 404, { error: 'Ticket non trovato' });
        const owner = db.users.find(x => x.id === ticket.ownerId);
        return send(res, 200, { ticket: { ...ticket, ownerUsername: owner?.username || '—', ownerEmail: owner?.email || '—' } });
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        let ticket = null;
        withDb(db => {
          ticket = (db.tickets || []).find(t => t.id === staffTicketItem[1]);
          if (!ticket) return;
          if (['open','pending','closed'].includes(body.status)) ticket.status = body.status;
          if (typeof body.message === 'string' && body.message.trim()) {
            ticket.messages ||= [];
            ticket.messages.push({ id: crypto.randomUUID(), author: user.username, role: 'staff', content: body.message.trim(), createdAt: Date.now() });
          }
          ticket.updatedAt = Date.now();
        });
        if (!ticket) return send(res, 404, { error: 'Ticket non trovato' });
        if (typeof body.message === 'string' && body.message.trim() && ticket.discordChannelId) {
          try { await sendDiscordTicketMessage(ticket.discordChannelId, ticket, user.username, body.message.trim()); }
          catch (e) { console.warn('Discord staff ticket reply:', e.message); }
        }
        return send(res, 200, { ticket });
      }
      return send(res, 405, { error: 'Metodo non consentito' });
    }

    if (p.startsWith('/api/admin/')) {
      if (user.role !== 'admin') return send(res, 403, { error: 'Accesso riservato agli amministratori' });
      auditAdminRequest(req, user, p, method);

      if (p === '/api/admin/logs' && method === 'GET') {
        const db = readDb();
        const category = String(url.searchParams.get('category') || 'all').trim().toLowerCase();
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 300)));
        let logs = Array.isArray(db.auditLogs) ? db.auditLogs.slice().reverse() : [];
        if (category !== 'all') logs = logs.filter(x => x.category === category);
        if (q) logs = logs.filter(x => `${x.username} ${x.email} ${x.action} ${x.details} ${x.ip}`.toLowerCase().includes(q));
        return send(res, 200, { logs: logs.slice(0, limit), total: logs.length });
      }

      if (p === '/api/admin/email-users' && method === 'GET') {
        const db = readDb();
        const users = (Array.isArray(db.users) ? db.users : [])
          .filter(u => u.role !== 'admin' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email || '')))
          .map(u => ({ id: u.id, username: u.username, email: u.email, emailVerified: u.emailVerified !== false, suspended: !!u.suspended }))
          .sort((a, b) => String(a.email).localeCompare(String(b.email), 'it'));
        return send(res, 200, { users });
      }

      if (p === '/api/admin/email' && method === 'POST') {
        const body = await readJsonBody(req);
        const userId = String(body.userId || '').trim();
        const subject = String(body.subject || '').trim();
        const message = String(body.message || '').trim();
        if (!userId) return send(res, 400, { error: 'Seleziona un destinatario' });
        if (!subject) return send(res, 400, { error: "Inserisci il titolo dell'email" });
        if (!message) return send(res, 400, { error: "Inserisci il messaggio dell'email" });
        if (subject.length > 180) return send(res, 400, { error: 'Il titolo è troppo lungo' });
        if (message.length > 20000) return send(res, 400, { error: 'Il messaggio è troppo lungo' });
        const db = readDb();
        const recipient = (db.users || []).find(u => u.id === userId && u.role !== 'admin' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email || '')));
        if (!recipient) return send(res, 404, { error: 'Utente o email non trovati' });
        try {
          await sendManualAdminEmail(recipient, subject, message);
          auditEvent(req, user, 'admin', 'Invio email', `A ${recipient.username} (${recipient.email}) — "${subject}"`);
          console.log(`[QubiqoHost] Email admin inviata a ${recipient.email}: ${subject}`);
          return send(res, 200, { ok: true, recipient: { username: recipient.username, email: recipient.email } });
        } catch (error) {
          console.error('[QubiqoHost] Invio email admin fallito:', error.message || error);
          return send(res, 503, { error: error.message || "Impossibile inviare l'email" });
        }
      }

      if (p === '/api/admin/stats' && method === 'GET') {
        const db = readDb();
        const now = Date.now();
        const DAY = 24 * 60 * 60 * 1000;
        const users = Array.isArray(db.users) ? db.users : [];
        const servers = Array.isArray(db.servers) ? db.servers : [];
        const nodes = Array.isArray(db.nodes) ? db.nodes : [];
        // Ricarica sempre le statistiche runtime dal file aggiornato dal worker.
        // Il frontend fa polling ogni 3 secondi, quindi i dati mostrati restano aggiornati.
        refreshAllRuntimeStats();
        const totalUsers = users.length;
        const activeUsers = users.filter(u => !u.suspended).length;
        const suspendedUsers = users.filter(u => !!u.suspended).length;
        const newUsers7d = users.filter(u => Number(u.createdAt) >= now - 7 * DAY).length;
        const newUsers30d = users.filter(u => Number(u.createdAt) >= now - 30 * DAY).length;
        const newUsersToday = users.filter(u => Number(u.createdAt) >= now - DAY).length;

        const runtimeServers = servers.map(s => {
          const r = runtimeStatsCache.get(String(s.id)) || {};
          const owner = users.find(u => u.id === s.ownerId);
          return {
            id: s.id, name: s.name, ownerId: s.ownerId,
            ownerUsername: owner?.username || '—', ownerEmail: owner?.email || '—',
            running: !!r.running && !s.suspended, suspended: !!s.suspended,
            cpuPercent: Number(r.cpuPercent) || 0, ramMB: Number(r.ramMB) || 0,
            diskMB: Number(r.diskMB) || 0, uptimeSeconds: Number(r.uptimeSeconds) || 0,
            startedAt: r.startedAt || null, updatedAt: Number(r.updatedAt) || 0
          };
        });
        const runningServers = runtimeServers.filter(r => r.running).length;
        const suspendedServers = servers.filter(s => !!s.suspended).length;
        const stoppedServers = Math.max(0, servers.length - runningServers - suspendedServers);
        const ramAllocatedMB = servers.reduce((a, s) => a + (Number(s.ramMB) || 0), 0);
        const cpuAllocatedCores = servers.reduce((a, s) => a + (Number(s.cpuCores) || CPU_PRESET_CORES), 0);
        const totalRuntimeRamMB = runtimeServers.reduce((a, s) => a + s.ramMB, 0);
        const totalRuntimeDiskMB = runtimeServers.reduce((a, s) => a + s.diskMB, 0);
        const totalRuntimeCpuPercent = runtimeServers.reduce((a, s) => a + s.cpuPercent, 0);
        const onlineRuntime = runtimeServers.filter(s => s.running);
        const averageUptimeSeconds = onlineRuntime.length ? Math.round(onlineRuntime.reduce((a,s)=>a+s.uptimeSeconds,0)/onlineRuntime.length) : 0;
        const totalSlots = users.reduce((a, u) => a + Math.max(0, Number(u.slots) || 0), 0);
        const creditsIssued = users.reduce((a, u) => a + Math.max(0, Number(u.credits) || 0), 0);
        const primaryNode = getDefaultNode(db);
        const primaryNodeRuntime = primaryNode ? (runtimeNodeStatsCache.get(String(primaryNode.id)) || {}) : {};
        const primaryNodeStats = primaryNode ? {
          id: primaryNode.id,
          name: primaryNode.name || primaryNode.host || 'Nodo',
          host: primaryNode.host || '',
          online: !!primaryNodeRuntime.online,
          hostname: primaryNodeRuntime.hostname || primaryNode.host || '—',
          cpuPercent: Number(primaryNodeRuntime.cpuPercent) || 0,
          cpuCores: Number(primaryNodeRuntime.cpuCores) || Number(primaryNode.system?.cpuCores) || 0,
          load1: Number(primaryNodeRuntime.load1) || 0,
          ramUsedMB: Number(primaryNodeRuntime.ramUsedMB) || 0,
          ramTotalMB: Number(primaryNodeRuntime.ramTotalMB) || Number(primaryNode.system?.memoryMB) || 0,
          ramPercent: Number(primaryNodeRuntime.ramPercent) || 0,
          diskUsedMB: Number(primaryNodeRuntime.diskUsedMB) || 0,
          diskTotalMB: Number(primaryNodeRuntime.diskTotalMB) || Number(primaryNode.system?.disk?.totalMB) || 0,
          diskPercent: Number(primaryNodeRuntime.diskPercent) || 0,
          uptimeSeconds: Number(primaryNodeRuntime.uptimeSeconds) || 0,
          updatedAt: Number(primaryNodeRuntime.updatedAt) || 0,
          error: primaryNodeRuntime.error || primaryNode.lastError || null,
        } : null;
        const nodeServers = servers.filter(s => s.language === 'nodejs').length;
        const pythonServers = servers.filter(s => s.language === 'python').length;
        const usersByDay = Array.from({ length: 7 }, (_, index) => {
          const dayStart = new Date(now - (6 - index) * DAY); dayStart.setHours(0,0,0,0);
          const next = new Date(dayStart.getTime() + DAY);
          return { label: dayStart.toLocaleDateString('it-IT',{weekday:'short'}).replace('.',''), count: users.filter(u => { const t=Number(u.createdAt)||0; return t>=dayStart.getTime()&&t<next.getTime(); }).length };
        });
        const recentUsers = [...users].sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0)).slice(0,5).map(u=>({username:u.username,date:Number(u.createdAt)?new Date(u.createdAt).toLocaleDateString('it-IT'):'—'}));
        return send(res, 200, {
          totalUsers, activeUsers, suspendedUsers, newUsers7d, newUsers30d, newUsersToday,
          totalServers: servers.length, runningServers, stoppedServers, suspendedServers,
          ramAllocatedMB, cpuAllocatedCores, totalSlots, usedSlots: servers.length, creditsIssued,
          nodeServers, pythonServers, usersByDay, recentUsers,
          primaryNode: primaryNodeStats,
          runtimeCpuPercent: Number(totalRuntimeCpuPercent.toFixed(1)),
          runtimeRamMB: Number(totalRuntimeRamMB.toFixed(1)),
          runtimeDiskMB: Number(totalRuntimeDiskMB.toFixed(1)),
          runtimeUptimeSeconds: averageUptimeSeconds,
          runtimeUpdatedAt: runtimeServers.reduce((m,s)=>Math.max(m,s.updatedAt||0),0),
          runtimeServers
        });
      }

      if (p === '/api/admin/users' && method === 'GET') {
        const db = readDb();
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        let list = db.users;
        if (q) {
          list = list.filter(u =>
            u.username.toLowerCase().includes(q) ||
            (u.email || '').toLowerCase().includes(q) ||
            (u.pin || '').toLowerCase().replace('-', '').includes(q.replace('-', '')));
        }
        return send(res, 200, { users: list.map(u => safeAdminUser(u, db.users)) });
      }

      if (p === '/api/admin/users' && method === 'POST') {
        const body = await readJsonBody(req);
        const username = (body.username || '').trim();
        const email = (body.email || '').trim().toLowerCase();
        const password = body.password || '';
        const role = ['user','staff','tester','admin'].includes(body.role) ? body.role : 'user';
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (username.length < 3 || password.length < 6 || !emailOk) {
          return send(res, 400, { error: 'Controlla username (min 3), email e password (min 6 caratteri)' });
        }
        let error = null, created = null;
        withDb(db => {
          if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
            error = 'Username già in uso'; return;
          }
          if (db.users.find(u => u.email === email)) {
            error = 'Email già registrata'; return;
          }
          const { salt, hash } = auth.hashPassword(password);
          created = {
            id: crypto.randomUUID(), username, email, salt, hash, role,
            suspended: false, emailVerified: true, createdAt: Date.now(),
            slots: Number.isFinite(body.slots) && body.slots >= 0 ? body.slots : DEFAULT_SLOTS,
            credits: Number.isFinite(body.credits) && body.credits >= 0 ? body.credits : 0,
            pin: generatePin(db),
            authProvider: 'manual',
            ipHashes: [],
            lastIpHash: null,
            lastIpAt: null,
          };
          db.users.push(created);
          assignUserToDefaultNode(db, created.id);
        });
        if (error) return send(res, 400, { error });
        try { ensureUserStorageRoot(created, getDefaultNode(readDb())); } catch (_) {}
        auditEvent(req, user, 'admin', 'Creazione utente', `Creato ${created.username} (${created.email})`);
        return send(res, 200, { user: safeUser(created) });
      }

      const userItemMatch = p.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userItemMatch && method === 'PATCH') {
        const body = await readJsonBody(req);
        let updated = null, error = null, usernameChanged = false;
        withDb(db => {
          const u = db.users.find(x => x.id === userItemMatch[1]);
          if (!u) return;
          if (u.id === user.id && body.role && body.role !== 'admin') { error = 'Non puoi rimuovere il ruolo Admin dal tuo stesso account'; return; }
          if (typeof body.suspended === 'boolean') u.suspended = body.suspended;
          if (body.regeneratePin) u.pin = generatePin(db);
          if (body.role === 'admin' || body.role === 'staff' || body.role === 'tester' || body.role === 'user') u.role = body.role;
          if (typeof body.emailVerified === 'boolean') u.emailVerified = body.emailVerified;
          if (Number.isFinite(body.slots) && body.slots >= 0) u.slots = Math.floor(body.slots);
          if (Number.isFinite(body.credits) && body.credits >= 0) u.credits = Math.floor(body.credits);
          if (Object.prototype.hasOwnProperty.call(body, 'username')) {
            const username = String(body.username || '').trim();
            if (username.length < 3 || username.length > 24 || !/^[a-zA-Z0-9_.-]+$/.test(username)) { error = 'Username non valido'; return; }
            if (db.users.some(x => x.id !== u.id && x.username.toLowerCase() === username.toLowerCase())) { error = 'Username già in uso'; return; }
            usernameChanged = u.username !== username;
            u.username = username;
          }
          if (Object.prototype.hasOwnProperty.call(body, 'email')) {
            const email = String(body.email || '').trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { error = 'Email non valida'; return; }
            if (db.users.some(x => x.id !== u.id && (x.email || '').toLowerCase() === email)) { error = 'Email già in uso'; return; }
            u.email = email;
          }
          if (Object.prototype.hasOwnProperty.call(body, 'password')) {
            const password = String(body.password || '');
            if (password.length < 6) { error = 'La password deve avere almeno 6 caratteri'; return; }
            const { salt, hash } = auth.hashPassword(password);
            u.salt = salt; u.hash = hash;
          }
          updated = u;
        });
        if (error) return send(res, 400, { error });
        if (!updated) return send(res, 404, { error: 'Utente non trovato' });
        if (usernameChanged) {
          const dbAfter = readDb();
          for (const srv of dbAfter.servers.filter(s => s.ownerId === updated.id)) {
            try { moveServerStorage(srv, dbAfter); } catch (e) {
              console.warn(`[storage] Migrazione username ${updated.username}/${srv.id}: ${e.message}`);
            }
          }
          withDb(db => {
            for (const srv of db.servers || []) {
              if (srv.ownerId === updated.id) srv.folder = serverStorageFolder(srv, db);
            }
          });
        }
        try { ensureUserStorageRoot(updated, getDefaultNode(readDb())); } catch (_) {}
        auditEvent(req, user, 'admin', 'Modifica utente', `Utente ${updated.username} (${updated.email}) — modifica profilo`);
        return send(res, 200, { user: safeUser(updated) });
      }

      if (userItemMatch && method === 'DELETE') {
        const dbBefore = readDb();
        if (userItemMatch[1] === user.id) return send(res, 400, { error: 'Non puoi eliminare il tuo stesso account Admin' });
        const targetUser = dbBefore.users.find(x => x.id === userItemMatch[1]);
        if (!targetUser) return send(res, 404, { error: 'Utente non trovato' });
        if (targetUser.role === 'admin' && dbBefore.users.filter(x => x.role === 'admin').length <= 1) return send(res, 400, { error: 'Non puoi eliminare l\'unico amministratore del pannello' });
        const ownedServers = dbBefore.servers.filter(s => s.ownerId === userItemMatch[1]);
        const ownedBackups = dbBefore.backups?.filter(b => b.ownerId === userItemMatch[1]) || [];
        const serverNodes = ownedServers.map(srv => ({ srv, node: getServerNode(srv, dbBefore) }));
        withDb(db => {
          db.servers = db.servers.filter(s => s.ownerId !== userItemMatch[1]);
          db.backups = (db.backups || []).filter(b => b.ownerId !== userItemMatch[1]);
          db.databases = (db.databases || []).filter(x => x.ownerId !== userItemMatch[1]);
          db.network = (db.network || []).filter(x => x.ownerId !== userItemMatch[1]);
          db.subusers = (db.subusers || []).filter(x => x.ownerId !== userItemMatch[1]);
          db.tickets = (db.tickets || []).filter(x => x.ownerId !== userItemMatch[1]);
          db.users = db.users.filter(u => u.id !== userItemMatch[1]);
        });
        for (const { srv, node } of serverNodes) {
          if (node) startPmActionWorker('delete', { ...srv, folder: serverFolder(srv) }, { ...node });
        }
        for (const backup of ownedBackups) { try { const node=(dbBefore.nodes||[]).find(n=>n.id===backup.nodeId)||getDefaultNode(dbBefore); if(node&&backup.path) rfs.remove(node,backup.path); } catch (_) {} }
        const deletedUser = dbBefore.users.find(x => x.id === userItemMatch[1]);
        auditEvent(req, user, 'admin', 'Eliminazione utente', `Eliminato ${deletedUser?.username || 'utente'} (${deletedUser?.email || '—'})`);
        return send(res, 200, { ok: true });
      }

      const adminFilesList = p.match(/^\/api\/admin\/servers\/([^/]+)\/files$/);
      if (adminFilesList && method === 'GET') {
        const db = readDb();
        const srv = db.servers.find(x => x.id === adminFilesList[1]);
        if (!srv) return send(res, 404, { error: 'Server non trovato' });
        const node = getServerNode(srv, db);
        const ops = fileOps(node);
        const currentPath = String(url.searchParams.get('path') || '');
        let folder;
        try { folder = resolveServerRelativePath(srv, currentPath); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!ops.exists(folder)) return send(res, 404, { error: 'Cartella non trovata' });
        if (!ops.isDir(folder)) return send(res, 400, { error: 'Il percorso non è una cartella' });
        const files = ops.list(folder).map(ent => ({
          name: ent.name, size: ent.size, isDir: ent.isDir,
          path: currentPath ? `${currentPath}/${ent.name}` : ent.name,
        })).sort((a,b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return send(res, 200, { files, path: currentPath });
      }

      const adminFileItem = p.match(/^\/api\/admin\/servers\/([^/]+)\/file$/);
      if (adminFileItem && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
        const db = readDb();
        const srv = db.servers.find(x => x.id === adminFileItem[1]);
        if (!srv) return send(res, 404, { error: 'Server non trovato' });
        const node = getServerNode(srv, db);
        const ops = fileOps(node);
        const relative = String(url.searchParams.get('path') || '');
        if (!relative) return send(res, 400, { error: 'Percorso file mancante' });
        let target;
        try { target = resolveServerRelativePath(srv, relative); } catch (e) { return send(res, 400, { error: e.message }); }
        if (method === 'GET') {
          if (!ops.exists(target)) return send(res, 404, { error: 'File non trovato' });
          if (ops.isDir(target)) return send(res, 400, { error: 'Le cartelle non possono essere aperte come file' });
          if (url.searchParams.get('download') === '1') {
            const buf = ops.readFileBuffer(target);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.posix.basename(target).replace(/"/g, '')}"`, 'Content-Length': buf.length });
            return res.end(buf);
          }
          return send(res, 200, { content: ops.readFile(target), path: relative });
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          if (!ops.exists(target) || ops.isDir(target)) return send(res, 404, { error: 'File non trovato' });
          ops.writeFile(target, typeof body.content === 'string' ? body.content : '');
          return send(res, 200, { ok: true });
        }
        if (!ops.exists(target)) return send(res, 404, { error: 'File non trovato' });
        ops.remove(target);
        return send(res, 200, { ok: true });
      }

      const adminCreateFile = p.match(/^\/api\/admin\/servers\/([^/]+)\/files\/create$/);
      if (adminCreateFile && method === 'POST') {
        const db = readDb();
        const srv = db.servers.find(x => x.id === adminCreateFile[1]);
        if (!srv) return send(res, 404, { error: 'Server non trovato' });
        const node = getServerNode(srv, db);
        const ops = fileOps(node);
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim();
        if (!safeFileName(name)) return send(res, 400, { error: 'Nome file non valido' });
        let folder, target;
        try { folder = resolveServerRelativePath(srv, body.path || ''); target = resolveServerRelativePath(srv, body.path ? `${body.path}/${name}` : name); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!ops.exists(folder) || !ops.isDir(folder)) return send(res, 404, { error: 'Cartella non trovata' });
        if (ops.exists(target)) return send(res, 409, { error: 'Elemento già esistente' });
        ops.writeFile(target, typeof body.content === 'string' ? body.content : '');
        return send(res, 200, { ok: true });
      }

      const adminCreateFolder = p.match(/^\/api\/admin\/servers\/([^/]+)\/folders\/create$/);
      if (adminCreateFolder && method === 'POST') {
        const db = readDb();
        const srv = db.servers.find(x => x.id === adminCreateFolder[1]);
        if (!srv) return send(res, 404, { error: 'Server non trovato' });
        const node = getServerNode(srv, db);
        const ops = fileOps(node);
        const body = await readJsonBody(req); const name = String(body.name || '').trim();
        if (!safeFileName(name)) return send(res, 400, { error: 'Nome cartella non valido' });
        let target;
        try { target = resolveServerRelativePath(srv, body.path ? `${body.path}/${name}` : name); } catch (e) { return send(res, 400, { error: e.message }); }
        if (ops.exists(target)) return send(res, 409, { error: 'Elemento già esistente' });
        ops.mkdir(target);
        return send(res, 200, { ok: true });
      }

      const adminRename = p.match(/^\/api\/admin\/servers\/([^/]+)\/files\/rename$/);
      if (adminRename && method === 'POST') {
        const db = readDb();
        const srv = db.servers.find(x => x.id === adminRename[1]);
        if (!srv) return send(res, 404, { error: 'Server non trovato' });
        const node = getServerNode(srv, db);
        const ops = fileOps(node);
        const body = await readJsonBody(req);
        const oldName = String(body.oldName || '').trim(); const newName = String(body.newName || '').trim();
        if (!safeFileName(oldName) || !safeFileName(newName)) return send(res, 400, { error: 'Nome non valido' });
        let source, target;
        try { source = resolveServerRelativePath(srv, body.path ? `${body.path}/${oldName}` : oldName); target = resolveServerRelativePath(srv, body.path ? `${body.path}/${newName}` : newName); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!ops.exists(source)) return send(res, 404, { error: 'Elemento non trovato' });
        if (ops.exists(target)) return send(res, 409, { error: 'Destinazione già esistente' });
        ops.rename(source, target);
        return send(res, 200, { ok: true });
      }

      const adminUpload = p.match(/^\/api\/admin\/servers\/([^/]+)\/upload$/);
      if (adminUpload && method === 'POST') {
        const db = readDb();
        const srv = db.servers.find(x => x.id === adminUpload[1]);
        if (!srv) return send(res, 404, { error: 'Server non trovato' });
        const node = getServerNode(srv, db);
        const ops = fileOps(node);
        const raw = await readRawBody(req);
        if (raw.length > 50 * 1024 * 1024) return send(res, 413, { error: 'Upload massimo 50 MB' });
        const { files } = parseMultipart(raw, req.headers['content-type']);
        if (!files.length) return send(res, 400, { error: 'Nessun file ricevuto' });
        const currentPath = String(url.searchParams.get('path') || '');
        let folder; try { folder = resolveServerRelativePath(srv, currentPath); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!ops.exists(folder)) ops.mkdir(folder);
        const f = files[0]; const dest = path.posix.join(folder, path.posix.basename(f.filename));
        ops.writeFile(dest, f.data);
        if (dest.toLowerCase().endsWith('.zip')) {
          if (node) { try { rfs.unzipRemote(node, dest, folder); } catch (_) {} }
          else execFile('unzip', ['-o', dest, '-d', folder], err => { if (!err) fs.unlinkSync(dest); });
        }
        return send(res, 200, { ok: true });
      }

      if (p === '/api/admin/backups' && method === 'GET') {
        const db = readDb();
        const backups = (db.backups || []).slice().sort((a,b) => Number(b.createdAt||0) - Number(a.createdAt||0)).map(b => {
          const owner = db.users.find(u => u.id === b.ownerId);
          const { path:_, ...safeBackup } = b;
          return { ...safeBackup, ownerUsername: owner?.username || '—', ownerEmail: owner?.email || '—' };
        });
        return send(res, 200, { backups });
      }
      if (p === '/api/admin/backups' && method === 'POST') {
        const body = await readJsonBody(req);
        const db = readDb();
        const srv = db.servers.find(x => x.id === body.serverId);
        if (!srv) return send(res, 404, { error: 'Server non trovato' });
        const node = getServerNode(srv, db);
        if (!node) return send(res,503,{error:'Il nodo assegnato al server non è disponibile'});
        const folder=serverStorageFolder(srv,db);
        const id=crypto.randomUUID();
        const filename=`${safeStorageName(srv.name,String(srv.id)).replace(/[^a-zA-Z0-9_-]/g,'_')}-${Date.now()}.tar.gz`;
        const target=path.posix.join(nodeStorageBase(node),'.qubiqohost-backups',String(srv.ownerId),filename);
        const job=startBackupWorker({...srv,folder},{...node},srv.ownerId,filename,target);
        return send(res,202,{pending:true,jobId:job.jobId,backupId:job.backupId,filename});
      }
      const adminBackupJob = p.match(/^\/api\/admin\/backups\/jobs\/([^/]+)$/);
      if (adminBackupJob && method === 'GET') {
        const st=readBackupJobStatus(adminBackupJob[1]);
        if(!st)return send(res,404,{error:'Job backup non trovato'});
        return send(res,200,st);
      }
      const adminBackupItem = p.match(/^\/api\/admin\/backups\/([^/]+)$/);
      if (adminBackupItem && method === 'DELETE') {
        const db=readDb();
        const b=db.backups.find(x=>x.id===adminBackupItem[1]);
        if(!b)return send(res,404,{error:'Backup non trovato'});
        const srvForBackup=db.servers.find(x=>x.id===b.serverId);
        const node=(db.nodes||[]).find(n=>String(n.id)===String(b.nodeId || srvForBackup?.nodeId));
        if(node&&b.path){try{rfs.remove(node,b.path);}catch(e){return send(res,502,{error:'Impossibile eliminare il backup remoto: '+e.message});}}
        withDb(db2=>{db2.backups=db2.backups.filter(x=>x.id!==b.id)});
        return send(res,200,{ok:true});
      }
      if (adminBackupItem && method === 'POST') {
        const body=await readJsonBody(req);
        if(body.action!=='restore')return send(res,400,{error:'Azione non valida'});
        const db=readDb();
        const b=db.backups.find(x=>x.id===adminBackupItem[1]);
        if(!b||!b.path)return send(res,404,{error:'Backup non trovato'});
        const srv=db.servers.find(x=>x.id===b.serverId);
        if(!srv)return send(res,404,{error:'Server associato non trovato'});
        const node=(db.nodes||[]).find(n=>String(n.id)===String(b.nodeId || srv.nodeId));
        if(!node)return send(res,503,{error:'Nodo VPS predefinito non disponibile'});
        const folder=serverStorageFolder({...srv,nodeId:node.id},db);
        const jobId=startBackupRestoreWorker({...srv,folder},{...node},b.path);
        if(!jobId)return send(res,500,{error:'Impossibile avviare il ripristino del backup'});
        return send(res,202,{pending:true,jobId});
      }
      const adminBackupDownload=p.match(/^\/api\/admin\/backups\/([^/]+)\/download$/);
      if(adminBackupDownload&&method==='GET'){
        const db=readDb();
        const b=db.backups.find(x=>x.id===adminBackupDownload[1]);
        if(!b||!b.path)return send(res,404,{error:'Backup non trovato'});
        const srvForBackup=db.servers.find(x=>x.id===b.serverId);
        const node=(db.nodes||[]).find(n=>String(n.id)===String(b.nodeId || srvForBackup?.nodeId));
        if(!node)return send(res,503,{error:'Nodo VPS non disponibile'});
        let size;
        try{size=rfs.remoteFileSize(node,b.path);}catch(e){return send(res,502,{error:'Backup non raggiungibile: '+e.message});}
        return rfs.streamRemoteFile(node,b.path,res,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${String(b.filename).replace(/"/g,'')}"`,'Content-Length':String(size)});
      }

      if (p === '/api/admin/nodes' && method === 'GET') {
        const db = readDb();
        const nodes = (db.nodes || []).map(node => {
          const userIds = Array.isArray(node.userIds) ? node.userIds : [];
          const assignedUsers = userIds.map(id => db.users.find(u => u.id === id)).filter(Boolean).map(u => ({ id: u.id, username: u.username, email: u.email || '' }));
          const serverCount = (db.servers || []).filter(s => s.nodeId === node.id).length;
          return { ...node, userIds, assignedUsers, serverCount, online: node.lastStatus === 'online' };
        });
        return send(res, 200, { nodes });
      }

      if (p === '/api/admin/nodes' && method === 'POST') {
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim().slice(0, 80);
        const host = String(body.host || '').trim();
        const port = Math.floor(Number(body.port || 22));
        const username = String(body.username || '').trim().slice(0, 64);
        const keyPath = String(body.keyPath || '').trim();
        const description = String(body.description || '').trim().slice(0, 240);
        const wantDefault = body.isDefault === true || body.isDefault === 'true' || body.isDefault === 1;
        if (!name || !host || !username || !keyPath || !Number.isInteger(port) || port < 1 || port > 65535) return send(res, 400, { error: 'Nome, host, porta, utente SSH e chiave privata sono obbligatori' });
        if (!fs.existsSync(keyPath)) return send(res, 400, { error: 'La chiave privata indicata non esiste sulla VPS del pannello' });
        let created;
        withDb(db => {
          if (db.nodes.some(n => String(n.host).toLowerCase() === host.toLowerCase() && Number(n.port) === port)) throw new Error('Esiste già un nodo con questo host e questa porta');
          const makeDefault = wantDefault || (db.nodes || []).length === 0;
          if (makeDefault) {
            for (const n of (db.nodes || [])) n.isDefault = false;
          }
          created = {
            id: crypto.randomUUID(),
            name, host, port, username, keyPath, description,
            userIds: [],
            isDefault: makeDefault,
            lastStatus: 'offline',
            lastCheckAt: null,
            lastError: null,
            createdAt: Date.now(),
          };
          db.nodes.push(created);
        });
        if (created.isDefault) {
          const stateAfterNode = readDb();
          let needsMigration = false;
          withDb(db => {
            for (const srv of (db.servers || [])) {
              if (!srv || String(srv.nodeId) === String(created.id)) continue;
              const oldNode = (db.nodes || []).find(x => x.id === srv.nodeId) || null;
              const oldFolder = srv.folder || (oldNode ? serverStorageFolder(srv, db) : '');
              srv.migrationFromNodeId = oldNode?.id || null;
              srv.migrationFromFolder = oldFolder;
              srv.migrationFromNodeSnapshot = oldNode ? { ...oldNode, userIds: [] } : null;
              srv.migrationTargetNodeId = created.id;
              srv.migrationStatus = 'pending';
              srv.nodeId = created.id;
              srv.folder = serverStorageFolder(srv, db);
              srv.status = 'stopped';
              needsMigration = true;
            }
          });
          if (needsMigration) startUserNodeMigration((stateAfterNode.users || []).map(u => String(u.id)), created.id);
        }
        void testNodeConnectionAsync(created).then(info => {
            withDb(db => {
              const n = db.nodes.find(x => x.id === created.id);
              if (n) { n.lastStatus = 'online'; n.lastCheckAt = Date.now(); n.lastError = null; n.system = info; }
            });
        }).catch(e => {
          withDb(db => { const n = db.nodes.find(x => x.id === created.id); if (n) { n.lastStatus = 'offline'; n.lastCheckAt = Date.now(); n.lastError = String(e.message || e).slice(0, 300); } });
        });
        return send(res, 200, { node: readDb().nodes.find(x => x.id === created.id) || created, testPending: true });
      }

      const adminNodeItem = p.match(/^\/api\/admin\/nodes\/([^/]+)$/);
      if (adminNodeItem && method === 'PATCH') {
        const body = await readJsonBody(req);
        let updated = null, sshUsernameChanged = false, becameDefault = false;
        withDb(db => {
          const n = db.nodes.find(x => x.id === adminNodeItem[1]);
          if (!n) return;
          if (typeof body.name === 'string' && body.name.trim()) n.name = body.name.trim().slice(0, 80);
          if (typeof body.host === 'string' && body.host.trim()) n.host = body.host.trim();
          if (Number.isInteger(Number(body.port)) && Number(body.port) >= 1 && Number(body.port) <= 65535) n.port = Number(body.port);
          if (typeof body.username === 'string' && body.username.trim()) {
            const nextUsername = body.username.trim().slice(0, 64);
            sshUsernameChanged = n.username !== nextUsername;
            n.username = nextUsername;
          }
          if (typeof body.keyPath === 'string' && body.keyPath.trim()) n.keyPath = body.keyPath.trim();
          if (typeof body.description === 'string') n.description = body.description.trim().slice(0, 240);
          if (body.isDefault === true || body.isDefault === 'true' || body.isDefault === 1) {
            becameDefault = !n.isDefault;
            for (const other of (db.nodes || [])) other.isDefault = false;
            n.isDefault = true;
            if (becameDefault) {
              for (const srv of (db.servers || [])) {
                if (!srv || String(srv.nodeId) === String(n.id)) continue;
                const oldNode = (db.nodes || []).find(x => x.id === srv.nodeId) || null;
                const oldFolder = srv.folder || (oldNode ? serverStorageFolder(srv, db) : '');
                srv.migrationFromNodeId = oldNode?.id || null;
                srv.migrationFromFolder = oldFolder;
                srv.migrationFromNodeSnapshot = oldNode ? { ...oldNode, userIds: [] } : null;
                srv.migrationTargetNodeId = n.id;
                srv.migrationStatus = 'pending';
                srv.nodeId = n.id;
                srv.folder = serverStorageFolder(srv, db);
                srv.status = 'stopped';
              }
            }
          } else if (body.isDefault === false || body.isDefault === 'false' || body.isDefault === 0) {
            n.isDefault = false;
          }
          updated = n;
        });
        if (!updated) return send(res, 404, { error: 'Nodo non trovato' });
        if (becameDefault) {
          const dbAfterDefault = readDb();
          const userIds = (dbAfterDefault.users || []).map(u => String(u.id));
          if (userIds.length) startUserNodeMigration(userIds, updated.id);
        }
        if (sshUsernameChanged) {
          const dbAfter = readDb();
          for (const srv of dbAfter.servers.filter(s => s.nodeId === updated.id)) {
            try { moveServerStorage(srv, dbAfter); } catch (e) {
              console.warn(`[storage] Migrazione nodo ${updated.name || updated.id}/${srv.id}: ${e.message}`);
            }
          }
          withDb(db => {
            for (const srv of db.servers || []) {
              if (srv.nodeId === updated.id) srv.folder = serverStorageFolder(srv, db);
            }
          });
        }
        const dbAfter = readDb();
        for (const userId of (updated.userIds || [])) {
          const u = dbAfter.users.find(x => x.id === userId);
          if (u) ensureUserStorageRoot(u, updated);
        }
        return send(res, 200, { node: readDb().nodes.find(x => x.id === updated.id) || updated });
      }

      const adminNodeUsers = p.match(/^\/api\/admin\/nodes\/([^/]+)\/users$/);
      if (adminNodeUsers && method === 'PATCH') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.userIds) ? [...new Set(body.userIds.map(String))] : [];
        let node = null;
        let assignedUserIds = [];
        let migrationNeeded = false;

        withDb(db => {
          node = db.nodes.find(x => x.id === adminNodeUsers[1]);
          if (!node) return;

          const valid = ids.filter(id => db.users.some(u => u.id === id));
          assignedUserIds = valid;

          for (const n of db.nodes) {
            if (n.id === node.id) continue;
            n.userIds = (Array.isArray(n.userIds) ? n.userIds : []).filter(id => !valid.includes(id));
          }
          node.userIds = valid;

          for (const server of db.servers || []) {
            if (!valid.includes(server.ownerId)) continue;

            if (server.nodeId !== node.id) {
              server.migrationFromNodeId = server.nodeId || null;
              server.migrationFromFolder = server.folder || '';
              server.migrationTargetNodeId = node.id;
              server.migrationStatus = 'pending';
              migrationNeeded = true;
            }
          }
        });

        if (!node) return send(res, 404, { error: 'Nodo non trovato' });

        let migrationJobId = null;
        if (migrationNeeded && assignedUserIds.length) {
          migrationJobId = startUserNodeMigration(assignedUserIds, node.id);

          if (!migrationJobId) {
            withDb(db => {
              for (const server of db.servers || []) {
                if (!assignedUserIds.includes(server.ownerId)) continue;
                if (server.migrationStatus !== 'pending') continue;

                server.nodeId = server.migrationFromNodeId || null;
                if (server.migrationFromFolder) server.folder = server.migrationFromFolder;
                delete server.migrationFromNodeId;
                delete server.migrationFromFolder;
                delete server.migrationTargetNodeId;
                delete server.migrationStatus;
              }
            });
            return send(res, 500, { error: 'Impossibile avviare la migrazione dei server' });
          }
        }

        const dbAfter = readDb();
        for (const userId of assignedUserIds) {
          const u = dbAfter.users.find(x => x.id === userId);
          if (u) {
            try { ensureUserStorageRoot(u, node); } catch (_) {}
          }
        }

        return send(res, 200, {
          node: readDb().nodes.find(x => x.id === node.id),
          movedUsers: assignedUserIds.length,
          movedServers: dbAfter.servers.filter(s =>
            assignedUserIds.includes(s.ownerId) &&
            (s.nodeId === node.id || s.migrationTargetNodeId === node.id)
          ).length,
          migrationJobId,
          message: migrationJobId
            ? 'Utenti assegnati. Migrazione dei server avviata in background.'
            : 'Utenti del nodo aggiornati.',
        });
      }

      const adminNodeTest = p.match(/^\/api\/admin\/nodes\/([^/]+)\/test$/);
      if (adminNodeTest && method === 'POST') {
        const node = readDb().nodes.find(x => x.id === adminNodeTest[1]);
        if (!node) return send(res, 404, { error: 'Nodo non trovato' });
        const nodeId = node.id;
        void testNodeConnectionAsync(node).then(info => {
          try {
            withDb(db => {
              const n = db.nodes.find(x => x.id === nodeId);
              if (n) { n.lastStatus = 'online'; n.lastCheckAt = Date.now(); n.lastError = null; n.system = info; }
            });
          } catch (e) { console.warn('[QubiqoHost] Aggiornamento stato nodo fallito:', e.message || e); }
        }).catch(e => {
          try {
            withDb(db => {
              const n = db.nodes.find(x => x.id === nodeId);
              if (n) { n.lastStatus = 'offline'; n.lastCheckAt = Date.now(); n.lastError = String(e.message || e).slice(0, 300); }
            });
          } catch (err) { console.warn('[QubiqoHost] Aggiornamento errore nodo fallito:', err.message || err); }
        });
        return send(res, 202, { ok: true, pending: true, message: 'Test SSH avviato in background' });
      }

      if (adminNodeItem && method === 'DELETE') {
        let removed = null;
        let targetNode = null;
        let migratedServerIds = [];
        let migratedUserIds = [];
        let migrationJobId = null;

        withDb(db => {
          const idx = db.nodes.findIndex(x => x.id === adminNodeItem[1]);
          if (idx === -1) return;

          const node = db.nodes[idx];
          const remaining = (db.nodes || []).filter(n => n.id !== node.id);
          targetNode = remaining.find(n => n.isDefault === true)
            || remaining.slice().sort((a,b) => (Number(a.createdAt)||0) - (Number(b.createdAt)||0))[0]
            || null;

          const ids = new Set((Array.isArray(node.userIds) ? node.userIds : []).map(String));
          for (const server of (db.servers || [])) {
            if (server.nodeId === node.id && server.ownerId) ids.add(String(server.ownerId));
          }
          migratedUserIds = [...ids].filter(id => db.users.some(u => String(u.id) === id));

          if (targetNode) {
            for (const n of (db.nodes || [])) {
              n.userIds = (Array.isArray(n.userIds) ? n.userIds : []).filter(id => !migratedUserIds.includes(String(id)));
            }
            targetNode.userIds = Array.isArray(targetNode.userIds) ? targetNode.userIds : [];
            for (const uid of migratedUserIds) {
              if (!targetNode.userIds.some(id => String(id) === uid)) targetNode.userIds.push(uid);
            }

            for (const server of (db.servers || [])) {
              if (server.nodeId !== node.id) continue;
              migratedServerIds.push(server.id);
              server.migrationFromNodeId = node.id;
              server.migrationFromFolder = server.folder || '';
              server.migrationFromNodeSnapshot = { ...node, userIds: [] };
              server.migrationTargetNodeId = targetNode.id;
              server.migrationStatus = 'pending';
              server.nodeId = targetNode.id;
              server.folder = serverStorageFolder(server, db);
              server.status = 'stopped';
            }
          } else {
            for (const server of (db.servers || [])) {
              if (server.nodeId !== node.id) continue;
              migratedServerIds.push(server.id);
              server.nodeId = null;
              delete server.folder;
              server.status = 'stopped';
            }
            for (const uid of migratedUserIds) {
              for (const n of (db.nodes || [])) {
                n.userIds = (Array.isArray(n.userIds) ? n.userIds : []).filter(id => String(id) !== uid);
              }
            }
          }

          db.nodes.splice(idx, 1);
          if (node.isDefault && db.nodes.length) {
            const next = targetNode || db.nodes.slice().sort((a,b) => (Number(a.createdAt)||0) - (Number(b.createdAt)||0))[0];
            for (const n of db.nodes) n.isDefault = n.id === next.id;
          }
          removed = node;
        });

        if (!removed) return send(res, 404, { error: 'Nodo non trovato' });

        if (targetNode && migratedServerIds.length) {
          migrationJobId = startUserNodeMigration(migratedUserIds, targetNode.id);
        }

        auditEvent(req, user, 'admin', 'Eliminazione forzata nodo',
          `Rimosso nodo ${removed.name || removed.id}; ${migratedServerIds.length} server trasferiti verso ${targetNode?.name || 'nessun nodo'}`);

        return send(res, 200, {
          ok: true,
          forced: true,
          removedServers: migratedServerIds.length,
          movedServers: migratedServerIds.length,
          movedUsers: migratedUserIds.length,
          targetNodeId: targetNode?.id || null,
          targetNodeName: targetNode?.name || null,
          migrationJobId,
          message: targetNode
            ? `Nodo eliminato. ${migratedServerIds.length} server e ${migratedUserIds.length} utenti trasferiti a ${targetNode.name}; i file vengono migrati in background.`
            : 'Nodo eliminato. I server sono rimasti nel pannello senza nodo e possono essere riassegnati a un nuovo nodo.',
        });
      }

      if (p === '/api/admin/databases' && method === 'GET') { const db=readDb(); return send(res,200,{databases:(db.databases||[]).map(x=>{const u=db.users.find(y=>y.id===x.ownerId);return {...x,ownerUsername:u?.username||'—',ownerEmail:u?.email||'—'}})}); }
      if (p === '/api/admin/databases' && method === 'POST') { const body=await readJsonBody(req); const name=String(body.name||'').trim().replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40); const ownerId=String(body.ownerId||''); if(!name) return send(res,400,{error:'Nome database non valido'}); const state=readDb(); if(!state.users.some(u=>u.id===ownerId)) return send(res,400,{error:'Utente non trovato'}); let created=null; withDb(db=>{if(db.databases.some(x=>x.name.toLowerCase()===name.toLowerCase()&&x.ownerId===ownerId))return;created={id:crypto.randomUUID(),ownerId,name,type:'MySQL 8.0',username:`qh_${crypto.randomBytes(3).toString('hex')}`,sizeMB:0,createdAt:Date.now()};db.databases.push(created)}); if(!created)return send(res,409,{error:'Database già esistente'}); return send(res,200,{database:created}); }
      const adminDbItem=p.match(/^\/api\/admin\/databases\/([^/]+)$/);
      if(adminDbItem&&method==='PATCH'){const body=await readJsonBody(req);let item=null;withDb(db=>{item=db.databases.find(x=>x.id===adminDbItem[1]);if(item&&body.name)item.name=String(body.name).trim().replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40)});if(!item)return send(res,404,{error:'Database non trovato'});return send(res,200,{database:item});}
      if(adminDbItem&&method==='DELETE'){withDb(db=>{db.databases=db.databases.filter(x=>x.id!==adminDbItem[1])});return send(res,200,{ok:true});}

      if (p === '/api/admin/network' && method === 'GET') { const db=readDb(); return send(res,200,{network:(db.network||[]).map(x=>{const u=db.users.find(y=>y.id===x.ownerId);return {...x,ownerUsername:u?.username||'—',ownerEmail:u?.email||'—'}})}); }
      if (p === '/api/admin/network' && method === 'POST') { const body=await readJsonBody(req); const ownerId=String(body.ownerId||''); const port=Math.floor(Number(body.port)); const protocol=String(body.protocol||'TCP').toUpperCase(); if(!readDb().users.some(u=>u.id===ownerId))return send(res,400,{error:'Utente non trovato'}); if(!Number.isInteger(port)||port<1||port>65535||!['TCP','UDP'].includes(protocol))return send(res,400,{error:'Porta o protocollo non valido'});let rule;withDb(db=>{rule={id:crypto.randomUUID(),ownerId,port,protocol,service:String(body.service||'Custom').slice(0,50),enabled:body.enabled!==false,createdAt:Date.now()};db.network.push(rule)});return send(res,200,{rule}); }
      const adminNetItem=p.match(/^\/api\/admin\/network\/([^/]+)$/);
      if(adminNetItem&&method==='PATCH'){const body=await readJsonBody(req);let rule=null;withDb(db=>{rule=db.network.find(x=>x.id===adminNetItem[1]);if(rule){if(typeof body.enabled==='boolean')rule.enabled=body.enabled;if(body.port)rule.port=Math.floor(Number(body.port));if(body.protocol&&['TCP','UDP'].includes(String(body.protocol).toUpperCase()))rule.protocol=String(body.protocol).toUpperCase();if(body.service!==undefined)rule.service=String(body.service).slice(0,50)}});if(!rule)return send(res,404,{error:'Regola non trovata'});return send(res,200,{rule});}
      if(adminNetItem&&method==='DELETE'){withDb(db=>{db.network=db.network.filter(x=>x.id!==adminNetItem[1])});return send(res,200,{ok:true});}

      if (p === '/api/admin/tickets' && method === 'GET') { const db=readDb(); const tickets=(db.tickets||[]).slice().sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0)).map(t=>{const u=db.users.find(x=>x.id===t.ownerId);return {...t,ownerUsername:u?.username||'—',ownerEmail:u?.email||'—'}}); return send(res,200,{tickets}); }
      const adminTicketItem=p.match(/^\/api\/admin\/tickets\/([^/]+)$/);
      if(adminTicketItem&&method==='PATCH'){const body=await readJsonBody(req);let ticket=null;withDb(db=>{ticket=db.tickets.find(x=>x.id===adminTicketItem[1]);if(ticket){if(['open','pending','closed'].includes(body.status))ticket.status=body.status;if(typeof body.message==='string'&&body.message.trim()){ticket.messages ||= [];ticket.messages.push({id:crypto.randomUUID(),author:user.username,role:'staff',content:body.message.trim(),createdAt:Date.now()});}ticket.updatedAt=Date.now()}});if(!ticket)return send(res,404,{error:'Ticket non trovato'});if(typeof body.message==='string'&&body.message.trim()&&ticket.discordChannelId){try{await sendDiscordTicketMessage(ticket.discordChannelId,ticket,user.username,body.message.trim())}catch(e){console.warn('Discord ticket admin reply:',e.message)}}return send(res,200,{ticket});}

      if (p === '/api/admin/billing' && method === 'GET') {
        const db = readDb();
        const billing = getBillingConfig(db);
        return send(res, 200, {
          settings: billing.settings,
          packages: getCreditPackages(db),
          coupons: billing.coupons.slice().sort((a,b)=>b.createdAt-a.createdAt),
          transactions: billing.transactions.slice().sort((a,b)=>b.createdAt-a.createdAt).slice(0,100),
        });
      }

      if (p === '/api/admin/billing/settings' && method === 'PATCH') {
        const body = await readJsonBody(req);
        let settings;
        withDb(db => {
          const billing = getBillingConfig(db);
          const cost = Math.floor(Number(body.slotCreditCost));
          if (!Number.isFinite(cost) || cost < 1 || cost > 1000000) throw new Error('Costo slot non valido');
          billing.settings.slotCreditCost = cost;
          settings = billing.settings;
        });
        return send(res, 200, { settings });
      }

      if (p === '/api/admin/billing/packages' && method === 'POST') {
        const body = await readJsonBody(req);
        const label = String(body.label || '').trim();
        const credits = Math.floor(Number(body.credits));
        const amountCents = Math.floor(Number(body.amountCents));
        if (!label || label.length > 80 || !Number.isFinite(credits) || credits < 1 || !Number.isFinite(amountCents) || amountCents < 50) {
          return send(res, 400, { error: 'Dati piano non validi' });
        }
        let created;
        withDb(db => {
          const billing = getBillingConfig(db);
          created = { id: `credits_${crypto.randomUUID()}`, label, credits, amountCents };
          billing.packages.push(created);
        });
        return send(res, 200, { package: created });
      }

      const adminBillingPackage = p.match(/^\/api\/admin\/billing\/packages\/([^/]+)$/);
      if (adminBillingPackage && method === 'PATCH') {
        const body = await readJsonBody(req);
        let updated = null;
        withDb(db => {
          const billing = getBillingConfig(db);
          const pkg = billing.packages.find(x => x.id === adminBillingPackage[1]);
          if (!pkg) return;
          if (body.label !== undefined) {
            const label = String(body.label).trim();
            if (!label || label.length > 80) throw new Error('Nome piano non valido');
            pkg.label = label;
          }
          if (body.credits !== undefined) {
            const credits = Math.floor(Number(body.credits));
            if (!Number.isFinite(credits) || credits < 1) throw new Error('Crediti non validi');
            pkg.credits = credits;
          }
          if (body.amountCents !== undefined) {
            const amountCents = Math.floor(Number(body.amountCents));
            if (!Number.isFinite(amountCents) || amountCents < 50) throw new Error('Prezzo non valido');
            pkg.amountCents = amountCents;
          }
          updated = pkg;
        });
        if (!updated) return send(res, 404, { error: 'Piano non trovato' });
        return send(res, 200, { package: updated });
      }

      if (adminBillingPackage && method === 'DELETE') {
        let removed = false;
        withDb(db => {
          const billing = getBillingConfig(db);
          const before = billing.packages.length;
          billing.packages = billing.packages.filter(x => x.id !== adminBillingPackage[1]);
          removed = billing.packages.length !== before;
        });
        if (!removed) return send(res, 404, { error: 'Piano non trovato' });
        return send(res, 200, { ok: true });
      }

      if (p === '/api/admin/billing/coupons' && method === 'POST') {
        const body = await readJsonBody(req);
        const code = String(body.code || '').trim().toUpperCase();
        const type = body.type === 'slots' ? 'slots' : 'credits';
        const amount = Math.floor(Number(body.amount));
        const maxUses = Math.floor(Number(body.maxUses));
        if (!code || !/^[A-Z0-9_-]{3,32}$/.test(code)) {
          return send(res, 400, { error: 'Codice non valido (3-32 caratteri, lettere/numeri/-/_)' });
        }
        if (!Number.isFinite(amount) || amount < 1) {
          return send(res, 400, { error: 'Quantità non valida' });
        }
        if (!Number.isFinite(maxUses) || maxUses < 1) {
          return send(res, 400, { error: 'Limite utilizzi non valido' });
        }
        let created;
        let error;
        withDb(db => {
          const billing = getBillingConfig(db);
          if (billing.coupons.some(c => c.code === code)) {
            error = 'Esiste già un coupon con questo codice';
            return;
          }
          created = {
            id: crypto.randomUUID(),
            code,
            type,
            amount,
            maxUses,
            usedCount: 0,
            usedBy: [],
            enabled: true,
            createdAt: Date.now(),
          };
          billing.coupons.push(created);
        });
        if (error) return send(res, 400, { error });
        return send(res, 200, { coupon: created });
      }

      const adminBillingCoupon = p.match(/^\/api\/admin\/billing\/coupons\/([^/]+)$/);
      if (adminBillingCoupon && method === 'PATCH') {
        const body = await readJsonBody(req);
        let updated = null;
        let error;
        withDb(db => {
          const billing = getBillingConfig(db);
          const coupon = billing.coupons.find(x => x.id === adminBillingCoupon[1]);
          if (!coupon) return;
          if (body.maxUses !== undefined) {
            const maxUses = Math.floor(Number(body.maxUses));
            if (!Number.isFinite(maxUses) || maxUses < 1) { error = 'Limite utilizzi non valido'; return; }
            coupon.maxUses = maxUses;
          }
          if (body.enabled !== undefined) {
            coupon.enabled = Boolean(body.enabled);
          }
          updated = coupon;
        });
        if (error) return send(res, 400, { error });
        if (!updated) return send(res, 404, { error: 'Coupon non trovato' });
        return send(res, 200, { coupon: updated });
      }

      if (adminBillingCoupon && method === 'DELETE') {
        let removed = false;
        withDb(db => {
          const billing = getBillingConfig(db);
          const before = billing.coupons.length;
          billing.coupons = billing.coupons.filter(x => x.id !== adminBillingCoupon[1]);
          removed = billing.coupons.length !== before;
        });
        if (!removed) return send(res, 404, { error: 'Coupon non trovato' });
        return send(res, 200, { ok: true });
      }

      if (p === '/api/admin/servers' && method === 'POST') {
        const body = await readJsonBody(req);
        const ownerId = String(body.ownerId || '');
        const owner = readDb().users.find(u => u.id === ownerId);
        const name = String(body.name || '').trim();
        const language = body.language;
        const botToken = String(body.botToken || '').trim();
        if (!owner) return send(res, 400, { error: 'Utente proprietario non trovato' });
        if (!name || !['nodejs','python'].includes(language) || !botToken) return send(res, 400, { error: 'Nome, runtime e token sono obbligatori' });
        let state = readDb();
        const count = state.servers.filter(s => s.ownerId === ownerId).length;
        const slots = Number.isFinite(owner.slots) ? owner.slots : DEFAULT_SLOTS;
        if (count >= slots) return send(res, 400, { error: `L'utente ha raggiunto il limite di ${slots} slot` });
        const ownerNode = getDefaultNode(state);
        if (!ownerNode) return send(res, 503, { error: 'Nessun nodo VPS predefinito è collegato al pannello. Configura e imposta un nodo predefinito prima di creare server.' });
        const srv = { id: crypto.randomUUID(), ownerId, nodeId: ownerNode.id, name, language, ramMB: Number(body.ramMB) > 0 ? Number(body.ramMB) : RAM_PRESET_MB, cpuCores: CPU_PRESET_CORES, status:'stopped', suspended:false, createdAt:Date.now() };
        const targetFolder = serverStorageFolder(srv, state);
        srv.folder = targetFolder;
        const ops = fileOps(ownerNode);
        try {
          ops.mkdir(targetFolder);
          const envTarget = path.posix.join(targetFolder, '.env');
          ops.writeFile(envTarget, `${language === "nodejs" ? "DISCORD_TOKEN" : "BOT_TOKEN"}=${JSON.stringify(botToken)}\n`);
          rfs.sshRun(ownerNode, `chmod 600 ${rfs.q(envTarget)}`, { timeout: 8000 });
          const tpl = language === 'nodejs' ? templates.nodeTemplate() : templates.pythonTemplate();
          for (const [fname, content] of Object.entries(tpl)) ops.writeFile(path.posix.join(targetFolder, fname), content);
          withDb(db => db.servers.push(srv));
        } catch (e) {
          try { rfs.remove(ownerNode, targetFolder); } catch (_) {}
          return send(res, 502, { error: 'Impossibile creare il server sul nodo predefinito: ' + (e.message || e) });
        }
        return send(res,200,{server:safeServer(srv, state)});
      }

      if (p === '/api/admin/servers' && method === 'GET') {
        // Sincronizza sempre lo stato runtime prima di mostrarlo nell'area Admin.
        // Il worker aggiorna runtime-stats.json periodicamente.
        refreshAllRuntimeStats();
        const db = readDb();
        const withOwner = db.servers.map(s => {
          const owner = db.users.find(u => u.id === s.ownerId);
          return {
            ...safeServer(s, db),
            ownerUsername: owner ? owner.username : '—',
            ownerEmail: owner ? owner.email : '—',
            ownerPin: owner ? owner.pin : '—',
          };
        });
        return send(res, 200, { servers: withOwner });
      }

      const adminServerItemMatch = p.match(/^\/api\/admin\/servers\/([^/]+)$/);
      if (adminServerItemMatch && method === 'PATCH') {
        const body = await readJsonBody(req);
        let updated = null;
        let suspendNode = null;
        let suspendSnapshot = null;
        let storageMigrationPending = false;
        let storageMigrationOwnerId = null;
        withDb(db => {
          const s = db.servers.find(x => x.id === adminServerItemMatch[1]);
          if (!s) return;
          const oldNode = s.nodeId ? (db.nodes || []).find(n => n.id === s.nodeId) : null;
          const oldFolder = s.folder || (oldNode ? serverStorageFolder(s, db) : '');
          if (typeof body.name === 'string' && body.name.trim()) s.name = body.name.trim().slice(0, 80);
          if (typeof body.ownerId === 'string' && db.users.some(u => u.id === body.ownerId)) s.ownerId = body.ownerId;
          const defaultNode = getDefaultNode(db);
          const targetFolder = defaultNode ? serverStorageFolder({ ...s, nodeId: defaultNode.id }, db) : null;
          if (defaultNode && oldNode && (String(oldNode.id) !== String(defaultNode.id) || oldFolder !== targetFolder)) {
            s.migrationFromNodeId = oldNode.id;
            s.migrationFromFolder = oldFolder;
            s.migrationFromNodeSnapshot = { ...oldNode, userIds: [] };
            s.migrationTargetNodeId = defaultNode.id;
            s.migrationStatus = 'pending';
            s.nodeId = defaultNode.id;
            s.folder = targetFolder;
            s.status = 'stopped';
            storageMigrationPending = true;
            storageMigrationOwnerId = s.ownerId;
          } else if (defaultNode) {
            s.nodeId = defaultNode.id;
            s.folder = targetFolder;
          }
          if (typeof body.botToken === 'string' && body.botToken.trim()) s.botToken = body.botToken.trim();
          if (Number.isFinite(body.ramMB) && body.ramMB > 0) s.ramMB = body.ramMB;
          s.cpuCores = CPU_PRESET_CORES;
          if (typeof body.suspended === 'boolean') {
            s.suspended = body.suspended;
            if (body.suspended) { suspendNode = getServerNode(s, db); suspendSnapshot = { ...s, folder: serverFolder(s) }; }
          }
          updated = s;
        });
        if (!updated) return send(res, 404, { error: 'Server non trovato' });
        if (suspendSnapshot && suspendNode) startPmActionWorker('stop', suspendSnapshot, { ...suspendNode }, { previousRunning: true });
        if (storageMigrationPending) {
          startUserNodeMigration([storageMigrationOwnerId], getDefaultNode(readDb()).id);
        } else {
          try {
            const dbAfter = readDb();
            moveServerStorage(updated, dbAfter);
            withDb(db => {
              const fresh = db.servers.find(x => x.id === updated.id);
              if (fresh) fresh.folder = serverStorageFolder(fresh, db);
            });
          } catch (e) {
            return send(res, 500, { error: `Impossibile aggiornare la cartella del server: ${e.message}` });
          }
        }
        const dbFinal = readDb();
        return send(res, 200, { server: safeServer(dbFinal.servers.find(x => x.id === updated.id) || updated, dbFinal) });
      }

      if (adminServerItemMatch && method === 'DELETE') {
        let removed = null;
        let removedNode = null;
        const dbBefore = readDb();
        const removedBackups = dbBefore.backups?.filter(b => b.serverId === adminServerItemMatch[1]) || [];
        withDb(db => {
          const s = db.servers.find(x => x.id === adminServerItemMatch[1]);
          if (s) { removed = s; removedNode = getServerNode(s, db); }
          db.servers = db.servers.filter(x => x.id !== adminServerItemMatch[1]);
          db.backups = (db.backups || []).filter(b => b.serverId !== adminServerItemMatch[1]);
        });
        if (removed) {
          if (removedNode) startPmActionWorker('delete', { ...removed, folder: serverFolder(removed) }, { ...removedNode });
        }
        for (const backup of removedBackups) { try { const node=(dbBefore.nodes||[]).find(n=>n.id===backup.nodeId)||getDefaultNode(dbBefore); if(node&&backup.path) rfs.remove(node,backup.path); } catch (_) {} }
        return send(res, 200, { ok: true });
      }
    }

    return send(res, 404, { error: 'Endpoint non trovato' });
  } catch (err) {
    console.error(err);
    if (err?.code === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: err.message });
    return send(res, 500, { error: 'Errore interno: ' + err.message });
  }
});

async function stopAllServersForMaintenance() {
  const db = readDb();
  const servers = Array.isArray(db.servers) ? db.servers.filter(s => s && s.nodeId && s.folder) : [];
  if (!servers.length) {
    console.log('[QubiqoHost] Manutenzione: nessun server da arrestare.');
    return;
  }

  console.log(`[QubiqoHost] Manutenzione: arresto forzato di ${servers.length} server...`);

  const results = await Promise.all(servers.map(async server => {
    try {
      const node = getServerNode(server, db);
      if (!node) throw new Error('Nodo assegnato non disponibile');
      const result = await new Promise(resolve => {
        setImmediate(() => {
          try { resolve(pm.stop({ ...server, folder: serverFolder(server) }, node)); }
          catch (err) { resolve({ ok: false, error: err.message }); }
        });
      });
      runtimeStatusCache.set(serverStatusKey(server), { running: false, updatedAt: Date.now(), pending: false, action: 'maintenance-stop' });
      withDb(db2 => {
        const current = db2.servers.find(x => x.id === server.id);
        if (current) current.status = 'stopped';
      });
      if (result.ok) {
        console.log(`[QubiqoHost] ✓ Manutenzione: ${server.name} arrestato.`);
      } else {
        console.error(`[QubiqoHost] ✗ Manutenzione: ${server.name} non confermato offline: ${result.error || 'errore sconosciuto'}`);
      }
      return { server, ok: !!result.ok };
    } catch (err) {
      runtimeStatusCache.set(serverStatusKey(server), { running: false, updatedAt: Date.now(), pending: false, action: 'maintenance-stop' });
      withDb(db2 => {
        const current = db2.servers.find(x => x.id === server.id);
        if (current) current.status = 'stopped';
      });
      console.error(`[QubiqoHost] ✗ Manutenzione: errore arrestando ${server.name}: ${err.message || err}`);
      return { server, ok: false };
    }
  }));

  const stopped = results.filter(r => r.ok).length;
  console.log(`[QubiqoHost] Manutenzione: ${stopped}/${results.length} server confermati offline.`);
}

function startMaintenanceEnforcement() {
  let running = false;
  const enforce = async () => {
    if (running || !PANEL_MAINTENANCE) return;
    running = true;
    try { await stopAllServersForMaintenance(); } catch (err) { console.error('[QubiqoHost] Manutenzione: controllo arresto fallito:', err.message || err); }
    finally { running = false; }
  };
  enforce();
  return setInterval(enforce, 30000);
}

async function restorePersistedServers() {
  if (PANEL_MAINTENANCE) {
    console.log('[QubiqoHost] Manutenzione attiva: ripristino automatico dei bot disabilitato.');
    return;
  }
  const CPU_ON_STARTUP = 0.5;
  const db = readDb();
  const servers = Array.isArray(db.servers) ? db.servers : [];

  if (servers.length) {
    let changed = false;
    for (const server of servers) {
      if (!server || Number(server.cpuCores) === CPU_ON_STARTUP) continue;
      server.cpuCores = CPU_ON_STARTUP;
      delete server.cpuPercent;
      changed = true;
    }
    if (changed) {
      withDb(db2 => {
        for (const server of db2.servers) {
          if (server) {
            server.cpuCores = CPU_ON_STARTUP;
            delete server.cpuPercent;
          }
        }
      });
      console.log(`[QubiqoHost] CPU impostata a ${CPU_ON_STARTUP} CPU per ${servers.length} server.`);
    }
  }
  const candidates = servers.filter(s => s && !s.suspended && s.nodeId && s.status === 'running');

  const skippedNoNode = servers.filter(s => s && !s.suspended && s.status === 'running' && !s.nodeId);
  for (const s of skippedNoNode) {
    console.error(`[QubiqoHost] ✗ ${s.name} risultava attivo ma non ha un nodeId assegnato: non verrà riavviato automaticamente.`);
  }

  if (!candidates.length) return;

  console.log(`[QubiqoHost] Riavvio pannello: ripristino di ${candidates.length} bot sui rispettivi nodi...`);

  await Promise.all(candidates.map(async srv => {
    try {
      const node = getServerNode(srv, db);
      const result = await new Promise(resolve => {
        setImmediate(() => {
          try {
            resolve(pm.start({ ...srv, folder: serverFolder(srv) }, node));
          } catch (err) {
            resolve({ ok: false, error: err.message });
          }
        });
      });

      if (result.ok) {
        runtimeStatusCache.set(serverStatusKey(srv), { running: true, updatedAt: Date.now() });
        withDb(db2 => {
          const current = db2.servers.find(x => x.id === srv.id);
          if (current) current.status = 'running';
        });
        console.log(`[QubiqoHost] ✓ Server ripristinato: ${srv.name}`);
      } else {
        runtimeStatusCache.set(serverStatusKey(srv), { running: false, updatedAt: Date.now() });
        withDb(db2 => {
          const current = db2.servers.find(x => x.id === srv.id);
          if (current) current.status = 'stopped';
        });
        console.error(`[QubiqoHost] ✗ Impossibile ripristinare ${srv.name}: ${result.error}`);
      }
    } catch (err) {
      runtimeStatusCache.set(serverStatusKey(srv), { running: false, updatedAt: Date.now() });
      withDb(db2 => {
        const current = db2.servers.find(x => x.id === srv.id);
        if (current) current.status = 'stopped';
      });
      console.error(`[QubiqoHost] ✗ Errore ripristino ${srv.name}: ${err.message}`);
    }
  }));
}

const activeBackupJobs = new Map();

function backupStatusFile(jobId) {
  return path.join(DATA_DIR, 'backup-jobs', `${jobId}.json`);
}

function readBackupJobStatus(jobId) {
  try {
    return JSON.parse(fs.readFileSync(backupStatusFile(jobId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function startBackupWorker(serverSnapshot, nodeSnapshot, ownerId, filename, remoteTarget) {
  const jobId = crypto.randomUUID();
  const workerPath = path.join(__dirname, 'backup-worker.js');
  const backupId = crypto.randomUUID();
  const job = { jobId, backupId, ownerId, filename, remoteTarget, folder: serverSnapshot.folder, server: serverSnapshot, node: nodeSnapshot };
  const child = fork(workerPath, [], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, QH_BACKUP_JOB: JSON.stringify(job) },
  });
  child.unref();
  activeBackupJobs.set(jobId, child.pid);
  setTimeout(() => activeBackupJobs.delete(jobId), 24 * 60 * 60 * 1000).unref?.();
  return { jobId, backupId };
}

function startBackupRestoreWorker(serverSnapshot, nodeSnapshot, remoteBackupPath) {
  const jobId = crypto.randomUUID();
  const workerPath = path.join(__dirname, 'backup-restore-worker.js');
  const folder = String(serverSnapshot?.folder || '');
  const backupPath = String(remoteBackupPath || '');
  const node = { ...nodeSnapshot };

  if (!node.host || !folder || !backupPath) {
    console.error('[QubiqoHost] Restore backup non avviato: parametri mancanti', {
      jobId,
      serverId: serverSnapshot?.id || null,
      host: node.host || null,
      folder,
      remoteBackupPath: backupPath
    });
    return null;
  }

  const restoreJob = {
    jobId,
    server: { ...serverSnapshot, folder },
    node,
    folder,
    remoteBackupPath: backupPath
  };

  const child = fork(workerPath, [], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      QH_BACKUP_RESTORE_JOB: JSON.stringify(restoreJob)
    },
  });

  child.unref();
  return jobId;
}
const activePmJobs = new Map();

function startPmActionWorker(action, serverSnapshot, nodeSnapshot, extra = {}) {
  const workerPath = path.join(__dirname, 'pm-action-worker.js');
  if (!fs.existsSync(workerPath)) return null;
  const serverId = String(serverSnapshot?.id || '');
  const active = serverId ? activePmJobs.get(serverId) : null;
  if (active) return active;
  const jobId = crypto.randomUUID();
  if (serverId) activePmJobs.set(serverId, jobId);
  try {
    const child = fork(workerPath, [], {
      cwd: __dirname,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        QH_PM_ACTION: JSON.stringify({ jobId, action, server: serverSnapshot, node: nodeSnapshot, ...extra }),
      },
    });
    let settled = false;
    child.on('message', msg => {
      settled = true;
      if (serverId && activePmJobs.get(serverId) === jobId) activePmJobs.delete(serverId);
      try {
        const ok = !!msg?.ok;
        withDb(db2 => {
          const current = db2.servers.find(x => x.id === String(serverSnapshot.id));
          if (!current) return;
          if (action === 'start' || action === 'restart') current.status = ok ? 'running' : (extra.previousRunning ? 'running' : 'stopped');
          if (action === 'stop') current.status = ok ? 'stopped' : (extra.previousRunning ? 'running' : current.status);
        });
        const key = serverStatusKey(serverSnapshot);
        const fallbackRunning = !!extra.previousRunning;
        if (action === 'start' || action === 'restart' || action === 'stop') runtimeStatusCache.set(key, { running: ok ? (action === 'stop' ? false : true) : fallbackRunning, updatedAt: Date.now(), pending: false, action });
      } catch (_) {}
    });
    child.on('error', () => { if (serverId && activePmJobs.get(serverId) === jobId) activePmJobs.delete(serverId); });
    child.on('exit', () => {
      if (serverId && activePmJobs.get(serverId) === jobId) activePmJobs.delete(serverId);
      if (settled || !serverId || !['start','stop','restart'].includes(action)) return;
      try {
        withDb(db2 => {
          const current = db2.servers.find(x => x.id === serverId);
          if (current && (action === 'start' || action === 'restart')) current.status = extra.previousRunning ? 'running' : 'stopped';
          if (current && action === 'stop') current.status = extra.previousRunning ? 'running' : current.status;
        });
        runtimeStatusCache.set(serverId, { running: !!extra.previousRunning, updatedAt: Date.now(), pending: false, action });
      } catch (_) {}
    });
    child.unref();
    return jobId;
  } catch (e) {
    if (serverId && activePmJobs.get(serverId) === jobId) activePmJobs.delete(serverId);
    console.error('[QubiqoHost] worker azione server:', e.message || e);
    return null;
  }
}

function startUserNodeMigration(userIds, targetNodeId) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length || !targetNodeId) return null;
  const jobId = crypto.randomUUID();
  const jobPath = path.join(DATA_DIR, `node-migration-${jobId}.json`);
  try {
    const child = fork(path.join(__dirname, 'user-node-migration-worker.js'), [], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        QH_NODE_MIGRATION_JOB: JSON.stringify({ jobId, userIds: ids, targetNodeId, jobPath }),
      },
    });
    child.unref();
    console.log(`[QubiqoHost] Migrazione utente/server avviata in background (job ${jobId}, PID ${child.pid}).`);
    return jobId;
  } catch (e) {
    console.error('[QubiqoHost] Impossibile avviare migrazione utenti/server:', e.message || e);
    return null;
  }
}

function startRestoreWorker() {
  const workerPath = path.join(__dirname, 'restore-worker.js');

  if (!fs.existsSync(workerPath)) {
    console.error('[QubiqoHost] restore-worker.js non trovato: ripristino automatico disabilitato.');
    return;
  }

  try {
    const child = fork(workerPath, [], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    console.log(`[QubiqoHost] Ripristino bot avviato in background (worker PID ${child.pid}).`);
  } catch (err) {
    console.error('[QubiqoHost] Impossibile avviare il worker di ripristino:', err.message || err);
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[QubiqoHost] Ricevuto ${signal}: arresto del solo pannello...`);
  console.log('[QubiqoHost] I bot attivi non vengono arrestati.');

  setTimeout(() => process.exit(0), 250);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function startStorageMigrationWorker() {
  try {
    const child = fork(__filename, [], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, QH_STORAGE_MIGRATION_WORKER: '1' },
    });
    child.unref();
    console.log(`[QubiqoHost] Migrazione storage avviata in background (worker PID ${child.pid}).`);
  } catch (err) {
    console.error('[QubiqoHost] Impossibile avviare il worker storage:', err.message || err);
  }
}

function startRuntimeStatsWorker() {
  const workerPath = path.join(__dirname, 'runtime-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.error('[QubiqoHost] runtime-worker.js non trovato: statistiche runtime disabilitate.');
    return;
  }
  try {
    const child = fork(workerPath, [], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    console.log(`[QubiqoHost] Monitoraggio runtime avviato in background (worker PID ${child.pid}).`);
  } catch (err) {
    console.error('[QubiqoHost] Impossibile avviare il worker runtime:', err.message || err);
  }
}

function resumePendingNodeMigrations() {
  try {
    const db = readDb();
    const groups = new Map();
    for (const server of (db.servers || [])) {
      if (!server || server.migrationStatus !== 'pending' || !server.migrationTargetNodeId) continue;
      const key = String(server.migrationTargetNodeId);
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(String(server.ownerId));
    }
    for (const [targetNodeId, ids] of groups) {
      startUserNodeMigration([...ids], targetNodeId);
    }
  } catch (e) {
    console.error('[QubiqoHost] Impossibile riprendere le migrazioni pendenti:', e.message || e);
  }
}

function monitorNodeMigrationStatus() {
  const files = () => {
    try {
      return fs.readdirSync(DATA_DIR)
        .filter(name => /^node-migration-[a-f0-9-]+\.json$/.test(name))
        .map(name => path.join(DATA_DIR, name));
    } catch (_) { return []; }
  };

  return setInterval(() => {
    for (const file of files()) {
      try {
        const st = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!['completed', 'completed_with_errors', 'error'].includes(st.state)) continue;
        const results = Array.isArray(st.results) ? st.results : [];
        if (!results.length && st.state !== 'error') continue;

        withDb(db => {
          for (const result of results) {
            const server = (db.servers || []).find(s => s.id === result.id);
            if (!server || server.migrationStatus !== 'pending') continue;

            if (result.ok) {
              server.nodeId = result.targetNodeId || server.migrationTargetNodeId || server.nodeId;
              server.folder = result.folder;
              delete server.migrationFromNodeId;
              delete server.migrationFromFolder;
              delete server.migrationFromNodeSnapshot;
              delete server.migrationTargetNodeId;
              delete server.migrationStatus;
            } else {
              server.nodeId = result.oldNodeId || null;
              if (result.oldFolder) server.folder = result.oldFolder;
              delete server.migrationFromNodeId;
              delete server.migrationFromFolder;
              delete server.migrationFromNodeSnapshot;
              delete server.migrationTargetNodeId;
              delete server.migrationStatus;
            }
          }
        });

        if (Date.now() - Number(st.updatedAt || 0) > 24 * 60 * 60 * 1000) {
          try { fs.unlinkSync(file); } catch (_) {}
        }
      } catch (_) {}
    }
  }, 2000);
}

function monitorRestoreStatus() {
  const statusFile = path.join(DATA_DIR, 'restore-status.json');
  let lastKey = '';
  return setInterval(() => {
    try {
      if (!fs.existsSync(statusFile)) return;
      const st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      const key = `${st.state}|${st.completed}|${st.online}|${st.failed}|${st.current?.id || ''}`;
      if (key === lastKey) return;
      lastKey = key;
      if (st.state === 'running') {
        const current = st.current?.name ? ` — ${st.current.name}` : '';
        console.log(`[QubiqoHost] Ripristino: ${st.completed}/${st.total} completati, ${st.online} online, ${st.failed} falliti${current}`);
      } else if (st.state === 'completed') {
        console.log(`[QubiqoHost] ✓ Ripristino completato: ${st.online}/${st.total} bot online, ${st.failed} non avviati.`);
      } else if (st.state === 'error') {
        console.error(`[QubiqoHost] ✗ Ripristino terminato con errore: ${st.error || 'errore sconosciuto'}`);
      }
    } catch (_) {}
  }, 2000);
}

if (process.env.QH_STORAGE_MIGRATION_WORKER === '1') {
  try {
    migrateAllServerStorage();
    migrateLegacyBackups();
    process.exit(0);
  } catch (e) {
    console.error('[QubiqoHost] Errore migrazione storage:', e.message || e);
    process.exit(1);
  }
}

server.listen(PORT, async () => {
  console.log(`QubiqoHost in ascolto su http://localhost:${PORT}`);

  if (PANEL_MAINTENANCE) {
    await stopAllServersForMaintenance();
    startMaintenanceEnforcement();
  } else {
    startRestoreWorker();
    resumePendingNodeMigrations();
  }

  startStorageMigrationWorker();
  startRuntimeStatsWorker();
  monitorRestoreStatus();
  monitorNodeMigrationStatus();
  refreshAllRuntimeStats();
});
