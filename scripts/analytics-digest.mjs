#!/usr/bin/env node
/**
 * Pluks Daily Analytics Digest
 *
 * Queries PostHog for the past 48 h (today vs yesterday) and emails
 * a formatted HTML dashboard to RECIPIENT_EMAIL.
 *
 * Required environment variables:
 *   POSTHOG_PERSONAL_API_KEY  – PostHog personal API key (phx_...)
 *                               Generate at: PostHog → Account → Personal API Keys
 *   POSTHOG_PROJECT_ID        – Numeric project ID from the PostHog URL
 *   GMAIL_USER                – Gmail/Workspace address to send FROM
 *   GMAIL_APP_PASSWORD        – 16-char App Password (Google Account → Security → App Passwords)
 *
 * Optional:
 *   POSTHOG_HOST              – defaults to https://us.i.posthog.com
 *   RECIPIENT_EMAIL           – defaults to parth.dixit@alumni.iitd.ac.in
 */

import nodemailer from 'nodemailer';

// ── Config ────────────────────────────────────────────────────────────────────

const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const PH_KEY       = process.env.POSTHOG_PERSONAL_API_KEY;
const PH_PROJECT   = process.env.POSTHOG_PROJECT_ID;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;
const RECIPIENT    = process.env.RECIPIENT_EMAIL || 'parth.dixit@alumni.iitd.ac.in';

const REQUIRED = { POSTHOG_PERSONAL_API_KEY: PH_KEY, POSTHOG_PROJECT_ID: PH_PROJECT, GMAIL_USER, GMAIL_APP_PASSWORD: GMAIL_PASS };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

// ── PostHog HogQL helper ──────────────────────────────────────────────────────

