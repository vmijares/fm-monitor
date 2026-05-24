// Endpoint de diagnóstico — muestra respuesta RAW de FM en HTML
// URL: /api/debug?server=1  o  /api/debug?server=2
const https  = require('node:https');
const crypto = require('crypto');

const agent = new https.Agent({ rejectUnauthorized: false });

const SERVERS = {
  '1': { host: process.env.FM_SERVER1 || 'server.simplifystudio.es',    user: process.env.FM_ADMIN_USER1, pass: process.env.FM_ADMIN_PASS1 },
  '2': { host: process.env.FM_SERVER2 || 'newserver.simplifystudio.es', user: process.env.FM_ADMIN_USER2, pass: process.env.FM_ADMIN_PASS2 },
};

function sessionToken() {
  const secret = process.env.FM_SESSION_SECRET || 'default-secret';
  const pass   = process.env.FM_DASHBOARD_PASSWORD || '';
  return crypto.createHmac('sha256', secret).update(pass).digest('hex');
}
function isAuthenticated(req) {
  if (!process.env.FM_DASHBOARD_PASSWORD) return true;
  const m = (req.headers.cookie || '').match(/fm_session=([^;]+)/);
  return m ? m[1] === sessionToken() : false;
}

function fmReq(host, path, method, auth, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (auth)    headers['Authorization'] = auth;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(
      { hostname: host, path: `/fmi/admin/api/v2${path}`, method, agent, headers },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, raw: data }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = async function handler(req, res) {
  if (!isAuthenticated(req)) {
    return res.status(401).send('<h2>No autenticado. Accede primero al dashboard.</h2>');
  }

  const server = req.query.server || '1';
  const srv = SERVERS[server];
  if (!srv?.user) return res.status(400).send('<h2>Servidor no configurado</h2>');

  let sections = [];
  let token;

  // AUTH
  try {
    const basic = 'Basic ' + Buffer.from(`${srv.user}:${srv.pass}`).toString('base64');
    const r = await fmReq(srv.host, '/user/auth', 'POST', basic, null);
    sections.push({ title: 'POST /user/auth → HTTP ' + r.status, data: r.body || r.raw });
    token = r.body?.response?.token;
  } catch(e) {
    sections.push({ title: 'POST /user/auth → EXCEPCIÓN', data: { error: e.message } });
  }

  if (token) {
    // CLIENTS
    try {
      const r = await fmReq(srv.host, '/clients', 'GET', `Bearer ${token}`, null);
      sections.push({ title: 'GET /clients → HTTP ' + r.status, data: r.body || r.raw });
    } catch(e) { sections.push({ title: 'GET /clients → EXCEPCIÓN', data: { error: e.message } }); }

    // DATABASES
    let dbs = [];
    try {
      const r = await fmReq(srv.host, '/databases', 'GET', `Bearer ${token}`, null);
      sections.push({ title: 'GET /databases → HTTP ' + r.status, data: r.body || r.raw });
      dbs = r.body?.response?.databases ?? [];
    } catch(e) { sections.push({ title: 'GET /databases → EXCEPCIÓN', data: { error: e.message } }); }

    // PER-DB CLIENTS (first 3 open DBs)
    const openDbs = dbs.filter(d => ['OPEN','NORMAL'].includes((d.status||'').toUpperCase())).slice(0, 3);
    for (const db of openDbs) {
      try {
        const r = await fmReq(srv.host, `/databases/${db.id}/clients`, 'GET', `Bearer ${token}`, null);
        sections.push({ title: `GET /databases/${db.id}/clients (${db.filename}) → HTTP ${r.status}`, data: r.body || r.raw });
      } catch(e) { sections.push({ title: `GET /databases/${db.id}/clients → EXCEPCIÓN`, data: { error: e.message } }); }
    }

    // LOGOUT
    try { await fmReq(srv.host, '/user/auth', 'DELETE', `Bearer ${token}`, null); } catch {}
  }

  const html = `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FM Debug — Servidor ${server}</title>
<style>
  body { font-family: monospace; background: #0d0d0d; color: #e0e0e0; padding: 20px; }
  h1 { color: #d4622a; margin-bottom: 4px; }
  p.sub { color: #888; margin-bottom: 24px; }
  .nav { margin-bottom: 20px; }
  .nav a { color: #0f0; margin-right: 16px; }
  .block { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
  .block-title { background: #2a2a2a; padding: 10px 16px; color: #0f0; font-weight: bold; border-bottom: 1px solid #333; }
  pre { padding: 16px; margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 13px; line-height: 1.5; }
</style></head><body>
<h1>FM Debug</h1>
<p class="sub">Servidor ${server} · ${esc(srv.host)} · ${new Date().toLocaleString('es-ES')}</p>
<div class="nav">
  <a href="/api/debug?server=1">Servidor 1</a>
  <a href="/api/debug?server=2">Servidor 2</a>
  <a href="/" style="color:#888">← Dashboard</a>
</div>
${sections.map(s => `<div class="block">
  <div class="block-title">${esc(s.title)}</div>
  <pre>${esc(JSON.stringify(s.data, null, 2))}</pre>
</div>`).join('')}
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
};
