






const fs = require('fs');
const path = require('path');




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

const mysql = require('./lib/mysql');

const state = mysql.getState();
if (!state || !Array.isArray(state.users)) {
  console.error('Nessuno stato trovato nel database, niente da fare.');
  process.exit(1);
}

let count = 0;

for (const user of state.users) {
  user.ipHashes = [];
  user.lastIpHash = null;
  user.lastIpAt = null;
  count++;
}

mysql.setState(state, true);

console.log(`Fatto. Storico IP azzerato per tutti i ${count} utenti.`);
console.log('Da ora in poi ogni nuovo login registrera\' l\'IP reale (se TRUST_PROXY e Nginx sono configurati correttamente).');
