const https = require('node:https');
const agent = new https.Agent({ rejectUnauthorized: false });

const SERVERS = {
  '1': { host: process.env.FM_SERVER1 || 'server.simplifystudio.es',    user: process.env.FM_ADMIN_USER1, pass: process.env.FM_ADMIN_PASS1 },
  '2': { host: process.env.FM_SERVER2 || 'newserver.simplifystudio.es', user: process.env.FM_ADMIN_USER2, pass: process.env.FM_ADMIN_PASS2 },
};

const TTL = 60 * 60 * 24 * 400; // 400 days

function fmReq(host, path, method, auth) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = auth;
    const req = https.request(
      { hostname: host, path: `/fmi/admin/api/v2${path}`, method, agent, headers },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getFMClients(srv) {
  const basic = 'Basic ' + Buffer.from(`${srv.user}:${srv.pass}`).toString('base64');
  const authR = await fmReq(srv.host, '/user/auth', 'POST', basic);
  const token = authR?.response?.token;
  if (!token) throw new Error('No FM token');

  try {
    const dbsR = await fmReq(srv.host, '/databases', 'GET', `Bearer ${token}`);
    const databases = dbsR?.response?.databases ?? [];
    const openDbs = databases.filter(db => {
      const st = (db.status || '').toUpperCase();
      return st === 'OPEN' || st === 'NORMAL';
    });

    const clients = [];
    if (openDbs.length > 0) {
      const results = await Promise.all(
        openDbs.map(db => fmReq(srv.host, `/databases/${db.id}/clients`, 'GET', `Bearer ${token}`))
      );
      results.forEach((r, i) => {
        const dbName = openDbs[i].filename || openDbs[i].name || '';
        (r?.response?.clients ?? []).forEach(c => clients.push({ ...c, fileName: dbName }));
      });
    }
    return clients;
  } finally {
    try { await fmReq(srv.host, '/user/auth', 'DELETE', `Bearer ${token}`); } catch {}
  }
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { kv } = require('@vercel/kv');
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour  = now.getUTCHours();

  const results = await Promise.allSettled(
    Object.entries(SERVERS).map(async ([sid, srv]) => {
      if (!srv.user) return { sid, clients: [] };
      const clients = await getFMClients(srv);
      return { sid, clients };
    })
  );

  const pipe = kv.pipeline();

  for (const result of results) {
    if (result.status === 'rejected') continue;
    const { sid, clients } = result.value;

    // Distinct users today per server
    const users = [...new Set(clients.map(c => c.userName || c.accountName).filter(Boolean))];
    if (users.length > 0) {
      pipe.sadd(`u:${sid}:${today}`, ...users);
      pipe.expire(`u:${sid}:${today}`, TTL);
    }

    // Hourly peak (concurrent users)
    pipe.set(`pk:${sid}:${today}:${hour}`, clients.length, { ex: TTL });

    // Per-DB distinct users
    const dbGroups = {};
    for (const c of clients) {
      const db   = c.fileName || c.databaseName || '';
      const user = c.userName || c.accountName || '';
      if (db && user) {
        if (!dbGroups[db]) dbGroups[db] = new Set();
        dbGroups[db].add(user);
      }
    }

    const dbNames = Object.keys(dbGroups);
    if (dbNames.length > 0) {
      pipe.sadd(`dbs:${sid}:${today}`, ...dbNames);
      pipe.expire(`dbs:${sid}:${today}`, TTL);
      for (const [db, dbUsers] of Object.entries(dbGroups)) {
        const key = `du:${sid}:${today}:${encodeURIComponent(db).slice(0, 80)}`;
        pipe.sadd(key, ...[...dbUsers]);
        pipe.expire(key, TTL);
      }
    }
  }

  await pipe.exec();
  res.json({ ok: true, today, hour });
};
