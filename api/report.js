const { kv }    = require('@vercel/kv');
const { Resend } = require('resend');

const DAYS_ES   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function datesInMonth(year, month) { // month: 1-12
  const count = new Date(year, month, 0).getDate();
  return Array.from({ length: count }, (_, i) => {
    const d = i + 1;
    return `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  });
}

function weekOfMonth(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return Math.ceil((d.getUTCDate() + first.getUTCDay()) / 7);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const isCron   = secret && req.headers.authorization === `Bearer ${secret}`;
  const isManual = secret && req.query.token === secret;
  if (secret && !isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Determine report month (default: previous month)
  const now = new Date();
  const year  = req.query.year  ? parseInt(req.query.year)  : (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
  const month = req.query.month ? parseInt(req.query.month) : (now.getMonth() === 0 ? 12 : now.getMonth()); // 1-12

  const dates      = datesInMonth(year, month);
  const monthLabel = `${MONTHS_ES[month - 1]} ${year}`;

  // ── Daily distinct users ────────────────────────────────────
  const dailyStats = await Promise.all(dates.map(async date => {
    const [u1, u2] = await Promise.all([
      kv.scard(`u:1:${date}`),
      kv.scard(`u:2:${date}`),
    ]);
    const d = new Date(date + 'T12:00:00Z');
    return {
      date,
      label: d.toLocaleDateString('es-ES', { weekday:'short', day:'numeric', month:'short' }),
      dow:   d.getUTCDay(),      // 0=Sun
      week:  weekOfMonth(date),
      u1:    u1 || 0,
      u2:    u2 || 0,
      total: (u1 || 0) + (u2 || 0),
    };
  }));

  // ── Busiest specific day ─────────────────────────────────────
  const busiestDay = dailyStats.reduce((m, d) => d.total > m.total ? d : m, dailyStats[0] || { total: 0, label: '—' });

  // ── Day-of-week with most accumulated users ──────────────────
  const byDow = Array(7).fill(0);
  dailyStats.forEach(d => { byDow[d.dow] += d.total; });
  const busiestDow = DAYS_ES[byDow.indexOf(Math.max(...byDow))];

  // ── Busiest week ─────────────────────────────────────────────
  const byWeek = {};
  dailyStats.forEach(d => { byWeek[d.week] = (byWeek[d.week] || 0) + d.total; });
  const [busiestWeekNum, busiestWeekTotal] = Object.entries(byWeek)
    .reduce((m, e) => e[1] > m[1] ? e : m, ['0', 0]);

  // ── Total distinct users per server (whole month) ────────────
  const keys1 = dates.map(d => `u:1:${d}`);
  const keys2 = dates.map(d => `u:2:${d}`);

  let monthUsers1 = [], monthUsers2 = [];
  try {
    [monthUsers1, monthUsers2] = await Promise.all([
      kv.sunion(...keys1),
      kv.sunion(...keys2),
    ]);
  } catch {}

  const totalDistinct = new Set([...monthUsers1, ...monthUsers2]).size;

  // ── Per-DB stats ─────────────────────────────────────────────
  const dbRegistry = {}; // `${srv}||${dbName}` → { srv, dbName, dates[] }

  for (const date of dates) {
    for (const srv of ['1', '2']) {
      const names = (await kv.smembers(`dbs:${srv}:${date}`)) || [];
      for (const dbName of names) {
        const key = `${srv}||${dbName}`;
        if (!dbRegistry[key]) dbRegistry[key] = { srv, dbName, dates: [] };
        dbRegistry[key].dates.push(date);
      }
    }
  }

  // Get distinct users per DB across the month
  const dbRaw = await Promise.all(
    Object.values(dbRegistry).map(async ({ srv, dbName, dates: dbDates }) => {
      const userKeys = dbDates.map(d => `du:${srv}:${d}:${encodeURIComponent(dbName).slice(0, 80)}`);
      let users = [];
      try { users = await kv.sunion(...userKeys); } catch {}
      return { dbName, srv, count: users.length };
    })
  );

  // Merge same DB from both servers (sum, may overlap but acceptable approximation)
  const dbMerged = {};
  for (const { dbName, count } of dbRaw) {
    dbMerged[dbName] = (dbMerged[dbName] || 0) + count;
  }
  const dbList = Object.entries(dbMerged).sort((a, b) => b[1] - a[1]);

  // ── Weekly summary rows ───────────────────────────────────────
  const weekSummary = Object.entries(byWeek)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([w, total]) => {
      const weekDates = dailyStats.filter(d => d.week === Number(w));
      const from = weekDates[0]?.date.slice(8) ?? '';
      const to   = weekDates[weekDates.length - 1]?.date.slice(8) ?? '';
      return { week: w, from, to, total, isBusiest: w === busiestWeekNum };
    });

  // ── Build email HTML ─────────────────────────────────────────
  const html = buildEmail({
    monthLabel, busiestDay, busiestDow, weekSummary,
    users1: monthUsers1.length,
    users2: monthUsers2.length,
    totalDistinct, dbList,
  });

  // ── Send via Resend ──────────────────────────────────────────
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from   = process.env.REPORT_FROM_EMAIL || 'FM Monitor <monitor@simplifystudio.es>';
  const to     = process.env.REPORT_TO_EMAIL   || 'victor@simplifystudio.es';

  const { error } = await resend.emails.send({
    from,
    to,
    subject: `FM Monitor · Report ${monthLabel}`,
    html,
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, month: monthLabel, to });
};

// ── HTML email template ──────────────────────────────────────────────────────

function card(content, mb = '16px') {
  return `<div style="background:#ffffff;border-radius:12px;padding:24px 28px;margin-bottom:${mb};">${content}</div>`;
}

function sectionTitle(t) {
  return `<div style="font-size:11px;color:#6e6860;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:14px;">${t}</div>`;
}

function pill(label, value, bg, color) {
  return `
    <td style="padding:0 6px 12px 0;vertical-align:top;">
      <div style="background:${bg};border-radius:10px;padding:14px 16px;min-width:120px;">
        <div style="font-size:11px;color:${color};font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">${label}</div>
        <div style="font-size:15px;color:#1a1a1a;font-weight:700;">${value}</div>
      </div>
    </td>`;
}

function buildEmail({ monthLabel, busiestDay, busiestDow, weekSummary, users1, users2, totalDistinct, dbList }) {

  const dbRows = dbList.map(([db, count], i) => `
    <tr style="background:${i % 2 === 0 ? '#f5f2ee' : '#fff'};">
      <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;">${esc(db)}</td>
      <td style="padding:10px 16px;font-size:13px;font-weight:700;color:#1a1a1a;text-align:right;">${count}</td>
    </tr>`).join('');

  const weekRows = weekSummary.map(({ week, from, to, total, isBusiest }) => `
    <tr>
      <td style="padding:9px 16px;font-size:13px;color:#1a1a1a;">Semana ${week}<span style="color:#6e6860;font-size:12px;"> (${from}–${to})</span></td>
      <td style="padding:9px 16px;text-align:right;">
        ${isBusiest
          ? `<span style="background:#f8ede7;color:#d4622a;font-size:11px;font-weight:700;padding:2px 8px;border-radius:8px;">${total} ★</span>`
          : `<span style="font-size:13px;color:#1a1a1a;">${total}</span>`
        }
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f2ee;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:28px 16px 40px;">

  <!-- Header -->
  <div style="background:#1a1a1a;border-radius:14px;padding:28px 32px;margin-bottom:20px;">
    <div style="font-size:11px;color:#d4622a;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:10px;">FM Monitor · Simplify Studio</div>
    <div style="font-size:13px;color:#e8e3dc;margin-bottom:4px;">Report mensual</div>
    <div style="font-size:28px;color:#ffffff;font-weight:700;line-height:1.1;">${esc(monthLabel)}</div>
  </div>

  <!-- Totales -->
  ${card(`
    ${sectionTitle('Usuarios únicos conectados')}
    <table cellpadding="0" cellspacing="0" style="width:100%"><tr>
      <td style="padding-right:12px;text-align:center;border-right:1px solid #e8e3dc;">
        <div style="font-size:48px;font-weight:700;color:#1a1a1a;line-height:1;">${totalDistinct}</div>
        <div style="font-size:11px;color:#6e6860;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin-top:4px;">Total ambos servidores</div>
      </td>
      <td style="padding-left:24px;">
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;color:#6e6860;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">Servidor Principal</div>
          <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${users1}</div>
        </div>
        <div>
          <div style="font-size:11px;color:#6e6860;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">Servidor Secundario</div>
          <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${users2}</div>
        </div>
      </td>
    </tr></table>
  `)}

  <!-- Patrones -->
  ${card(`
    ${sectionTitle('Patrones de uso')}
    <table cellpadding="0" cellspacing="0" style="width:100%"><tr>
      ${pill('Día más activo', esc(busiestDay.label) + `<br><span style="font-size:12px;color:#6e6860;font-weight:400;">${busiestDay.total} sesiones</span>`, '#f8ede7', '#d4622a')}
      ${pill('Día de semana + activo', esc(busiestDow), '#e6f4ed', '#2d7a4a')}
    </tr></table>
  `)}

  <!-- Semanas -->
  ${card(`
    ${sectionTitle('Desglose semanal')}
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6e6860;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;background:#f5f2ee;">Semana</th>
        <th style="padding:8px 16px;text-align:right;font-size:11px;color:#6e6860;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;background:#f5f2ee;">Usuarios únicos</th>
      </tr></thead>
      <tbody>${weekRows}</tbody>
    </table>
  `)}

  <!-- Por base de datos -->
  ${dbList.length > 0 ? card(`
    ${sectionTitle('Usuarios únicos por base de datos')}
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:#6e6860;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;background:#f5f2ee;">Base de datos</th>
        <th style="padding:8px 16px;text-align:right;font-size:11px;color:#6e6860;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;background:#f5f2ee;">Usuarios únicos</th>
      </tr></thead>
      <tbody>${dbRows}</tbody>
    </table>
  `) : ''}

  <!-- Footer -->
  <div style="text-align:center;padding:16px 0 0;font-size:12px;color:#6e6860;">
    <span style="color:#d4622a;font-style:italic;">Simplify</span> Studio · FM Monitor · Generado automáticamente el día 1 de cada mes
  </div>

</div>
</body>
</html>`;
}
