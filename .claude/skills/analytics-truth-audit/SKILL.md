---
name: analytics-truth-audit
description: Audit Pluks' PostHog analytics for bot/datacenter traffic and maintain the "truth layer" (ingestion tagging, test-account filters, real-humans cohort and dashboard). Use when growth metrics spike suspiciously, before reading install/retention numbers, after a store listing or launch, or when the Traffic composition monitor shows an untagged anomaly.
---

# Analytics truth audit

Pluks' telemetry is ingested into PostHog (org "Darth Pixit", project id `402186`,
`us.posthog.com`). Extension installs get crawled by Chrome Web Store review
sandboxes and security scanners: headless VMs that install the extension, fire a
handful of events, and never return. In the 2026-06-11 audit they were **~98% of
all "users"** (2,475 of 2,529 installer IDs) and made a dead launch look like
growth. This skill is the repeatable method for (1) detecting that traffic,
(2) keeping the PostHog truth layer current, and (3) validating that the
corrected metrics are believable.

Use the PostHog MCP tools (`execute-sql`, `query-*`, `cdp-functions-*`). Follow
the MCP's own discovery rules (`info` before `call`, schema-first).

## The truth layer (deployed 2026-06-11)

| Asset | ID | Purpose |
| --- | --- | --- |
| Transformation "Tag datacenter bot traffic" | `019eb7f6-61c9-0000-926a-f9e717eee5e1` | At ingestion, sets `traffic_class='bot:datacenter'` when `$geoip_postal_code` is in the datacenter list. Non-destructive (labels, never drops). **Forward-looking only.** |
| Test account filters (project settings) | — | `traffic_class is not set` AND not in cohort 282063 ("Internal / Test users"). `test_account_filters_default_checked: true`, so new insights exclude tagged traffic by default. |
| Cohort "Real humans (engaged)" | `357083` | ≥8 `selection_captured` OR ≥3 `app_launched` in 30 days. Behavioral, so it works on historical data and on bot waves from new IP pools (bots fire ≤4 events ever). |
| Dashboard "Pluks — Real humans" | `1700782` | Bot-corrected DAU, installs by surface, engaged WAU, install→selection retention, website visitors, and the **Traffic composition monitor** (all events broken down by `traffic_class` — the canary). |
| Annotation | `342266` | Marks the cutover; everything before it is bot-dominated. |

Datacenter postal list (keep all three places in sync — see "Extending the
filter"): `60602, 95141, 22747, 23917, 82010, 85036, 50307`.

## Step 1 — Audit queries

Run these via `execute-sql` whenever bot traffic is suspected. Adjust the
interval to cover the suspicious window.

**Lifespan distribution.** Humans return; sandboxes live one day. A healthy
product shows a long tail of `days_active`; bots pile up at exactly 1 with ≤4
events (p99 in the 2026-06 audit).

```sql
SELECT days_active, count() AS num_ids, sum(total_events) AS events
FROM (
  SELECT distinct_id, count(DISTINCT toDate(timestamp)) AS days_active, count() AS total_events
  FROM events
  WHERE event IN ('selection_captured','app_launched','app_installed','popup_opened','panel_opened')
    AND timestamp > now() - INTERVAL 42 DAY
  GROUP BY distinct_id
) GROUP BY days_active ORDER BY days_active LIMIT 100
```

**Geo concentration.** The decisive signature: real residents of a city spread
across hundreds of postal codes; datacenter IPs geolocate to a *single* postal
artifact per city (e.g. Boydton/23917 is Azure US East, San Jose/95141 and
Washington VA/22747 are MaxMind "generic US" artifacts, Phoenix/85036 is a
PO-box-only block). One postal per city ⇒ bots.

```sql
SELECT properties.$geoip_city_name AS city, properties.$geoip_postal_code AS postal,
       count(DISTINCT distinct_id) AS ids
FROM events
WHERE event = 'app_installed' AND timestamp > now() - INTERVAL 42 DAY
GROUP BY city, postal ORDER BY ids DESC LIMIT 30
```

**Cross-check against the funnel.** Installs must be explainable by upstream
traffic. In the audit week: 1,557 "installs" vs ~270 website visitors and 3
download clicks — impossible for humans. Compare `app_installed` totals against
`$pageview` DAU and `download_clicked`.

Signals that do NOT work (verified): `$geoip_accuracy_radius` (datacenter IPs
geolocate *precisely*; the real Indian users had larger radii), `install_source`
(always "chrome"), `locale`/`browser` (bots run the same client code).

## Step 2 — Classify

Mark a segment as bot traffic only when several independent signals agree:

1. Single-postal geo concentration (the strongest signal).
2. One-day lifespan for ~all IDs in the segment, with low event counts.
3. Volume unexplainable by upstream funnel steps.
4. Onset aligned with a store listing/review cycle rather than a promotion you ran.

Do **not** blanket-filter big cities, countries, or surfaces: future real users
live there. Filter the narrowest property that captures the segment (so far:
exact postal codes). If a new wave has no clean property signature, rely on the
behavioral cohort and say so in the dashboard description.

## Step 3 — Extend the filter

When a new bot pool is confirmed, update the postal list in all three places:

1. **Transformation** — `cdp-functions-partial-update` on
   `019eb7f6-61c9-0000-926a-f9e717eee5e1`, editing the `dcPostals` array in the
   `hog` source. Then test-invoke (`cdp-functions-invocations-create`) with one
   event matching a new postal (expect `traffic_class: 'bot:datacenter'`) and one
   real-user event (expect no tag).
2. **Dashboard insights** — the retroactive `$geoip_postal_code is_not [...]`
   property filter on insights `vPlPKN2s` (Real human DAU), `bry2ZPbi` (Real
   installs), `hE1OcgkF` (retention), `PRy05Dfx` (website visitors).
3. **This file** — the list above, so the next audit starts from truth.

The cohort thresholds (≥8 selections / ≥3 launches per 30d) only need revisiting
if bots start firing more events; re-derive from the lifespan query's p99.

## Step 4 — Validate

1. Re-run the Step 1 queries with the exclusion applied; confirm remaining
   traffic looks human (multi-day IDs, dispersed geos, funnel-consistent volume).
2. Check the **Traffic composition monitor** tile: tagged share should track the
   bot wave; a suspicious *untagged* spike means a new pool slipped through.
3. Sanity-check against ground truth you know (your own usage, people you
   onboarded personally).

## Known caveats

- The `traffic_class` tag exists only on events ingested after 2026-06-11; any
  historical analysis must use the postal exclusion or the cohort instead.
- The 12 multi-day devices as of the audit (6 desktop + 6 website, all IN) are
  candidates for "internal/dev" labeling, but ownership was not verifiable —
  do not mark them internal without confirming which are Parth's machines.
  Once confirmed, add their `distinct_id`s to cohort `282063` logic or a
  dedicated filter.
- `scripts/analytics-digest.mjs` queries the events table directly via HogQL and
  does NOT respect test-account filters; if its numbers must match the
  dashboard, add `AND properties.traffic_class IS NULL` (and the postal
  exclusion for historical ranges) to its queries.
- Incidental finding from the audit, worth re-checking: active desktop devices
  fired 0 `selection_captured` and 15 `selection_capture_failed` in 14 days
  while nudges and silent pastes flowed — core capture may be broken on real
  installs, previously masked by bot volume.
