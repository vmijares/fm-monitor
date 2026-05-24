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
          catch { resolve({ status: res.statusCode, body: { raw: data } }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Login fresco — sin caché para evitar acumulación de sesiones entre instancias
async function login(host, user, pass) {
  const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fmReq(host, '/user/auth', 'POST', basic, null);
  if (r.status !== 200) {
    const code = r.body?.messages?.[0]?.code;
    const text = r.body?.messages?.[0]?.text || JSON.stringify(r.body).slice(0, 100);
    throw Object.assign(new Error(text), { fmCode: code, httpStatus: r.status });
  }
  const token = r.body?.response?.token;
  if (!token) throw new Error('No token en respuesta: ' + JSON.stringify(r.body).slice(0, 100));
  return token;
}

async function logout(host, token) {
  try { await fmReq(host, '/user/auth', 'DELETE', `Bearer ${token}`, null); } catch {}
}

module.exports = async function handler(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autorizado' });

  const { server, action } = req.query;
  const srv = SERVERS[server];
  if (!srv?.host || !srv?.user) return res.status(400).json({ error: 'Servidor no configurado' });

  let token;
  try {
    token = await login(srv.host, srv.user, srv.pass);
  } catch (err) {
    const msg = err.fmCode === '956'
      ? 'Sesiones FM agotadas. Espera 1 min o reinicia FM Server Admin Console.'
      : 'Sin conexión: ' + err.message;
    return res.status(503).json({ error: msg });
  }

  // Garantizar logout siempre, incluso si hay excepción
  try {

    // ── GET ALL ──────────────────────────────────────────────
    if (action === 'all') {
      const [statusR, clientsR, dbsR] = await Promise.all([
        fmReq(srv.host, '/server/status', 'GET', `Bearer ${token}`, null),
        fmReq(srv.host, '/clients',       'GET', `Bearer ${token}`, null),
        fmReq(srv.host, '/databases',     'GET', `Bearer ${token}`, null),
      ]);

      const databases  = dbsR.body?.response?.databases  ?? [];
      const clientsRaw = clientsR.body?.response?.clients ?? [];

      // Construir mapa clientId→filename consultando /databases/{id}/clients
      const openDbs = databases.filter(db => ['OPEN','NORMAL'].includes((db.status||'').toUpperCase()));
      const clientDbMap = {};
      if (openDbs.length > 0) {
        const results = await Promise.allSettled(
          openDbs.map(db => fmReq(srv.host, `/databases/${db.id}/clients`, 'GET', `Bearer ${token}`, null))
        );
        results.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value.status === 200) {
            (r.value.body?.response?.clients ?? []).forEach(c => {
              clientDbMap[String(c.id)] = openDbs[i].filename;
            });
          }
        });
      }

      const clients = clientsRaw.map(c => ({ ...c, _dbName: clientDbMap[String(c.id)] || '' }));

      return res.json({
        server:    srv.host,
        status:    statusR.body?.response ?? null,
        clients,
        databases,
      });
    }

    // ── WRITE ACTIONS ────────────────────────────────────────
    let body = {};
    if (req.method === 'POST') {
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
    }

    console.log(`[FM] action=${action} server=${server} body=${JSON.stringify(body)}`);

    let result;
    if (action === 'close-db') {
      const id = parseInt(body.id);
      if (!id) return res.status(400).json({ error: 'ID inválido: ' + body.id });
      result = await fmReq(srv.host, `/databases/${id}`, 'PATCH', `Bearer ${token}`, { status: 'CLOSED' });

    } else if (action === 'open-db') {
      const id = parseInt(body.id);
      if (!id) return res.status(400).json({ error: 'ID inválido: ' + body.id });
      result = await fmReq(srv.host, `/databases/${id}`, 'PATCH', `Bearer ${token}`, { status: 'OPEN' });

    } else if (action === 'kick-client') {
      const id = parseInt(body.id);
      if (!id) return res.status(400).json({ error: 'ID inválido: ' + body.id });
      result = await fmReq(srv.host, `/clients/${id}`, 'DELETE', `Bearer ${token}`, {
        gracePeriod: 0,
        message: 'Desconectado por el administrador.',
      });

    } else {
      return res.status(400).json({ error: 'Acción desconocida' });
    }

    console.log(`[FM] result: HTTP ${result.status} — ${JSON.stringify(result.body).slice(0, 300)}`);
    return res.status(result.status).json(result.body);

  } finally {
    await logout(srv.host, token);
  }
};
