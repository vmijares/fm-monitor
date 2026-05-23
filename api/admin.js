const https  = require('node:https');
const crypto = require('crypto');

const agent = new https.Agent({ rejectUnauthorized: false });

const SERVERS = {
  '1': {
    host: process.env.FM_SERVER1 || 'server.simplifystudio.es',
    user: process.env.FM_ADMIN_USER1,
    pass: process.env.FM_ADMIN_PASS1,
  },
  '2': {
    host: process.env.FM_SERVER2 || 'newserver.simplifystudio.es',
    user: process.env.FM_ADMIN_USER2,
    pass: process.env.FM_ADMIN_PASS2,
  },
};

// ── Dashboard auth ────────────────────────────────────────────
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

// ── FileMaker Admin API proxy ─────────────────────────────────
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
        res.on('data', (c) => (data += c));
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

// FM Admin API v2 usa Basic Auth en el header para obtener el token
async function getToken(host, user, pass) {
  const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fmReq(host, '/user/auth', 'POST', basic, null);
  if (r.status !== 200) throw new Error(`Auth ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const token = r.body?.response?.token;
  if (!token) throw new Error('No token: ' + JSON.stringify(r.body).slice(0, 200));
  return token;
}

async function logout(host, token) {
  try { await fmReq(host, '/user/auth', 'DELETE', `Bearer ${token}`, null); } catch {}
}

module.exports = async function handler(req, res) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { server, action } = req.query;
  const srv = SERVERS[server];
  if (!srv?.host || !srv?.user) {
    return res.status(400).json({ error: 'Servidor no configurado' });
  }

  let token;
  try {
    token = await getToken(srv.host, srv.user, srv.pass);
  } catch (err) {
    return res.status(503).json({ error: 'Sin conexión: ' + err.message });
  }

  try {
    if (action === 'all') {
      const [statusR, dbsR] = await Promise.all([
        fmReq(srv.host, '/server/status', 'GET', `Bearer ${token}`, null),
        fmReq(srv.host, '/databases',     'GET', `Bearer ${token}`, null),
      ]);

      const databases = dbsR.body?.response?.databases ?? [];

      // Query per-database clients to get the fileName association
      const openDbs = databases.filter(db => {
        const st = (db.status || '').toUpperCase();
        return st === 'OPEN' || st === 'NORMAL';
      });

      let clients = [];
      if (openDbs.length > 0) {
        const dbClientResponses = await Promise.all(
          openDbs.map(db => fmReq(srv.host, `/databases/${db.id}/clients`, 'GET', `Bearer ${token}`, null))
        );
        dbClientResponses.forEach((r, i) => {
          const dbName = openDbs[i].filename || openDbs[i].name || '';
          (r.body?.response?.clients ?? []).forEach(c => clients.push({ ...c, fileName: dbName }));
        });
      } else {
        // Fallback: no open databases, use global clients endpoint
        const clientsR = await fmReq(srv.host, '/clients', 'GET', `Bearer ${token}`, null);
        clients = clientsR.body?.response?.clients ?? [];
      }

      await logout(srv.host, token);
      return res.json({
        server:        srv.host,
        status:        statusR.body?.response ?? null,
        clients,
        databases,
        clientsOnline: clients.length,
      });
    }

    const body = req.method === 'POST' ? (req.body || {}) : {};
    let result;

    if (action === 'close-db') {
      result = await fmReq(srv.host, `/databases/${parseInt(body.id)}`, 'PATCH', `Bearer ${token}`, { status: 'CLOSED' });
    } else if (action === 'open-db') {
      result = await fmReq(srv.host, `/databases/${parseInt(body.id)}`, 'PATCH', `Bearer ${token}`, { status: 'OPEN' });
    } else if (action === 'kick-client') {
      result = await fmReq(srv.host, `/clients/${parseInt(body.id)}`, 'DELETE', `Bearer ${token}`, {
        gracePeriod: 0,
        message: body.message || 'Desconectado por el administrador.',
      });
    } else {
      await logout(srv.host, token);
      return res.status(400).json({ error: 'Acción desconocida' });
    }

    await logout(srv.host, token);
    return res.status(result.status).json(result.body);
  } catch (err) {
    await logout(srv.host, token);
    return res.status(500).json({ error: err.message });
  }
};
