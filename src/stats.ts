// Aggregation helpers that turn raw `checks` rows into the numbers the UI shows:
// uptime %, a 90-day uptime bar, and a short latency sparkline series.

const DAY_MS = 24 * 60 * 60 * 1000;

// Uptime percentage over a trailing window. Computed from the ratio of up checks
// to total checks. Returns null when there is no data in the window.
export async function uptimePct(
  db: D1Database,
  monitorId: string,
  windowMs: number,
  now: number,
): Promise<number | null> {
  const since = now - windowMs;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(up) AS ups
       FROM checks WHERE monitor_id = ? AND ts >= ?`,
    )
    .bind(monitorId, since)
    .first<{ total: number; ups: number | null }>();
  if (!row || !row.total) return null;
  const ups = row.ups ?? 0;
  return (ups / row.total) * 100;
}

export interface DayBucket {
  day: number; // unix ms at UTC midnight of that day
  state: "up" | "down" | "partial" | "nodata";
  uptime: number | null; // % for the day, null when nodata
}

// 90 day-buckets (oldest first). Each day is "up" (100%), "down" (0%),
// "partial" (in between), or "nodata".
export async function dayBuckets(
  db: D1Database,
  monitorId: string,
  now: number,
  days = 90,
): Promise<DayBucket[]> {
  const since = now - days * DAY_MS;
  // Aggregate per UTC day in SQL (indexed scan on monitor_id, ts).
  const { results } = await db
    .prepare(
      `SELECT CAST(ts / 86400000 AS INTEGER) AS day_idx,
              COUNT(*) AS total, SUM(up) AS ups
       FROM checks
       WHERE monitor_id = ? AND ts >= ?
       GROUP BY day_idx`,
    )
    .bind(monitorId, since)
    .all<{ day_idx: number; total: number; ups: number | null }>();

  const byDay = new Map<number, { total: number; ups: number }>();
  for (const r of results ?? []) byDay.set(r.day_idx, { total: r.total, ups: r.ups ?? 0 });

  const todayIdx = Math.floor(now / DAY_MS);
  const startIdx = todayIdx - (days - 1);
  const out: DayBucket[] = [];
  for (let idx = startIdx; idx <= todayIdx; idx++) {
    const agg = byDay.get(idx);
    if (!agg || agg.total === 0) {
      out.push({ day: idx * DAY_MS, state: "nodata", uptime: null });
      continue;
    }
    const pct = (agg.ups / agg.total) * 100;
    const state = pct >= 99.999 ? "up" : pct <= 0.001 ? "down" : "partial";
    out.push({ day: idx * DAY_MS, state, uptime: pct });
  }
  return out;
}

export interface SparkPoint {
  ts: number;
  latency_ms: number | null; // null marks a down check (gap in the line)
}

// Latency series for the trailing `windowMs` (default 2h), down-sampled to at
// most `maxPoints` so the payload stays tiny.
export async function latencySeries(
  db: D1Database,
  monitorId: string,
  now: number,
  windowMs = 2 * 60 * 60 * 1000,
  maxPoints = 60,
): Promise<SparkPoint[]> {
  const since = now - windowMs;
  const { results } = await db
    .prepare(
      `SELECT ts, up, latency_ms FROM checks
       WHERE monitor_id = ? AND ts >= ? ORDER BY ts ASC`,
    )
    .bind(monitorId, since)
    .all<{ ts: number; up: number; latency_ms: number | null }>();
  const rows = results ?? [];
  if (rows.length <= maxPoints) {
    return rows.map((r) => ({ ts: r.ts, latency_ms: r.up ? r.latency_ms : null }));
  }
  // Even down-sampling.
  const step = rows.length / maxPoints;
  const out: SparkPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const r = rows[Math.floor(i * step)];
    out.push({ ts: r.ts, latency_ms: r.up ? r.latency_ms : null });
  }
  return out;
}

export interface IncidentView {
  monitor_id: string;
  monitor_name: string;
  started_at: number;
  resolved_at: number | null;
}

export interface SpeedPoint {
  ts: number;
  down: number; // Mbps
  up: number; // Mbps
  ping: number | null;
}

export interface SpeedSummary {
  latest: SpeedPoint | null;
  avgDown: number | null;
  avgUp: number | null;
  peakDown: number | null;
  peakUp: number | null;
  server: string | null; // from the most recent sample
  isp: string | null;
  windowHours: number;
  series: SpeedPoint[]; // oldest → newest, for the chart
}

// Internet-speed summary over a trailing window (default 24h), down-sampled.
export async function speedSummary(
  db: D1Database,
  now: number,
  windowMs = 24 * 60 * 60 * 1000,
  maxPoints = 96,
): Promise<SpeedSummary> {
  const since = now - windowMs;
  const { results } = await db
    .prepare(
      `SELECT ts, download_mbps AS down, upload_mbps AS up, ping_ms AS ping, server, isp
       FROM speedtests WHERE ts >= ? ORDER BY ts ASC`,
    )
    .bind(since)
    .all<{ ts: number; down: number; up: number; ping: number | null; server: string | null; isp: string | null }>();
  const rows = results ?? [];

  const empty: SpeedSummary = {
    latest: null,
    avgDown: null,
    avgUp: null,
    peakDown: null,
    peakUp: null,
    server: null,
    isp: null,
    windowHours: Math.round(windowMs / 3_600_000),
    series: [],
  };
  if (rows.length === 0) return empty;

  const avgDown = rows.reduce((a, r) => a + r.down, 0) / rows.length;
  const avgUp = rows.reduce((a, r) => a + r.up, 0) / rows.length;
  const peakDown = Math.max(...rows.map((r) => r.down));
  const peakUp = Math.max(...rows.map((r) => r.up));
  const last = rows[rows.length - 1];

  // Down-sample for the chart payload.
  let series: SpeedPoint[];
  if (rows.length <= maxPoints) {
    series = rows.map((r) => ({ ts: r.ts, down: r.down, up: r.up, ping: r.ping }));
  } else {
    const step = rows.length / maxPoints;
    series = [];
    for (let i = 0; i < maxPoints; i++) {
      const r = rows[Math.floor(i * step)];
      series.push({ ts: r.ts, down: r.down, up: r.up, ping: r.ping });
    }
  }

  return {
    latest: { ts: last.ts, down: last.down, up: last.up, ping: last.ping },
    avgDown,
    avgUp,
    peakDown,
    peakUp,
    server: last.server ?? null,
    isp: last.isp ?? null,
    windowHours: Math.round(windowMs / 3_600_000),
    series,
  };
}

// Recent incidents across all monitors (most recent first), joined to names.
export async function recentIncidents(
  db: D1Database,
  now: number,
  windowMs = 90 * DAY_MS,
  limit = 30,
): Promise<IncidentView[]> {
  const since = now - windowMs;
  const { results } = await db
    .prepare(
      `SELECT i.monitor_id, m.name AS monitor_name, i.started_at, i.resolved_at
       FROM incidents i JOIN monitors m ON m.id = i.monitor_id
       WHERE i.started_at >= ?
       ORDER BY i.started_at DESC
       LIMIT ?`,
    )
    .bind(since, limit)
    .all<IncidentView>();
  return results ?? [];
}
