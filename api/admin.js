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

// ── Token cache (módulo-level: persiste entre requests mientras la función esté caliente)
// Máx. 1 sesión abierta por servidor en vez de una nueva cada 30s
const _tokenCache = {};

async function getToken(host, user, pass) {
  const now = Date.now();
  const cached = _tokenCache[host];
  if (cached && cached.exp > now) return cached.token; // reutilizar sesión existente

  const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fmReq(host, '/user/auth', 'POST', basic, null);
  if (r.status !== 200) {
    delete _tokenCache[host]; // limpiar caché si la sesión está corrupta
    throw new Error(`Auth ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const token = r.body?.response?.token;
  if (!token) throw new Error('No token: ' + JSON.stringify(r.body).slice(0, 200));

  _tokenCache[host] = { token, exp: now + 9 * 60 * 1000 }; // cachear 9 min
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
    // Si falla por sesiones agotadas, limpia la caché e inténtalo solo 1 vez más
    if (err.message.includes('956')) {
      await invalidateToken(srv.host);
      return res.status(503).json({ error: 'Sesiones FM agotadas. Espera 1 minuto y recarga.' });
    }
    return res.status(503).json({ error: 'Sin conexión: ' + err.message });
  }

  try {
    if (action === 'all') {
      // Sesión reutilizada desde caché — no hacer logout para mantenerla activa
      const [statusR, clientsR, dbsR] = await Promise.all([
        fmReq(srv.host, '/server/status', 'GET', `Bearer ${token}`, null),
        fmReq(srv.host, '/clients',       'GET', `Bearer ${token}`, null),
        fmReq(srv.host, '/databases',     'GET', `Bearer ${token}`, null),
      ]);

      // Si FM devuelve 401 (token expirado), invalidar caché
      if (statusR.status === 401 || clientsR.status === 401 || dbsR.status === 401) {
        await invalidateToken(srv.host);
        return res.status(503).json({ error: 'Sesión expirada, recargando...' });
      }

      const clientsList = clientsR.body?.response?.clients ?? [];
      // Debug: log first client fields so we can verify field names (safe – private admin API)
      if (clientsList.length > 0) console.log('[FM Debug] client[0] keys:', Object.keys(clientsList[0]), JSON.stringify(clientsList[0]).slice(0, 400));

      return res.json({
        server:    srv.host,
        status:    statusR.body?.response ?? null,
        clients:   clientsList,
        databases: dbsR.body?.response?.databases     ?? [],
      });
    }

    let body = {};
    if (req.method === 'POST') {
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
    }

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
      return res.status(400).json({ error: 'Acción desconocida' });
    }

    // Normalizar errores FM
    const fmMsg = result.body?.messages?.[0];
    if (fmMsg && String(fmMsg.code) !== '0') {
      return res.status(result.status).json({
        ...result.body,
        error: fmMsg.text || `FM error ${fmMsg.code}`,
      });
    }
    return res.status(result.status).json(result.body);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
