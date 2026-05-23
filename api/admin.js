const https = require('node:https');

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

function fmReq(host, path, method, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
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

async function getToken(host, user, pass) {
  const r = await fmReq(host, '/user/auth', 'POST', null, { username: user, password: pass });
  if (r.status !== 200) throw new Error(`Auth ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const token = r.body?.response?.token;
  if (!token) throw new Error('No token: ' + JSON.stringify(r.body).slice(0, 200));
  return token;
}

async function logout(host, token) {
  try { await fmReq(host, '/user/auth', 'DELETE', token, null); } catch {}
}

module.exports = async function handler(req, res) {
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
      const [statusR, clientsR, dbsR] = await Promise.all([
        fmReq(srv.host, '/server/status', 'GET', token, null),
        fmReq(srv.host, '/clients', 'GET', token, null),
        fmReq(srv.host, '/databases', 'GET', token, null),
      ]);
      await logout(srv.host, token);
      return res.json({
        server: srv.host,
        status: statusR.body?.response ?? null,
        clients: clientsR.body?.response?.clients ?? [],
        databases: dbsR.body?.response?.databases ?? [],
      });
    }

    const body = req.method === 'POST' ? (req.body || {}) : {};

    let result;
    if (action === 'close-db') {
      result = await fmReq(srv.host, `/databases/${parseInt(body.id)}`, 'PATCH', token, { status: 'CLOSED' });
    } else if (action === 'open-db') {
      result = await fmReq(srv.host, `/databases/${parseInt(body.id)}`, 'PATCH', token, { status: 'OPEN' });
    } else if (action === 'kick-client') {
      result = await fmReq(srv.host, `/clients/${parseInt(body.id)}`, 'DELETE', token, {
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
