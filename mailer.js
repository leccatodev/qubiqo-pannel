const net = require('net');
const tls = require('tls');

function readResponse(socket, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onError); socket.removeListener('close', onClose); socket.removeListener('timeout', onTimeout); };
    const finish = (fn, value) => { cleanup(); fn(value); };
    const onError = e => finish(reject, e);
    const onClose = () => finish(reject, new Error('Connessione SMTP chiusa'));
    const onTimeout = () => finish(reject, new Error('Timeout SMTP'));
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) if (/^\d{3} /.test(line)) return finish(resolve, line);
    };
    const timer = setTimeout(onTimeout, timeoutMs);
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose); socket.once('timeout', onTimeout);
  });
}
function code(r){ const m=String(r||'').match(/^(\d{3})/); return m?Number(m[1]):0; }
async function cmd(socket, command, expected){ if(command!==null) socket.write(String(command)+'\r\n'); const r=await readResponse(socket); if(expected && !expected.includes(code(r))) throw new Error(`SMTP ${code(r)}: ${String(r).trim()}`); return r; }
function tlsUpgrade(socket, host){ return new Promise((resolve,reject)=>{ const s=tls.connect({socket,host,servername:host,rejectUnauthorized:true},()=>resolve(s)); s.once('error',reject); s.setTimeout(15000,()=>reject(new Error('Timeout TLS SMTP'))); }); }
async function sendMail({to,subject,text,html}){
  const host=String(process.env.SMTP_HOST||'').trim(), port=Number(process.env.SMTP_PORT||587), user=String(process.env.SMTP_USER||'').trim(), pass=String(process.env.SMTP_PASS||''), from=String(process.env.SMTP_FROM||user).trim();
  if(!host||!user||!pass) throw new Error('Configurazione SMTP incompleta');
  let socket;
  try{
    let greetingRead=false;
    if(port===465){ socket=tls.connect({host,port,servername:host,rejectUnauthorized:true}); await new Promise((res,rej)=>{socket.once('secureConnect',res);socket.once('error',rej);socket.setTimeout(15000,()=>rej(new Error('Timeout connessione SMTP')))}); }
    else { socket=net.createConnection({host,port}); await new Promise((res,rej)=>{socket.once('connect',res);socket.once('error',rej);socket.setTimeout(15000,()=>rej(new Error('Timeout connessione SMTP')))}); await cmd(socket,null,[220]); greetingRead=true; await cmd(socket,'EHLO qubiqohost.it',[250]); await cmd(socket,'STARTTLS',[220]); socket=await tlsUpgrade(socket,host); }
    if(!greetingRead) await cmd(socket,null,[220]);
    await cmd(socket,'EHLO qubiqohost.it',[250]); await cmd(socket,'AUTH LOGIN',[334]); await cmd(socket,Buffer.from(user).toString('base64'),[334]); await cmd(socket,Buffer.from(pass).toString('base64'),[235]); await cmd(socket,`MAIL FROM:<${from}>`,[250,251]); await cmd(socket,`RCPT TO:<${to}>`,[250,251]); await cmd(socket,'DATA',[354]);
    const subj=String(subject||'').replace(/[\r\n]/g,' '), st=String(text||'').replace(/\r?\n/g,'\r\n').replace(/^\./gm,'..'), sh=String(html||'').replace(/\r?\n/g,'\r\n').replace(/^\./gm,'..');
    const body=[`From: QubiqoHost <${from}>`,`To: ${to}`,`Subject: =?UTF-8?B?${Buffer.from(subj).toString('base64')}?=`,'MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="QUBIQOHOST_ALT"','','--QUBIQOHOST_ALT','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: 8bit','',st,'','--QUBIQOHOST_ALT','Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: 8bit','',sh,'','--QUBIQOHOST_ALT--','','.'].join('\r\n');
    await cmd(socket,body,[250]); await cmd(socket,'QUIT',[221,250]); socket.end(); return {simulated:false};
  }catch(e){try{socket?.destroy()}catch(_){} throw e;}
}
module.exports={sendMail};
