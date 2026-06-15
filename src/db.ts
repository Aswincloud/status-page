// D1 query helpers. All time values are unix milliseconds.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INGEST_TOKEN?: string;
  // Dormant alert channels (optional — alerts.ts no-ops when unset):
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface MonitorRow {
  id: string;
  name: string;
  type: string;
  target: string;
  created_at: number;
}

export interface IncomingCheck {
  id: string;
  name: string;
  type: string;
  target: string;
  up: boolean;
  latency_ms: number | null;
}

// How long without a fresh check before a monitor is considered stale/down.
export const STALE_MS = 120_000; // 2 minutes
// How long raw checks are retained.
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function upsertMonitor(
  db: D1Database,
  m: { id: string; name: string; type: string; target: string },
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO monitors (id, name, type, target, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         target = excluded.target`,
    )
    .bind(m.id, m.name, m.type, m.target, now)
    .run();
}

export async function insertCheck(
  db: D1Database,
  monitorId: string,
  ts: number,
  up: boolean,
  latencyMs: number | null,
  source: "prober" | "watchdog",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO checks (monitor_id, ts, up, latency_ms, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(monitorId, ts, up ? 1 : 0, up ? latencyMs : null, source)
    .run();
}

export async function listMonitors(db: D1Database): Promise<MonitorRow[]> {
  const { results } = await db
    .prepare(`SELECT id, name, type, target, created_at FROM monitors ORDER BY created_at, name`)
    .all<MonitorRow>();
  return results ?? [];
}

// Most recent check for a monitor (null if none yet).
export async function latestCheck(
  db: D1Database,
  monitorId: string,
): Promise<{ ts: number; up: number; latency_ms: number | null } | null> {
  return await db
    .prepare(`SELECT ts, up, latency_ms FROM checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 1`)
    .bind(monitorId)
    .first<{ ts: number; up: number; latency_ms: number | null }>();
}

// The currently-open incident for a monitor, if any.
export async function openIncident(
  db: D1Database,
  monitorId: string,
): Promise<{ id: number; started_at: number } | null> {
  return await db
    .prepare(
      `SELECT id, started_at FROM incidents
       WHERE monitor_id = ? AND resolved_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(monitorId)
    .first<{ id: number; started_at: number }>();
}

export async function startIncident(db: D1Database, monitorId: string, at: number): Promise<void> {
  await db
    .prepare(`INSERT INTO incidents (monitor_id, started_at, resolved_at) VALUES (?, ?, NULL)`)
    .bind(monitorId, at)
    .run();
}

export async function resolveIncident(db: D1Database, incidentId: number, at: number): Promise<void> {
  await db.prepare(`UPDATE incidents SET resolved_at = ? WHERE id = ?`).bind(at, incidentId).run();
}

export async function pruneOldChecks(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare(`DELETE FROM checks WHERE ts < ?`).bind(olderThan).run();
}
