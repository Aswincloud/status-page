// D1 query helpers. All time values are unix milliseconds.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AGENT_LINK: DurableObjectNamespace; // holds the home agent's WebSocket
  INGEST_TOKEN?: string;
  CONTROL_TOKEN?: string; // owner-only actions (legacy manual unlock)
  // Sign-in via the central OAuth broker + session:
  SESSION_SECRET?: string; // HMAC key for the session cookie (+ the sign-in nonce cookie)
  OWNER_EMAIL?: string; // comma-separated allow-list of accounts that may sign in
  // Central broker (auth.aswincloud.com) — set by the provision dashboard:
  AUTH_BROKER_URL?: string; // e.g. https://auth.aswincloud.com
  RELAY_SECRET?: string; // per-site shared secret; verifies the broker's relay token
  ACCESS_MODE?: string; // "public" | "domain" | "owners" (default "owners")
  ACCESS_DOMAINS?: string; // comma-separated, used when ACCESS_MODE=domain
  // Legacy fields (kept so older config still typechecks; unused once on broker):
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Alert channels (optional — alerts.ts no-ops for a channel when its vars are unset):
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  // Email via Resend:
  RESEND_API_KEY?: string;
  ALERT_FROM?: string; // e.g. "aswincloud status <status@aswincloud.com>"
  ALERT_TO?: string; // e.g. "aswin@aswincloud.com"
  // Low-speed subscriber alerts (public subscribe + confirm/unsubscribe):
  SPEED_ALERT_MBPS?: string; // threshold; alert subscribers if down OR up drops below it (default 150)
  PUBLIC_ORIGIN?: string; // e.g. "https://status.aswincloud.com" — for confirm/unsub links
  // Slack (bot token + channel id):
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL?: string; // channel ID, e.g. C0XXXXXXXXX
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

// ---- speed tests ----

export interface IncomingSpeedtest {
  download_mbps: number;
  upload_mbps: number;
  ping_ms?: number | null;
  server?: string | null;
  isp?: string | null;
}

export async function insertSpeedtest(
  db: D1Database,
  ts: number,
  s: IncomingSpeedtest,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO speedtests (ts, download_mbps, upload_mbps, ping_ms, server, isp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(ts, s.download_mbps, s.upload_mbps, s.ping_ms ?? null, s.server ?? null, s.isp ?? null)
    .run();
}

export async function pruneOldSpeedtests(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare(`DELETE FROM speedtests WHERE ts < ?`).bind(olderThan).run();
}

// ---- control key/value ----

export async function getControl(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT v FROM control WHERE k = ?`).bind(key).first<{ v: string }>();
  return row?.v ?? null;
}

export async function setControl(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO control (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .bind(key, value)
    .run();
}

// ---- subscribers (low-speed email alerts; double opt-in) ----

export interface SubscriberRow {
  id: number;
  email: string;
  status: string;
  confirm_token: string;
  unsub_token: string;
  created_at: number;
  confirmed_at: number | null;
  last_alert_at: number | null;
}

export async function getSubscriberByEmail(db: D1Database, email: string): Promise<SubscriberRow | null> {
  return await db
    .prepare(`SELECT * FROM subscribers WHERE email = ?`)
    .bind(email)
    .first<SubscriberRow>();
}

// Create a pending subscriber, or refresh the confirm token if one already exists
// but isn't active yet. Returns the (new or existing) row's tokens.
export async function upsertPendingSubscriber(
  db: D1Database,
  email: string,
  confirmToken: string,
  unsubToken: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscribers (email, status, confirm_token, unsub_token, created_at)
       VALUES (?, 'pending', ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         confirm_token = excluded.confirm_token,
         created_at = excluded.created_at`,
    )
    .bind(email, confirmToken, unsubToken, now)
    .run();
}

// Activate a pending subscriber by its confirm token. Returns the row if matched.
export async function confirmSubscriber(db: D1Database, token: string, now: number): Promise<SubscriberRow | null> {
  const row = await db.prepare(`SELECT * FROM subscribers WHERE confirm_token = ?`).bind(token).first<SubscriberRow>();
  if (!row) return null;
  if (row.status !== "active") {
    await db
      .prepare(`UPDATE subscribers SET status = 'active', confirmed_at = ? WHERE id = ?`)
      .bind(now, row.id)
      .run();
  }
  return row;
}

// Remove a subscriber by its unsubscribe token. Returns the email if matched.
export async function unsubscribeByToken(db: D1Database, token: string): Promise<string | null> {
  const row = await db.prepare(`SELECT email FROM subscribers WHERE unsub_token = ?`).bind(token).first<{ email: string }>();
  if (!row) return null;
  await db.prepare(`DELETE FROM subscribers WHERE unsub_token = ?`).bind(token).run();
  return row.email;
}

// Create or activate a subscriber directly as 'active' (used when the request is
// from the signed-in owner subscribing their own verified email — no opt-in needed).
export async function activateSubscriber(
  db: D1Database,
  email: string,
  unsubToken: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscribers (email, status, confirm_token, unsub_token, created_at, confirmed_at)
       VALUES (?, 'active', '', ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         status = 'active',
         confirmed_at = COALESCE(subscribers.confirmed_at, excluded.confirmed_at)`,
    )
    .bind(email, unsubToken, now, now)
    .run();
}

export async function listActiveSubscribers(db: D1Database): Promise<SubscriberRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM subscribers WHERE status = 'active'`)
    .all<SubscriberRow>();
  return results ?? [];
}

export async function markSubscriberAlerted(db: D1Database, id: number, now: number): Promise<void> {
  await db.prepare(`UPDATE subscribers SET last_alert_at = ? WHERE id = ?`).bind(now, id).run();
}

export async function countPendingSince(db: D1Database, since: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM subscribers WHERE created_at > ?`)
    .bind(since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
