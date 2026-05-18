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

  const [
    traffic, product, usage, platforms, surfaces, smartPaste,
    dau, dauSparkline, wau, website, onboarding, activation,
  ] = await Promise.all([

    // App traffic: installs, launches, updates
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())    AS today,
        countIf(toDate(timestamp) = yesterday()) AS yesterday
      FROM events
      WHERE event IN ('app_installed','app_launched','app_updated')
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY event
    `),

    // Product interactions
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())    AS today,
        countIf(toDate(timestamp) = yesterday()) AS yesterday
      FROM events
      WHERE event IN (
        'panel_opened','history_item_clicked','history_searched',
        'history_item_pasted_keyboard','history_item_deleted','history_cleared'
      )
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY event
    `),

    // Usage: selections, smart paste, errors, silent paste, nudges
    hogql(`
      SELECT
        event,
        countIf(toDate(timestamp) = today())    AS today,
        countIf(toDate(timestamp) = yesterday()) AS yesterday
      FROM events
      WHERE event IN (
        'selection_captured','selection_capture_failed','smart_paste_used',
        'error_uncaught_js','error_tauri_invoke_failed','error_rust_panic',
        'silent_paste_committed','silent_paste_suppressed',
        'nudge_shown','nudge_suppressed',
        'auto_copy_toggled','autostart_enabled'
      )
        AND timestamp >= now() - INTERVAL 2 DAY
      GROUP BY event
    `),

    // Platform breakdown (by today's launches)
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

    // Surface breakdown (all today's events)
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

    // Smart paste kinds (today)
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

    // DAU today vs yesterday
    hogql(`
      SELECT
        countIf(day = today())    AS dau_today,
        countIf(day = yesterday()) AS dau_yesterday
      FROM (
        SELECT DISTINCT distinct_id, toDate(timestamp) AS day
        FROM events
        WHERE event = 'app_launched'
          AND timestamp >= now() - INTERVAL 2 DAY
      )
    `),

    // 7-day DAU sparkline
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

    // WAU (7-day unique active users)
    hogql(`
      SELECT count(DISTINCT distinct_id) AS wau
      FROM events
      WHERE event = 'app_launched'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),

    // Website traffic (today)
    hogql(`
      SELECT
        event,
        count() AS today
      FROM events
      WHERE toDate(timestamp) = today()
        AND event IN (
          '$pageview','demo_interacted','demo_completed',
          'download_clicked','download_modal_opened','download_form_submitted',
          'github_link_clicked'
        )
        AND properties.surface = 'web'
      GROUP BY event
    `),

    // Onboarding funnel (7-day window for meaningful numbers)
    hogql(`
      SELECT
        event,
        count() AS total
      FROM events
      WHERE event IN ('onboarding_started','onboarding_completed')
        AND timestamp >= now() - INTERVAL 7 DAY
      GROUP BY event
    `),

    // Activation funnel (7-day)
    hogql(`
      SELECT
        event,
        count() AS total
      FROM events
      WHERE event IN ('activation_started','activation_completed')
        AND timestamp >= now() - INTERVAL 7 DAY
      GROUP BY event
    `),
  ]);

  return { traffic, product, usage, platforms, surfaces, smartPaste, dau, dauSparkline, wau, website, onboarding, activation };
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

function webEvent(rows, eventName) {
  return rows.find(r => r.event === eventName)?.today ?? 0;
}

function funnelEvent(rows, eventName) {
  return rows.find(r => r.event === eventName)?.total ?? 0;
}

// ── SVG sparkline ─────────────────────────────────────────────────────────────

function sparklineSvg(data) {
  if (!data || data.length === 0) return '';
  const maxVal = Math.max(...data.map(d => d.dau), 1);
  const W = 260, H = 32, gap = 2;
  const barW = Math.floor((W - gap * (data.length - 1)) / data.length);
  const bars = data.map((d, i) => {
    const bh = Math.max(3, Math.round((d.dau / maxVal) * H));
    const x  = i * (barW + gap);
    const y  = H - bh;
    const isToday = i === data.length - 1;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="1" fill="${isToday ? '#6ee7b7' : '#1a3d2e'}"/>`;
  }).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;">${bars}</svg>`;
}

// ── HTML building blocks ──────────────────────────────────────────────────────

function sectionHeader(title) {
  return `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#6b7280;margin:32px 0 10px;">${title}</div>`;
}

