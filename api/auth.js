const crypto = require('crypto');

function sessionToken() {
  const secret = process.env.FM_SESSION_SECRET || 'default-secret';
  const pass   = process.env.FM_DASHBOARD_PASSWORD || '';
  return crypto.createHmac('sha256', secret).update(pass).digest('hex');
}

function getCookie(req) {
  const m = (req.headers.cookie || '').match(/fm_session=([^;]+)/);
  return m ? m[1] : null;
}

module.exports = function handler(req, res) {
  if (req.method === 'GET') {
    const valid = !!process.env.FM_DASHBOARD_PASSWORD &&
                  getCookie(req) === sessionToken();
    return res.status(valid ? 200 : 401).json({ ok: valid });
  }

  if (req.method === 'POST') {
    const { password } = req.body || {};
    if (!password || password !== process.env.FM_DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    res.setHeader('Set-Cookie',
      `fm_session=${sessionToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie',
      'fm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return res.json({ ok: true });
  }

  res.status(405).end();
};
