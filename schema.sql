-- Home status page — D1 schema
-- Safe to run repeatedly (idempotent): uses IF NOT EXISTS / INSERT OR IGNORE.

CREATE TABLE IF NOT EXISTS monitors (
  id         TEXT PRIMARY KEY,   -- slug, e.g. 'home-network'
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,      -- ping | http | tcp
  target     TEXT NOT NULL,
  created_at INTEGER NOT NULL    -- unix ms
);

CREATE TABLE IF NOT EXISTS checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,   -- unix ms
  up         INTEGER NOT NULL,   -- 1 = up, 0 = down
  latency_ms INTEGER,            -- null when down
  source     TEXT NOT NULL DEFAULT 'prober'  -- 'prober' | 'watchdog'
);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor_id, ts);
-- Retention prunes with `WHERE ts < ?`, which a (monitor_id, ts) index cannot
-- serve — it degrades to a full SCAN. With the cron running every minute that
-- was ~176k rows read per tick (~253M/day) to delete nothing. This index makes
-- it a SEARCH that reads 1 row. Do not drop it.
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);

-- Pre-aggregated per-UTC-day counters, maintained incrementally by the cron
-- (see rollupDaily). The 90-day bar and the 7d/30d uptime figures read ~90 rows
-- from here instead of re-scanning every raw check on every page poll.
-- Survives raw-check pruning, so history outlives RETENTION_MS.
CREATE TABLE IF NOT EXISTS daily_stats (
  monitor_id TEXT    NOT NULL,
  day_idx    INTEGER NOT NULL,          -- floor(ts / 86400000), UTC day
  total      INTEGER NOT NULL DEFAULT 0,
  ups        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, day_idx)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id  TEXT NOT NULL,
  started_at  INTEGER NOT NULL,  -- unix ms
  resolved_at INTEGER            -- null = ongoing
);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id, started_at);

-- Internet speed-test samples, pushed by the home speed agent (runs AT home so
-- it measures the real home connection). Mbps are stored as REAL.
CREATE TABLE IF NOT EXISTS speedtests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,  -- unix ms
  download_mbps REAL NOT NULL,
  upload_mbps   REAL NOT NULL,
  ping_ms       REAL,
  server        TEXT,              -- e.g. "BSNL · Chennai"
  isp           TEXT
);
CREATE INDEX IF NOT EXISTS idx_speedtests_ts ON speedtests(ts);

-- Small key/value store for control state (e.g. on-demand speed-test requests).
CREATE TABLE IF NOT EXISTS control (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- Email subscribers for low-speed alerts. Double opt-in: a row starts 'pending'
-- and only becomes 'active' when the user clicks the confirmation link, so the
-- Resend key can never be used to mail arbitrary unconfirmed addresses.
CREATE TABLE IF NOT EXISTS subscribers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active'
  confirm_token TEXT NOT NULL,                    -- click to activate
  unsub_token   TEXT NOT NULL,                    -- click to unsubscribe (in every alert)
  created_at    INTEGER NOT NULL,                 -- unix ms
  confirmed_at  INTEGER,                          -- unix ms, null until confirmed
  last_alert_at INTEGER                           -- unix ms of last low-speed alert sent
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);

-- Seed the starter monitor so the page renders something on first paint, before
-- the prober's first heartbeat arrives. The prober will upsert this same row.
INSERT OR IGNORE INTO monitors (id, name, type, target, created_at)
VALUES ('home-network', 'Home Network', 'ping', 'torrent.aswincloud.com', 0);
