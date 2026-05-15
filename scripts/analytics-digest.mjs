#!/usr/bin/env node
/**
 * Pluks Daily Analytics Digest
 *
 * Queries PostHog for the past 8 days and emails a formatted HTML dashboard
 * to RECIPIENT_EMAIL with traffic, product, and usage metrics.
 *
 * Required environment variables:
 *   POSTHOG_PERSONAL_API_KEY  – PostHog personal API key (phx_...)
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

  const [traffic, product, usage, platforms, surfaces, smartPaste, dau, dauTrend, website, radial] = await Promise.all([

    // Traffic: installs / launches / updates — today, yesterday, same day last week
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())           AS today,
        countIf(toDate(timestamp) = yesterday())        AS yesterday,
        countIf(toDate(timestamp) = today() - 7)        AS last_week
      FROM events
      WHERE event IN ('app_installed','app_launched','app_updated')
        AND timestamp >= now() - INTERVAL 8 DAY
      GROUP BY event
    `),

    // Product: panel / history interactions — today, yesterday, same day last week
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())           AS today,
        countIf(toDate(timestamp) = yesterday())        AS yesterday,
        countIf(toDate(timestamp) = today() - 7)        AS last_week
      FROM events
      WHERE event IN (
        'panel_opened','history_item_clicked','history_searched',
        'history_item_pasted_keyboard','history_item_deleted','history_cleared'
      )
        AND timestamp >= now() - INTERVAL 8 DAY
      GROUP BY event
    `),

    // Usage: core events + errors — today, yesterday, same day last week
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())           AS today,
        countIf(toDate(timestamp) = yesterday())        AS yesterday,
        countIf(toDate(timestamp) = today() - 7)        AS last_week
      FROM events
      WHERE event IN (
        'selection_captured','selection_capture_failed','smart_paste_used',
        'error_uncaught_js','error_tauri_invoke_failed','error_rust_panic',
        'auto_copy_toggled','autostart_enabled'
      )
        AND timestamp >= now() - INTERVAL 8 DAY
      GROUP BY event
    `),

    // Platform split for today's launches
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

    // Surface split for today
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

    // Smart paste breakdown by content kind (today)
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

    // DAU — today vs yesterday (distinct users who launched)
    hogql(`
      SELECT
        countIf(day = today())     AS dau_today,
        countIf(day = yesterday()) AS dau_yesterday
      FROM (
        SELECT DISTINCT distinct_id, toDate(timestamp) AS day
        FROM events
        WHERE event = 'app_launched'
          AND timestamp >= now() - INTERVAL 2 DAY
      )
    `),

    // 7-day DAU trend (one row per day)
    hogql(`
      SELECT
        toDate(timestamp) AS day,
        count(DISTINCT distinct_id) AS dau
      FROM events
      WHERE event = 'app_launched'
        AND timestamp >= now() - INTERVAL 7 DAY
      GROUP BY day
      ORDER BY day ASC
    `),

    // Website traffic: page views + key download funnel events
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())     AS today,
        countIf(toDate(timestamp) = yesterday())  AS yesterday,
        countIf(toDate(timestamp) = today() - 7)  AS last_week
      FROM events
      WHERE event IN ('$pageview','download_clicked','download_form_submitted','download_modal_opened','github_link_clicked','demo_completed')
        AND timestamp >= now() - INTERVAL 8 DAY
      GROUP BY event
    `),

    // Radial (long-press paste) menu usage
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())     AS today,
        countIf(toDate(timestamp) = yesterday())  AS yesterday
      FROM events
      WHERE event IN ('radial_shown','radial_committed','radial_cancelled','radial_suppressed')
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY event
    `),

  ]);

  return { traffic, product, usage, platforms, surfaces, smartPaste, dau, dauTrend, website, radial };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function num(n) { return (n ?? 0).toLocaleString(); }

function delta(today, reference) {
  const t = today ?? 0;
  const r = reference ?? 0;
  if (r === 0) return { pct: null, dir: 'neutral' };
  const pct = ((t - r) / r) * 100;
  return { pct: Math.abs(pct).toFixed(1), dir: pct > 2 ? 'up' : pct < -2 ? 'down' : 'neutral' };
}

function rowFromData(rows, eventName) {
  return rows.find(r => r.event === eventName) ?? { event: eventName, today: 0, yesterday: 0, last_week: 0 };
}

function deltaHtml(dir, pct, invertDelta = false) {
  if (pct === null) return `<span style="color:#374151;font-size:11px;">—</span>`;
  let color = '#6b7280'; let arrow = '→';
  if (dir === 'up') { color = invertDelta ? '#ef4444' : '#10b981'; arrow = '↑'; }
  if (dir === 'down') { color = invertDelta ? '#10b981' : '#ef4444'; arrow = '↓'; }
  return `<span style="color:${color};font-size:11px;">${arrow}&nbsp;${pct}%</span>`;
}

// ── HTML email template ───────────────────────────────────────────────────────

function buildHtml(metrics) {
  const { traffic, product, usage, platforms, surfaces, smartPaste, dau, dauTrend, website, radial } = metrics;

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

  const pageviews    = rowFromData(website, '$pageview');
  const dlClicked    = rowFromData(website, 'download_clicked');
  const dlSubmitted  = rowFromData(website, 'download_form_submitted');
  const dlModal      = rowFromData(website, 'download_modal_opened');
  const ghClicks     = rowFromData(website, 'github_link_clicked');
  const demoComplete = rowFromData(website, 'demo_completed');

  const radialShown     = rowFromData(radial, 'radial_shown');
  const radialCommitted = rowFromData(radial, 'radial_committed');
  const radialCancelled = rowFromData(radial, 'radial_cancelled');

  const dauToday = dau[0]?.dau_today ?? 0;
  const dauYest  = dau[0]?.dau_yesterday ?? 0;
  const dauDelta = delta(dauToday, dauYest);

  const totalErrors     = (jsErrors.today ?? 0) + (tauriErrs.today ?? 0) + (rustPanics.today ?? 0);
  const totalErrorsYest = (jsErrors.yesterday ?? 0) + (tauriErrs.yesterday ?? 0) + (rustPanics.yesterday ?? 0);
  const totalErrorsLW   = (jsErrors.last_week ?? 0) + (tauriErrs.last_week ?? 0) + (rustPanics.last_week ?? 0);
  const errDelta        = delta(totalErrors, totalErrorsYest);

  const platformTotal = platforms.reduce((s, r) => s + (r.launches ?? 0), 0) || 1;
  const surfaceTotal  = surfaces.reduce((s, r) => s + (r.events ?? 0), 0) || 1;
  const smartTotal_n  = smartPaste.reduce((s, r) => s + (r.uses ?? 0), 0) || 1;

  const radialCommitRate = radialShown.today > 0
    ? ((radialCommitted.today / radialShown.today) * 100).toFixed(0)
    : null;

  const COLORS      = { macos: '#6ee7b7', windows: '#60a5fa', linux: '#f59e0b', unknown: '#6b7280' };
  const SURF_COLORS = { app: '#6ee7b7', ext: '#a78bfa', web: '#fb923c', unknown: '#6b7280' };

  // ── Sub-components ──────────────────────────────────────────────────────────

  function sectionHeader(title) {
    return `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#6b7280;margin:32px 0 10px;">${title}</div>`;
  }

  function card(label, value, d, invertDelta = false) {
    const { pct, dir } = d;
    let dirColor = '#6b7280'; let arrow = '→';
    if (dir === 'up') { dirColor = invertDelta ? '#ef4444' : '#10b981'; arrow = '↑'; }
    if (dir === 'down') { dirColor = invertDelta ? '#10b981' : '#ef4444'; arrow = '↓'; }
    const dHtml = pct !== null
      ? `<div style="font-size:12px;color:${dirColor};margin-top:4px;">${arrow} ${pct}% vs yesterday</div>`
      : `<div style="font-size:12px;color:#6b7280;margin-top:4px;">— new today</div>`;
    return `
      <td style="width:33%;padding:6px;">
        <div style="background:#111;border:1px solid #222;border-radius:10px;padding:16px;">
          <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${label}</div>
          <div style="font-size:26px;font-weight:700;color:#f9fafb;letter-spacing:-1px;">${num(value)}</div>
          ${dHtml}
        </div>
      </td>`;
  }

  // Table row with today / yesterday / last-week columns + two delta badges
  function tableRow(label, r, invertDelta = false) {
    const { today = 0, yesterday = 0, last_week = 0 } = r;
    const dYest = delta(today, yesterday);
    const dWeek = delta(today, last_week);
    return `
      <tr>
        <td style="padding:10px 16px;font-size:13px;color:#d1d5db;border-bottom:1px solid #1c1c1c;">${label}</td>
        <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#f9fafb;text-align:right;border-bottom:1px solid #1c1c1c;">${num(today)}</td>
        <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;border-bottom:1px solid #1c1c1c;">${num(yesterday)}</td>
        <td style="padding:10px 16px;text-align:right;border-bottom:1px solid #1c1c1c;">${deltaHtml(dYest.dir, dYest.pct, invertDelta)}</td>
        <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;border-bottom:1px solid #1c1c1c;">${num(last_week)}</td>
        <td style="padding:10px 16px;text-align:right;border-bottom:1px solid #1c1c1c;">${deltaHtml(dWeek.dir, dWeek.pct, invertDelta)}</td>
      </tr>`;
  }

  function tableHeader() {
    const th = (label, align = 'right') =>
      `<th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:${align};text-transform:uppercase;letter-spacing:1px;">${label}</th>`;
    return `<tr style="border-bottom:1px solid #222;">
      ${th('Event', 'left')}
      ${th('Today')}
      ${th('Yesterday')}
      ${th('Δ vs Yest')}
      ${th('Last Wk')}
      ${th('Δ vs Wk')}
    </tr>`;
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

  // 7-day DAU sparkline as mini table
  function dauSparklineHtml() {
    if (!dauTrend.length) return '';
    const maxDau = Math.max(...dauTrend.map(r => r.dau ?? 0), 1);
    const rows = dauTrend.map(r => {
      const d = new Date(r.day).toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
      const barW = Math.round(((r.dau ?? 0) / maxDau) * 100);
      const isToday = r.day === dauTrend[dauTrend.length - 1]?.day;
      return `
        <tr>
          <td style="padding:4px 12px;font-size:11px;color:${isToday ? '#6ee7b7' : '#6b7280'};white-space:nowrap;">${d}</td>
          <td style="padding:4px 8px;width:100%;">
            <div style="background:#1c1c1c;border-radius:3px;height:6px;width:100%;">
              <div style="background:${isToday ? '#6ee7b7' : '#374151'};border-radius:3px;height:6px;width:${barW}%;"></div>
            </div>
          </td>
          <td style="padding:4px 12px;font-size:11px;font-weight:600;color:${isToday ? '#f9fafb' : '#6b7280'};text-align:right;white-space:nowrap;">${num(r.dau)}</td>
        </tr>`;
    }).join('');
    return `
      <div style="margin-top:16px;">
        <div style="font-size:11px;color:#4b5563;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">7-Day Trend</div>
        <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </div>`;
  }

  const platformBar    = barSegments(platforms, platformTotal, COLORS);
  const surfaceBar     = barSegments(surfaces.map(s => ({ ...s, platform: s.surface })), surfaceTotal, SURF_COLORS);
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

  const captureTotal = (selections.today ?? 0) + (capFails.today ?? 0);
  const captureSuccessRate = captureTotal > 0
    ? ((selections.today / captureTotal) * 100).toFixed(1)
    : null;

  // ── HTML ────────────────────────────────────────────────────────────────────

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pluks Daily Analytics – ${date}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;">
<div style="max-width:700px;margin:0 auto;padding:24px 16px;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 8px;">
    <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.5px;">
      plu<span style="color:#6ee7b7;">ks</span>&nbsp;<span style="color:#374151;font-weight:400;">·</span>&nbsp;daily analytics
    </div>
    <div style="font-size:13px;color:#4b5563;margin-top:6px;">${date}&nbsp;&nbsp;·&nbsp;&nbsp;Asia/Kolkata</div>
  </div>

  <!-- DAU hero -->
  <div style="background:linear-gradient(135deg,#0d1f17 0%,#111 100%);border:1px solid #1c2e22;border-radius:12px;padding:24px;margin:24px 0;">
    <div style="text-align:center;">
      <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Daily Active Users</div>
      <div style="font-size:52px;font-weight:800;color:#6ee7b7;letter-spacing:-2px;">${num(dauToday)}</div>
      ${dauDelta.pct !== null
        ? `<div style="font-size:13px;color:${dauDelta.dir === 'up' ? '#10b981' : dauDelta.dir === 'down' ? '#ef4444' : '#6b7280'};margin-top:4px;">
             ${dauDelta.dir === 'up' ? '↑' : dauDelta.dir === 'down' ? '↓' : '→'} ${dauDelta.pct}% vs yesterday (${num(dauYest)} DAU)
           </div>`
        : `<div style="font-size:13px;color:#6b7280;margin-top:4px;">first day of data</div>`}
    </div>
    ${dauSparklineHtml()}
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
  <div style="margin-top:12px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:10px;border-collapse:collapse;overflow:hidden;">
      <thead>${tableHeader()}</thead>
      <tbody>
        ${tableRow('App Launched', launches)}
        ${tableRow('App Installed', installs)}
        ${tableRow('App Updated', updates)}
      </tbody>
    </table>
  </div>

  <!-- ── Website Traffic ── -->
  ${sectionHeader('🌐 Website Traffic')}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:10px;border-collapse:collapse;overflow:hidden;">
    <thead>${tableHeader()}</thead>
    <tbody>
      ${tableRow('Page Views', pageviews)}
      ${tableRow('Download CTA clicked', dlClicked)}
      ${tableRow('Download modal opened', dlModal)}
      ${tableRow('Download form submitted', dlSubmitted)}
      ${tableRow('GitHub link clicked', ghClicks)}
      ${tableRow('Demo completed', demoComplete)}
    </tbody>
  </table>

  <!-- ── Product ── -->
  ${sectionHeader('📦 Product')}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:10px;border-collapse:collapse;overflow:hidden;">
    <thead>${tableHeader()}</thead>
    <tbody>
      ${tableRow('Panel opened', panelOpens)}
      ${tableRow('History item clicked', histClicks)}
      ${tableRow('Pasted via keyboard', pastes)}
      ${tableRow('Searches performed', searches)}
      ${tableRow('Items deleted', deletes)}
      ${tableRow('History cleared', clears, true)}
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

  <!-- Capture success rate -->
  ${captureSuccessRate !== null ? `
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:14px 16px;margin-top:12px;">
    <span style="font-size:13px;color:#9ca3af;">Capture success rate:&nbsp;</span>
    <span style="font-size:15px;font-weight:700;color:${parseFloat(captureSuccessRate) >= 95 ? '#10b981' : '#f59e0b'};">${captureSuccessRate}%</span>
    <span style="font-size:12px;color:#4b5563;margin-left:8px;">(${num(capFails.today)} failed out of ${num(captureTotal)})</span>
  </div>` : ''}

  <!-- Error breakdown -->
  <div style="margin-top:12px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:10px;border-collapse:collapse;overflow:hidden;">
      <thead>
        <tr style="border-bottom:1px solid #222;">
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:left;text-transform:uppercase;letter-spacing:1px;">Error Type</th>
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Today</th>
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Yesterday</th>
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Δ</th>
          <th style="padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-align:right;text-transform:uppercase;letter-spacing:1px;">Last Wk</th>
        </tr>
      </thead>
      <tbody>
        ${[
          ['JS Error', jsErrors],
          ['Tauri Invoke Error', tauriErrs],
          ['Rust Panic', rustPanics],
        ].map(([label, r]) => {
          const d = delta(r.today, r.yesterday);
          return `
            <tr>
              <td style="padding:10px 16px;font-size:13px;color:#d1d5db;border-bottom:1px solid #1c1c1c;">${label}</td>
              <td style="padding:10px 16px;font-size:13px;font-weight:600;color:${(r.today ?? 0) > 0 ? '#fca5a5' : '#f9fafb'};text-align:right;border-bottom:1px solid #1c1c1c;">${num(r.today)}</td>
              <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;border-bottom:1px solid #1c1c1c;">${num(r.yesterday)}</td>
              <td style="padding:10px 16px;text-align:right;border-bottom:1px solid #1c1c1c;">${deltaHtml(d.dir, d.pct, true)}</td>
              <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;border-bottom:1px solid #1c1c1c;">${num(r.last_week)}</td>
            </tr>`;
        }).join('')}
        <tr style="background:#0d0d0d;">
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#9ca3af;">Total</td>
          <td style="padding:10px 16px;font-size:13px;font-weight:700;color:${totalErrors > 0 ? '#fca5a5' : '#10b981'};text-align:right;">${num(totalErrors)}</td>
          <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;">${num(totalErrorsYest)}</td>
          <td style="padding:10px 16px;text-align:right;">${deltaHtml(errDelta.dir, errDelta.pct, true)}</td>
          <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;">${num(totalErrorsLW)}</td>
        </tr>
      </tbody>
    </table>
  </div>

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

  <!-- ── Radial Menu ── -->
  ${sectionHeader('🎛️ Radial Menu (Long-Press Paste)')}
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${card('Radial shown', radialShown.today, delta(radialShown.today, radialShown.yesterday))}
      ${card('Committed', radialCommitted.today, delta(radialCommitted.today, radialCommitted.yesterday))}
      ${card('Cancelled', radialCancelled.today, delta(radialCancelled.today, radialCancelled.yesterday), true)}
    </tr>
  </table>
  ${radialCommitRate !== null ? `
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:14px 16px;margin-top:12px;">
    <span style="font-size:13px;color:#9ca3af;">Commit rate (shown → committed):&nbsp;</span>
    <span style="font-size:15px;font-weight:700;color:${parseInt(radialCommitRate) >= 50 ? '#10b981' : '#f59e0b'};">${radialCommitRate}%</span>
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
  ${sectionHeader('📱 Surface Breakdown')}
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
      Pluks Analytics Digest&nbsp;·&nbsp;Powered by PostHog<br>
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