async function hogql(query) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${PH_PROJECT}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PH_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: query.trim() } }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PostHog query failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  const cols = json.columns ?? [];
  return (json.results ?? []).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchMetrics() {
  console.log('Querying PostHog…');

  const [traffic, product, usage, platforms, surfaces, smartPaste, dau, wauMau, dauTrend, installTrend, d1retention] = await Promise.all([

    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())     AS today,
        countIf(toDate(timestamp) = yesterday())  AS yesterday
      FROM events
      WHERE event IN ('app_installed','app_launched','app_updated')
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY event
    `),

    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())     AS today,
        countIf(toDate(timestamp) = yesterday())  AS yesterday
      FROM events
      WHERE event IN (
        'panel_opened','history_item_clicked','history_searched',
        'history_item_pasted_keyboard','history_item_deleted','history_cleared'
      )
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY event
    `),

    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())     AS today,
        countIf(toDate(timestamp) = yesterday())  AS yesterday
      FROM events
      WHERE event IN (
        'selection_captured','selection_capture_failed','smart_paste_used',
        'error_uncaught_js','error_tauri_invoke_failed','error_rust_panic',
        'auto_copy_toggled','autostart_enabled'
      )
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY event
    `),

    hogql(`
      SELECT
        properties.os_platform AS platform,
        countIf(toDate(timestamp) = today()) AS launches
      FROM events
      WHERE event = 'app_launched'
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY platform
      ORDER BY launches DESC
    `),

    hogql(`
      SELECT
        properties.surface AS surface,
        countIf(toDate(timestamp) = today()) AS events
      FROM events
      WHERE toDate(timestamp) = today()
        AND properties.surface IS NOT NULL
        AND properties.surface != ''
      GROUP BY surface
      ORDER BY events DESC
    `),

    hogql(`
      SELECT
        properties.kind AS kind,
        count() AS uses
      FROM events
      WHERE event = 'smart_paste_used'
        AND toDate(timestamp) = today()
      GROUP BY kind
      ORDER BY uses DESC
      LIMIT 6
    `),

    hogql(`
      SELECT
        countIf(day = today())     AS dau_today,
        countIf(day = yesterday())  AS dau_yesterday
      FROM (
        SELECT DISTINCT distinct_id, toDate(timestamp) AS day
        FROM events
        WHERE event = 'app_launched'
          AND timestamp >= now() - INTERVAL 2 DAY
      )
    `),

    // WAU and MAU
    hogql(`
      SELECT
        countDistinctIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY)  AS wau,
        countDistinctIf(distinct_id, timestamp >= now() - INTERVAL 30 DAY) AS mau
      FROM events
      WHERE event = 'app_launched'
        AND timestamp >= now() - INTERVAL 30 DAY
    `),

    // 7-day DAU trend (for sparkline)
    hogql(`
      SELECT
        toDate(timestamp) AS day,
        countDistinct(distinct_id) AS dau
      FROM events
      WHERE event = 'app_launched'
        AND timestamp >= today() - 7
      GROUP BY day
      ORDER BY day ASC
      LIMIT 8
    `),

    // 7-day install trend (for sparkline)
    hogql(`
      SELECT
        toDate(timestamp) AS day,
        count() AS installs
      FROM events
      WHERE event = 'app_installed'
        AND timestamp >= today() - 7
      GROUP BY day
      ORDER BY day ASC
      LIMIT 8
    `),

    // D1 retention: users who installed yesterday and launched today
    hogql(`
      SELECT
        countIf(installed_yesterday = 1) AS new_users_yesterday,
        countIf(installed_yesterday = 1 AND launched_today = 1) AS d1_retained
      FROM (
        SELECT
          distinct_id,
          maxIf(1, event = 'app_installed' AND toDate(timestamp) = yesterday()) AS installed_yesterday,
          maxIf(1, event = 'app_launched'  AND toDate(timestamp) = today())     AS launched_today
        FROM events
        WHERE timestamp >= now() - INTERVAL 2 DAY
          AND event IN ('app_installed', 'app_launched')
        GROUP BY distinct_id
      )
    `),

  ]);

  return { traffic, product, usage, platforms, surfaces, smartPaste, dau, wauMau, dauTrend, installTrend, d1retention };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function num(n) { return (n ?? 0).toLocaleString(); }

function delta(today, yesterday) {
  const t = today ?? 0;
  const y = yesterday ?? 0;
  if (y === 0) return { pct: null, dir: 'neutral' };
  const pct = ((t - y) / y) * 100;
  return { pct: Math.abs(pct).toFixed(1), dir: pct > 2 ? 'up' : pct < -2 ? 'down' : 'neutral' };
}

function rowFromData(rows, eventName) {
  return rows.find(r => r.event === eventName) ?? { event: eventName, today: 0, yesterday: 0 };
}

// Build a Unicode block sparkline from an array of numbers
function sparkline(values) {
  if (!values || values.length === 0) return '—';
  const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  return values.map(v => bars[Math.round(((v - min) / range) * 7)]).join('');
}

// Fill a sparse day-indexed series into a fixed-length array (oldest → newest)
function fillSeries(rows, dayKey, valueKey, days = 7) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const map = new Map(rows.map(r => [String(r[dayKey]).slice(0, 10), Number(r[valueKey] ?? 0)]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    const key = d.toISOString().slice(0, 10);
    return map.get(key) ?? 0;
  });
}

// ── HTML email template ───────────────────────────────────────────────────────

function buildHtml(metrics) {
  const { traffic, product, usage, platforms, surfaces, smartPaste, dau, wauMau, dauTrend, installTrend, d1retention } = metrics;

  const date = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata',
  });

  const launches   = rowFromData(traffic, 'app_launched');
  const installs   = rowFromData(traffic, 'app_installed');
  const updates    = rowFromData(traffic, 'app_updated');
  const panelOpens = rowFromData(product, 'panel_opened');
  const histClicks = rowFromData(product, 'history_item_clicked');
  const searches   = rowFromData(product, 'history_searched');
  const pastes     = rowFromData(product, 'history_item_pasted_keyboard');
  const deletes    = rowFromData(product, 'history_item_deleted');
  const clears     = rowFromData(product, 'history_cleared');
  const selections = rowFromData(usage, 'selection_captured');
  const capFails   = rowFromData(usage, 'selection_capture_failed');
  const smartTotal = rowFromData(usage, 'smart_paste_used');
  const jsErrors   = rowFromData(usage, 'error_uncaught_js');
  const tauriErrs  = rowFromData(usage, 'error_tauri_invoke_failed');
  const rustPanics = rowFromData(usage, 'error_rust_panic');

  const dauToday = dau[0]?.dau_today ?? 0;
  const dauYest  = dau[0]?.dau_yesterday ?? 0;
  const dauDelta = delta(dauToday, dauYest);

  const wau = wauMau[0]?.wau ?? 0;
  const mau = wauMau[0]?.mau ?? 0;

  const newUsersYesterday = d1retention[0]?.new_users_yesterday ?? 0;
  const d1Retained        = d1retention[0]?.d1_retained ?? 0;
  const d1Rate            = newUsersYesterday > 0 ? ((d1Retained / newUsersYesterday) * 100).toFixed(0) : null;

  const totalErrors = (jsErrors.today ?? 0) + (tauriErrs.today ?? 0) + (rustPanics.today ?? 0);
  const totalErrorsYest = (jsErrors.yesterday ?? 0) + (tauriErrs.yesterday ?? 0) + (rustPanics.yesterday ?? 0);
  const errDelta = delta(totalErrors, totalErrorsYest);

  const platformTotal = platforms.reduce((s, r) => s + (r.launches ?? 0), 0) || 1;
  const surfaceTotal  = surfaces.reduce((s, r) => s + (r.events ?? 0), 0) || 1;
  const smartTotal_n  = smartPaste.reduce((s, r) => s + (r.uses ?? 0), 0) || 1;

  const dauSeries     = fillSeries(dauTrend, 'day', 'dau', 7);
  const installSeries = fillSeries(installTrend, 'day', 'installs', 7);
  const dauSpark      = sparkline(dauSeries);
  const installSpark  = sparkline(installSeries);

  const COLORS = { macos: '#6ee7b7', windows: '#60a5fa', linux: '#f59e0b', unknown: '#6b7280' };
  const SURF_COLORS = { app: '#6ee7b7', ext: '#a78bfa', web: '#fb923c', unknown: '#6b7280' };

  function card(label, value, d, invertDelta = false) {
    const { pct, dir } = d;
    let dirColor = '#6b7280';
    let arrow = '→';
    if (dir === 'up') { dirColor = invertDelta ? '#ef4444' : '#10b981'; arrow = '↑'; }
    if (dir === 'down') { dirColor = invertDelta ? '#10b981' : '#ef4444'; arrow = '↓'; }
    const deltaHtml = pct !== null
      ? `<div style="font-size:12px;color:${dirColor};margin-top:4px;">${arrow} ${pct}% vs yesterday</div>`
      : `<div style="font-size:12px;color:#6b7280;margin-top:4px;">— new today</div>`;
    return `
      <td style="width:33%;padding:6px;">
        <div style="background:#111;border:1px solid #222;border-radius:10px;padding:16px;">
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${label}</div>
          <div style="font-size:26px;font-weight:700;color:#f9fafb;letter-spacing:-1px;">${num(value)}</div>
          ${deltaHtml}
        </div>
      </td>`;
  }

  function tableRow(label, today, yesterday, invertDelta = false) {
    const { pct, dir } = delta(today, yesterday);
    let color = '#6b7280'; let arrow = '→';
    if (dir === 'up') { color = invertDelta ? '#ef4444' : '#10b981'; arrow = '↑'; }
    if (dir === 'down') { color = invertDelta ? '#10b981' : '#ef4444'; arrow = '↓'; }
    const badge = pct !== null ? `<span style="color:${color};font-size:11px;">${arrow} ${pct}%</span>` : `<span style="color:#374151;font-size:11px;">—</span>`;
    return `
      <tr>
        <td style="padding:10px 16px;font-size:13px;color:#d1d5db;border-bottom:1px solid #1c1c1c;">${label}</td>
        <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#f9fafb;text-align:right;border-bottom:1px solid #1c1c1c;">${num(today)}</td>
        <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;border-bottom:1px solid #1c1c1c;">${num(yesterday)}</td>
        <td style="padding:10px 16px;text-align:right;border-bottom:1px solid #1c1c1c;">${badge}</td>
      </tr>`;
  }

  function sectionHeader(title) {
    return `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#6b7280;margin:32px 0 10px;">${title}</div>`;
  }

  function barSegments(items, total, colorMap) {
    return items.map(item => {
      const key = (item.platform || item.surface || '').toLowerCase();
      const pct = ((item.launches || item.events || 0) / total) * 100;
      const color = colorMap[key] || '#374151';
      return `<div style="display:inline-block;width:${pct.toFixed(1)}%;height:8px;background:${color};"></div>`;
    }).join('');
  }

  function legendItem(label, count, total, colorMap) {
    const key = label.toLowerCase();
    const color = colorMap[key] || '#374151';
    const pct = ((count) / total * 100).toFixed(0);
    return `
      <td style="padding:4px 12px;text-align:center;">
        <div style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;margin-right:4px;vertical-align:middle;"></div>
        <span style="font-size:12px;color:#9ca3af;vertical-align:middle;">${label}</span>
        <div style="font-size:14px;font-weight:600;color:#f9fafb;margin-top:2px;">${num(count)} <span style="font-size:11px;color:#6b7280;font-weight:400;">(${pct}%)</span></div>
      </td>`;
  }

  const platformBar   = barSegments(platforms, platformTotal, COLORS);
  const surfaceBar    = barSegments(surfaces.map(s => ({...s, platform: s.surface})), surfaceTotal, SURF_COLORS);
  const platformLegend = platforms.map(p => legendItem(p.platform || 'unknown', p.launches ?? 0, platformTotal, COLORS)).join('');
  const surfaceLegend  = surfaces.map(s => legendItem(s.surface || 'unknown', s.events ?? 0, surfaceTotal, SURF_COLORS)).join('');

  const smartPasteRows = smartPaste.length > 0
    ? smartPaste.map(r => `
        <tr>
          <td style="padding:8px 16px;font-size:13px;color:#d1d5db;border-bottom:1px solid #1c1c1c;">${r.kind || 'unknown'}</td>
          <td style="padding:8px 16px;font-size:13px;font-weight:600;color:#f9fafb;text-align:right;border-bottom:1px solid #1c1c1c;">${num(r.uses)}</td>
          <td style="padding:8px 16px;text-align:right;border-bottom:1px solid #1c1c1c;font-size:12px;color:#6b7280;">${((r.uses / smartTotal_n) * 100).toFixed(0)}%</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px;text-align:center;color:#374151;font-size:13px;">No smart paste usage today</td></tr>`;

  const d1Badge = d1Rate !== null
    ? `<div style="display:inline-block;background:${Number(d1Rate) >= 30 ? '#0d2b1e' : '#2b0d0d'};border:1px solid ${Number(d1Rate) >= 30 ? '#1c4a30' : '#4a1c1c'};border-radius:8px;padding:8px 16px;margin-top:16px;">
        <span style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1px;">D1 Retention</span>
        <span style="font-size:20px;font-weight:700;color:${Number(d1Rate) >= 30 ? '#6ee7b7' : '#f87171'};margin-left:12px;">${d1Rate}%</span>
        <span style="font-size:12px;color:#4b5563;margin-left:8px;">${num(d1Retained)} of ${num(newUsersYesterday)} new users came back</span>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pluks Daily Analytics – ${date}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;">
<div style="max-width:660px;margin:0 auto;padding:24px 16px;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 8px;">
    <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.5px;">
      plu<span style="color:#6ee7b7;">ks</span> <span style="color:#374151;font-weight:400;">·</span> daily analytics
    </div>
    <div style="font-size:13px;color:#4b5563;margin-top:6px;">${date} &nbsp;·&nbsp; Asia/Kolkata</div>
  </div>

  <!-- DAU / WAU / MAU hero -->
  <div style="background:linear-gradient(135deg,#0d1f17 0%,#111 100%);border:1px solid #1c2e22;border-radius:12px;padding:24px;margin:24px 0;text-align:center;">
    <!-- DAU big number -->
    <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Daily Active Users</div>
    <div style="font-size:48px;font-weight:800;color:#6ee7b7;letter-spacing:-2px;">${num(dauToday)}</div>
    ${dauDelta.pct !== null
      ? `<div style="font-size:13px;color:${dauDelta.dir === 'up' ? '#10b981' : dauDelta.dir === 'down' ? '#ef4444' : '#6b7280'};margin-top:4px;">
           ${dauDelta.dir === 'up' ? '↑' : dauDelta.dir === 'down' ? '↓' : '→'} ${dauDelta.pct}% vs yesterday (${num(dauYest)} DAU)
         </div>`
      : `<div style="font-size:13px;color:#6b7280;margin-top:4px;">first day of data</div>`}

    <!-- WAU / MAU row -->
    <div style="display:flex;justify-content:center;gap:32px;margin-top:20px;padding-top:16px;border-top:1px solid #1c2e22;">
      <div>
        <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1px;">WAU (7d)</div>
        <div style="font-size:22px;font-weight:700;color:#a7f3d0;margin-top:4px;">${num(wau)}</div>
      </div>
      <div style="width:1px;background:#1c2e22;"></div>
      <div>
        <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1px;">MAU (30d)</div>
        <div style="font-size:22px;font-weight:700;color:#a7f3d0;margin-top:4px;">${num(mau)}</div>
      </div>
    </div>

    <!-- D1 retention badge -->
    ${d1Badge}
  </div>

  <!-- ── 7-Day Trend ── -->
  ${sectionHeader('📈 7-Day Trend')}
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:20px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;width:50%;padding-right:16px;border-right:1px solid #1c1c1c;">
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Active Users / Day</div>
          <div style="font-size:22px;font-family:'Courier New',monospace;letter-spacing:2px;color:#6ee7b7;">${dauSpark}</div>
          <div style="font-size:11px;color:#4b5563;margin-top:6px;">
            ${dauSeries.map((v, i) => {
              const d = new Date(); d.setDate(d.getDate() - (6 - i));
              return `<span style="display:inline-block;width:${Math.floor(100/7)}%;text-align:center;">${v}</span>`;
            }).join('')}
          </div>
        </td>
        <td style="padding:8px 0;width:50%;padding-left:16px;">
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">New Installs / Day</div>
          <div style="font-size:22px;font-family:'Courier New',monospace;letter-spacing:2px;color:#60a5fa;">${installSpark}</div>
          <div style="font-size:11px;color:#4b5563;margin-top:6px;">
            ${installSeries.map((v, i) => {
              return `<span style="display:inline-block;width:${Math.floor(100/7)}%;text-align:center;">${v}</span>`;
            }).join('')}
          </div>
        </td>
      </tr>
    </table>
  </div>

  <!-- ── Traffic ── -->
  ${sectionHeader('🚦 Traffic')}
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${card('Launches', launches.today, delta(launches.today, launches.yesterday))}
      ${card('Installs', installs.today, delta(installs.today, installs.yesterday))}
      ${card('Updates', updates.today, delta(updates.today, updates.yesterday))}
    </tr>
  </table>

  <!-- ── Product ── -->
  ${sectionHeader('📦 Product')}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:10px;border-collapse:collapse;overflow:hidden;">
    <thead>
      <tr style="border-bottom:1px solid #222;">
        <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:1px;">Event</th>
        <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Today</th>
        <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Yesterday</th>
        <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Δ</th>
      </tr>
    </thead>
    <tbody>
      ${tableRow('Panel opened', panelOpens.today, panelOpens.yesterday)}
      ${tableRow('History item clicked', histClicks.today, histClicks.yesterday)}
      ${tableRow('Pasted via keyboard', pastes.today, pastes.yesterday)}
      ${tableRow('Searches performed', searches.today, searches.yesterday)}
      ${tableRow('Items deleted', deletes.today, deletes.yesterday)}
      ${tableRow('History cleared', clears.today, clears.yesterday, true)}
    </tbody>
  </table>

  <!-- ── Usage ── -->
  ${sectionHeader('⚡ Usage')}
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${card('Selections captured', selections.today, delta(selections.today, selections.yesterday))}
      ${card('Smart pastes', smartTotal.today, delta(smartTotal.today, smartTotal.yesterday))}
      ${card('Errors', totalErrors, delta(totalErrors, totalErrorsYest), true)}
    </tr>
  </table>

  <!-- Smart paste breakdown -->
  ${smartPaste.length > 0 ? `
  <div style="margin-top:12px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:10px;border-collapse:collapse;overflow:hidden;">
      <thead>
        <tr style="border-bottom:1px solid #222;">
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:1px;">Smart Paste Kind</th>
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Uses</th>
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Share</th>
        </tr>
      </thead>
      <tbody>${smartPasteRows}</tbody>
    </table>
  </div>` : ''}

  <!-- Capture fail rate -->
  ${(selections.today + capFails.today) > 0 ? `
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:14px 16px;margin-top:12px;display:flex;align-items:center;">
    <span style="font-size:13px;color:#9ca3af;">Capture success rate today:&nbsp;</span>
    <span style="font-size:14px;font-weight:700;color:${((selections.today / (selections.today + capFails.today)) * 100) >= 95 ? '#10b981' : '#f59e0b'};">
      ${((selections.today / (selections.today + capFails.today)) * 100).toFixed(1)}%
    </span>
    <span style="font-size:12px;color:#4b5563;margin-left:8px;">(${num(capFails.today)} failed)</span>
  </div>` : ''}

  <!-- ── Platforms ── -->
  ${sectionHeader('🖥️ Platform Breakdown')}
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:16px;">
    <div style="height:8px;border-radius:4px;overflow:hidden;background:#1c1c1c;margin-bottom:16px;">
      ${platformBar}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>${platformLegend}</tr>
    </table>
  </div>

  <!-- ── Surfaces ── -->
  ${sectionHeader('🌐 Surface Breakdown')}
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:16px;">
    <div style="height:8px;border-radius:4px;overflow:hidden;background:#1c1c1c;margin-bottom:16px;">
      ${surfaceBar}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>${surfaceLegend}</tr>
    </table>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:32px 0 16px;border-top:1px solid #111;margin-top:32px;">
    <div style="font-size:12px;color:#374151;">
      Pluks Analytics Digest &nbsp;·&nbsp; Powered by PostHog<br>
      <a href="https://us.posthog.com" style="color:#6b7280;text-decoration:none;">Open PostHog dashboard →</a>
    </div>
  </div>

</div>
</body>
</html>`;
}

// ── Email sending ─────────────────────────────────────────────────────────────

async function sendEmail(html) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  const date = new Date().toLocaleDateString('en-IN', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata',
  });

  await transporter.sendMail({
    from: `Pluks Analytics <${GMAIL_USER}>`,
    to: RECIPIENT,
    subject: `Pluks Daily Analytics – ${date}`,
    html,
    text: 'Please view this email in an HTML-capable client.',
  });

  console.log(`Email sent to ${RECIPIENT}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const metrics = await fetchMetrics();
  const html = buildHtml(metrics);
  await sendEmail(html);
}

main().catch(err => { console.error(err); process.exit(1); });
