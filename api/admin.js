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

// ── Token cache ───────────────────────────────────────────────
const _tokenCache = {};

async function getToken(host, user, pass) {
  const now = Date.now();
  const cached = _tokenCache[host];
  if (cached && cached.exp > now) return cached.token;

  const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fmReq(host, '/user/auth', 'POST', basic, null);
  if (r.status !== 200) {
    delete _tokenCache[host];
    throw new Error(`Auth ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const token = r.body?.response?.token;
  if (!token) throw new Error('No token: ' + JSON.stringify(r.body).slice(0, 200));

  _tokenCache[host] = { token, exp: now + 9 * 60 * 1000 };
  return token;
}

async function invalidateToken(host) {
  const cached = _tokenCache[host];
  if (!cached) return;
  delete _tokenCache[host];
  try { await fmReq(host, '/user/auth', 'DELETE', `Bearer ${cached.token}`, null); } catch {}
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
    if (err.message.includes('956')) {
      await invalidateToken(srv.host);
      return res.status(503).json({ error: 'Sesiones FM agotadas. Espera 1 minuto y recarga.' });
    }
    return res.status(503).json({ error: 'Sin conexión: ' + err.message });
  }

  try {
    // ── GET ALL ──────────────────────────────────────────────
    if (action === 'all') {
      const [statusR, clientsR, dbsR] = await Promise.all([
        fmReq(srv.host, '/server/status', 'GET', `Bearer ${token}`, null),
        fmReq(srv.host, '/clients',       'GET', `Bearer ${token}`, null),
        fmReq(srv.host, '/databases',     'GET', `Bearer ${token}`, null),
      ]);

      if (statusR.status === 401 || clientsR.status === 401 || dbsR.status === 401) {
        await invalidateToken(srv.host);
        return res.status(503).json({ error: 'Sesión expirada, recargando...' });
      }

      const databases  = dbsR.body?.response?.databases ?? [];
      const clientsRaw = clientsR.body?.response?.clients ?? [];

      // ── Construir mapa clientId → filename ──────────────────
      // El endpoint global /clients NO devuelve a qué BD está conectado cada cliente.
      // Solución: consultar /databases/{id}/clients por cada BD abierta.
      const openDbs = databases.filter(db => {
        const s = (db.status || '').toUpperCase();
        return s === 'OPEN' || s === 'NORMAL';
      });

      const clientDbMap = {}; // key: String(clientId), value: filename

      if (openDbs.length > 0) {
        const dbClientResults = await Promise.allSettled(
          openDbs.map(db =>
            fmReq(srv.host, `/databases/${db.id}/clients`, 'GET', `Bearer ${token}`, null)
          )
        );
        dbClientResults.forEach((result, i) => {
          if (result.status === 'fulfilled' && result.value.status === 200) {
            const dbClients = result.value.body?.response?.clients ?? [];
            dbClients.forEach(c => {
              clientDbMap[String(c.id)] = openDbs[i].filename;
            });
          }
        });
      }

      // Enriquecer clientes con el nombre de BD
      const clients = clientsRaw.map(c => ({
        ...c,
        _dbName: clientDbMap[String(c.id)] || '',
      }));

      console.log(`[FM all] srv=${server} dbs=${databases.length} clients=${clients.length} dbMap=${JSON.stringify(clientDbMap)}`);

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

    console.log(`[FM action] server=${server} action=${action} body=${JSON.stringify(body)} host=${srv.host}`);

    let result;
    if (action === 'close-db') {
      const dbId = parseInt(body.id);
      if (!dbId) return res.status(400).json({ error: `ID no válido: ${body.id}` });
      result = await fmReq(srv.host, `/databases/${dbId}`, 'PATCH', `Bearer ${token}`, { status: 'CLOSED' });

    } else if (action === 'open-db') {
      const dbId = parseInt(body.id);
      if (!dbId) return res.status(400).json({ error: `ID no válido: ${body.id}` });
      result = await fmReq(srv.host, `/databases/${dbId}`, 'PATCH', `Bearer ${token}`, { status: 'OPEN' });

    } else if (action === 'kick-client') {
      const cId = parseInt(body.id);
      if (!cId) return res.status(400).json({ error: `ID no válido: ${body.id}` });
      result = await fmReq(srv.host, `/clients/${cId}`, 'DELETE', `Bearer ${token}`, {
        gracePeriod: 0,
        message: 'Desconectado por el administrador.',
      });

    } else {
      return res.status(400).json({ error: 'Acción desconocida' });
    }

    console.log(`[FM result] action=${action} status=${result.status} body=${JSON.stringify(result.body).slice(0, 400)}`);

    // Devolver respuesta completa — el frontend decide si hay error
    return res.status(result.status).json(result.body);

  } catch (err) {
    console.error('[FM error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