function card(label, value, d, invertDelta = false) {
  const { pct, dir } = d;
  let dirColor = '#6b7280', arrow = '→';
  if (dir === 'up')   { dirColor = invertDelta ? '#ef4444' : '#10b981'; arrow = '↑'; }
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
  let color = '#6b7280', arrow = '→';
  if (dir === 'up')   { color = invertDelta ? '#ef4444' : '#10b981'; arrow = '↑'; }
  if (dir === 'down') { color = invertDelta ? '#10b981' : '#ef4444'; arrow = '↓'; }
  const badge = pct !== null
    ? `<span style="color:${color};font-size:11px;">${arrow} ${pct}%</span>`
    : `<span style="color:#374151;font-size:11px;">—</span>`;
  return `
    <tr>
      <td style="padding:10px 16px;font-size:13px;color:#d1d5db;border-bottom:1px solid #1c1c1c;">${label}</td>
      <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#f9fafb;text-align:right;border-bottom:1px solid #1c1c1c;">${num(today)}</td>
      <td style="padding:10px 16px;font-size:12px;color:#6b7280;text-align:right;border-bottom:1px solid #1c1c1c;">${num(yesterday)}</td>
      <td style="padding:10px 16px;text-align:right;border-bottom:1px solid #1c1c1c;">${badge}</td>
    </tr>`;
}

function funnelRow(label, count, topCount, color) {
  const pct = topCount > 0 ? Math.round((count / topCount) * 100) : 0;
  return `
    <tr>
      <td style="padding:8px 0;font-size:12px;color:#9ca3af;white-space:nowrap;">${label}</td>
      <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#f9fafb;text-align:right;white-space:nowrap;">${num(count)}</td>
      <td style="padding:8px 0;width:99%;">
        <div style="background:#1c1c1c;border-radius:3px;height:6px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:3px;min-width:${count > 0 ? 3 : 0}px;"></div>
        </div>
      </td>
      <td style="padding:8px 0 8px 10px;font-size:11px;color:#6b7280;text-align:right;white-space:nowrap;">${pct}%</td>
    </tr>`;
}

function conversionFunnelBlock(startedN, completedN, label) {
  if (startedN === 0) return '';
  const rate = Math.round((completedN / startedN) * 100);
  const color = rate >= 70 ? '#10b981' : rate >= 40 ? '#f59e0b' : '#ef4444';
  return `
    <div style="margin-bottom:14px;">
      <div style="display:table;width:100%;">
        <div style="display:table-cell;font-size:12px;color:#9ca3af;vertical-align:middle;">${label}</div>
        <div style="display:table-cell;text-align:right;font-size:13px;font-weight:700;color:${color};vertical-align:middle;">${rate}%</div>
      </div>
      <div style="background:#1c1c1c;border-radius:4px;height:6px;margin-top:6px;overflow:hidden;">
        <div style="width:${rate}%;height:100%;background:${color};border-radius:4px;"></div>
      </div>
      <div style="font-size:11px;color:#4b5563;margin-top:4px;">${num(startedN)} started → ${num(completedN)} completed (7-day)</div>
    </div>`;
}

function barSegments(items, total, colorMap, valueKey) {
  return items.map(item => {
    const key   = ((item.platform || item.surface) ?? '').toLowerCase();
    const count = item[valueKey] ?? 0;
    const pct   = (count / total) * 100;
    const color = colorMap[key] || '#374151';
    return `<div style="display:inline-block;width:${pct.toFixed(1)}%;height:8px;background:${color};"></div>`;
  }).join('');
}

function legendItem(label, count, total, colorMap) {
  const color = colorMap[label.toLowerCase()] || '#374151';
  const pct   = ((count / total) * 100).toFixed(0);
  return `
    <td style="padding:4px 12px;text-align:center;">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;margin-right:4px;vertical-align:middle;"></div>
      <span style="font-size:12px;color:#9ca3af;vertical-align:middle;">${label}</span>
      <div style="font-size:14px;font-weight:600;color:#f9fafb;margin-top:2px;">${num(count)} <span style="font-size:11px;color:#6b7280;font-weight:400;">(${pct}%)</span></div>
    </td>`;
}

// ── HTML email template ───────────────────────────────────────────────────────

function buildHtml(metrics) {
  const { traffic, product, usage, platforms, surfaces, smartPaste, dau, dauSparkline, wau, website, onboarding, activation } = metrics;

  const date = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata',
  });

  // Traffic
  const launches   = rowFromData(traffic, 'app_launched');
  const installs   = rowFromData(traffic, 'app_installed');
  const updates    = rowFromData(traffic, 'app_updated');

  // Product
  const panelOpens = rowFromData(product, 'panel_opened');
  const histClicks = rowFromData(product, 'history_item_clicked');
  const searches   = rowFromData(product, 'history_searched');
  const pastes     = rowFromData(product, 'history_item_pasted_keyboard');
  const deletes    = rowFromData(product, 'history_item_deleted');
  const clears     = rowFromData(product, 'history_cleared');

  // Usage
  const selections   = rowFromData(usage, 'selection_captured');
  const capFails     = rowFromData(usage, 'selection_capture_failed');
  const smartTotal   = rowFromData(usage, 'smart_paste_used');
  const jsErrors     = rowFromData(usage, 'error_uncaught_js');
  const tauriErrs    = rowFromData(usage, 'error_tauri_invoke_failed');
  const rustPanics   = rowFromData(usage, 'error_rust_panic');
  const silentPastes = rowFromData(usage, 'silent_paste_committed');
  const nudgesShown  = rowFromData(usage, 'nudge_shown');

  // DAU
  const dauToday    = dau[0]?.dau_today    ?? 0;
  const dauYest     = dau[0]?.dau_yesterday ?? 0;
  const dauDelta    = delta(dauToday, dauYest);
  const wauTotal    = wau[0]?.wau ?? 0;

  // Errors
  const totalErrors     = (jsErrors.today ?? 0) + (tauriErrs.today ?? 0) + (rustPanics.today ?? 0);
  const totalErrorsYest = (jsErrors.yesterday ?? 0) + (tauriErrs.yesterday ?? 0) + (rustPanics.yesterday ?? 0);
  const errDelta        = delta(totalErrors, totalErrorsYest);

  // Website
  const pageviews        = webEvent(website, '$pageview');
  const demoInteracted   = webEvent(website, 'demo_interacted');
  const demoCompleted    = webEvent(website, 'demo_completed');
  const dlClicked        = webEvent(website, 'download_clicked');
  const dlModalOpened    = webEvent(website, 'download_modal_opened');
  const dlFormSubmitted  = webEvent(website, 'download_form_submitted');
  const ghClicks         = webEvent(website, 'github_link_clicked');
  const funnelTop        = Math.max(pageviews, 1);
  const leadConvRate     = dlFormSubmitted > 0 && pageviews > 0
    ? ((dlFormSubmitted / pageviews) * 100).toFixed(1)
    : null;

  // Onboarding & Activation
  const onbStarted    = funnelEvent(onboarding, 'onboarding_started');
  const onbCompleted  = funnelEvent(onboarding, 'onboarding_completed');
  const actStarted    = funnelEvent(activation, 'activation_started');
  const actCompleted  = funnelEvent(activation, 'activation_completed');
  const hasFunnels    = onbStarted > 0 || actStarted > 0;

  // Platform & Surface
  const platformTotal  = platforms.reduce((s, r) => s + (r.launches ?? 0), 0) || 1;
  const surfaceTotal   = surfaces.reduce((s, r) => s + (r.events ?? 0), 0) || 1;
  const smartTotal_n   = smartPaste.reduce((s, r) => s + (r.uses ?? 0), 0) || 1;

  const PLATFORM_COLORS = { macos: '#6ee7b7', windows: '#60a5fa', linux: '#f59e0b', unknown: '#6b7280' };
  const SURFACE_COLORS  = { app: '#6ee7b7', ext: '#a78bfa', web: '#fb923c', unknown: '#6b7280' };

  const platformBar    = barSegments(platforms, platformTotal, PLATFORM_COLORS, 'launches');
  const surfaceBar     = barSegments(surfaces, surfaceTotal, SURFACE_COLORS, 'events');
  const platformLegend = platforms.map(p => legendItem(p.platform || 'unknown', p.launches ?? 0, platformTotal, PLATFORM_COLORS)).join('');
  const surfaceLegend  = surfaces.map(s => legendItem(s.surface || 'unknown', s.events ?? 0, surfaceTotal, SURFACE_COLORS)).join('');

  const sparkline = sparklineSvg(dauSparkline);

  const smartPasteRows = smartPaste.length > 0
    ? smartPaste.map(r => `
        <tr>
          <td style="padding:8px 16px;font-size:13px;color:#d1d5db;border-bottom:1px solid #1c1c1c;">${r.kind || 'unknown'}</td>
          <td style="padding:8px 16px;font-size:13px;font-weight:600;color:#f9fafb;text-align:right;border-bottom:1px solid #1c1c1c;">${num(r.uses)}</td>
          <td style="padding:8px 16px;text-align:right;border-bottom:1px solid #1c1c1c;font-size:12px;color:#6b7280;">${((r.uses / smartTotal_n) * 100).toFixed(0)}%</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px;text-align:center;color:#374151;font-size:13px;">No smart paste usage today</td></tr>`;

  const hasSilentOrNudge = (silentPastes.today + nudgesShown.today) > 0;

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

  <!-- DAU + WAU heroes -->
  <div style="display:table;width:100%;margin:24px 0 0;border-spacing:0;">
    <div style="display:table-cell;width:60%;padding-right:6px;vertical-align:top;">
      <div style="background:linear-gradient(135deg,#0d1f17 0%,#111 100%);border:1px solid #1c2e22;border-radius:12px;padding:20px 20px 16px;">
        <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">Daily Active Users</div>
        <div style="font-size:44px;font-weight:800;color:#6ee7b7;letter-spacing:-2px;line-height:1;">${num(dauToday)}</div>
        ${dauDelta.pct !== null
          ? `<div style="font-size:12px;color:${dauDelta.dir === 'up' ? '#10b981' : dauDelta.dir === 'down' ? '#ef4444' : '#6b7280'};margin-top:4px;">
               ${dauDelta.dir === 'up' ? '↑' : dauDelta.dir === 'down' ? '↓' : '→'} ${dauDelta.pct}% vs yesterday (${num(dauYest)})
             </div>`
          : `<div style="font-size:12px;color:#6b7280;margin-top:4px;">first day of data</div>`}
        ${sparkline ? `<div style="margin-top:14px;">${sparkline}<div style="font-size:10px;color:#374151;margin-top:4px;text-align:right;">← 7 days</div></div>` : ''}
      </div>
    </div>
    <div style="display:table-cell;width:40%;padding-left:6px;vertical-align:top;">
      <div style="background:#111;border:1px solid #222;border-radius:12px;padding:20px;height:100%;box-sizing:border-box;">
        <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">Weekly Active Users</div>
        <div style="font-size:36px;font-weight:800;color:#a78bfa;letter-spacing:-1px;line-height:1;">${num(wauTotal)}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:6px;">unique users, 7 days</div>
        ${wauTotal > 0 && dauToday > 0
          ? `<div style="font-size:11px;color:#4b5563;margin-top:8px;">DAU/WAU ratio: <span style="color:#9ca3af;font-weight:600;">${((dauToday / wauTotal) * 100).toFixed(0)}%</span></div>`
          : ''}
      </div>
    </div>
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

  <!-- ── Website Traffic ── -->
  ${sectionHeader('🌐 Website Traffic')}
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:16px 20px;">
    <div style="display:table;width:100%;margin-bottom:16px;">
      <div style="display:table-cell;vertical-align:top;width:50%;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Pageviews today</div>
        <div style="font-size:28px;font-weight:700;color:#fb923c;letter-spacing:-0.5px;">${num(pageviews)}</div>
        ${ghClicks > 0 ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">GitHub link clicks: <span style="color:#9ca3af;font-weight:600;">${num(ghClicks)}</span></div>` : ''}
      </div>
      <div style="display:table-cell;vertical-align:top;text-align:right;">
        ${demoInteracted > 0 ? `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Demo interactions</div>
        <div style="font-size:24px;font-weight:700;color:#f9fafb;">${num(demoInteracted)}</div>
        ${demoCompleted > 0 ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">completed: ${num(demoCompleted)}</div>` : ''}` : ''}
      </div>
    </div>
    <!-- Download funnel -->
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Download funnel</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${funnelRow('Pageviews',        pageviews,       funnelTop, '#fb923c')}
      ${funnelRow('Download clicked', dlClicked,       funnelTop, '#f59e0b')}
      ${funnelRow('Modal opened',     dlModalOpened,   funnelTop, '#fbbf24')}
      ${funnelRow('Form submitted',   dlFormSubmitted, funnelTop, '#10b981')}
    </table>
    ${leadConvRate !== null
      ? `<div style="margin-top:12px;font-size:12px;color:#6b7280;">Lead conversion rate: <span style="color:#10b981;font-weight:700;">${leadConvRate}%</span></div>`
      : ''}
  </div>

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
      ${tableRow('Panel opened',        panelOpens.today, panelOpens.yesterday)}
      ${tableRow('History item clicked', histClicks.today, histClicks.yesterday)}
      ${tableRow('Pasted via keyboard',  pastes.today,     pastes.yesterday)}
      ${tableRow('Searches performed',   searches.today,   searches.yesterday)}
      ${tableRow('Items deleted',        deletes.today,    deletes.yesterday)}
      ${tableRow('History cleared',      clears.today,     clears.yesterday, true)}
    </tbody>
  </table>

  <!-- ── Usage ── -->
  ${sectionHeader('⚡ Usage')}
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${card('Selections captured', selections.today, delta(selections.today, selections.yesterday))}
      ${card('Smart pastes',        smartTotal.today, delta(smartTotal.today, smartTotal.yesterday))}
      ${card('Errors',              totalErrors,      errDelta, true)}
    </tr>
  </table>

  <!-- Error breakdown (only when non-zero) -->
  ${totalErrors > 0 ? `
  <div style="background:#111;border:1px solid #2d1515;border-radius:10px;padding:12px 16px;margin-top:8px;">
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Error breakdown</div>
    <div style="display:table;width:100%;">
      ${jsErrors.today > 0    ? `<div style="display:table-cell;text-align:center;padding:0 8px;"><div style="font-size:20px;font-weight:700;color:#ef4444;">${num(jsErrors.today)}</div><div style="font-size:11px;color:#6b7280;margin-top:2px;">JS errors</div></div>` : ''}
      ${tauriErrs.today > 0   ? `<div style="display:table-cell;text-align:center;padding:0 8px;"><div style="font-size:20px;font-weight:700;color:#ef4444;">${num(tauriErrs.today)}</div><div style="font-size:11px;color:#6b7280;margin-top:2px;">Tauri invoke</div></div>` : ''}
      ${rustPanics.today > 0  ? `<div style="display:table-cell;text-align:center;padding:0 8px;"><div style="font-size:20px;font-weight:700;color:#ef4444;">${num(rustPanics.today)}</div><div style="font-size:11px;color:#6b7280;margin-top:2px;">Rust panics</div></div>` : ''}
    </div>
  </div>` : ''}

  <!-- Smart paste breakdown -->
  ${smartPaste.length > 0 ? `
  <div style="margin-top:8px;">
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

  <!-- Capture success rate -->
  ${(selections.today + capFails.today) > 0 ? `
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:14px 16px;margin-top:8px;">
    <span style="font-size:13px;color:#9ca3af;">Capture success rate today:&nbsp;</span>
    <span style="font-size:14px;font-weight:700;color:${((selections.today / (selections.today + capFails.today)) * 100) >= 95 ? '#10b981' : '#f59e0b'};">
      ${((selections.today / (selections.today + capFails.today)) * 100).toFixed(1)}%
    </span>
    <span style="font-size:12px;color:#4b5563;margin-left:8px;">(${num(capFails.today)} failed)</span>
  </div>` : ''}

  <!-- ── Silent Paste & Nudges ── -->
  ${hasSilentOrNudge ? `
  ${sectionHeader('🔇 Silent Paste & Nudges')}
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${card('Silent pastes', silentPastes.today, delta(silentPastes.today, silentPastes.yesterday))}
      ${card('Nudges shown',  nudgesShown.today,  delta(nudgesShown.today, nudgesShown.yesterday))}
      <td style="width:33%;padding:6px;"></td>
    </tr>
  </table>` : ''}

  <!-- ── Onboarding & Activation funnels ── -->
  ${hasFunnels ? `
  ${sectionHeader('🎯 Onboarding & Activation (7-day)')}
  <div style="background:#111;border:1px solid #222;border-radius:10px;padding:16px 20px;">
    ${conversionFunnelBlock(onbStarted, onbCompleted, 'Onboarding completion')}
    ${conversionFunnelBlock(actStarted, actCompleted, 'Activation completion')}
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
  const html    = buildHtml(metrics);
  await sendEmail(html);
}

main().catch(err => { console.error(err); process.exit(1); });
