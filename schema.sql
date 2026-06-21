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

-- Seed the starter monitor so the page renders something on first paint, before
-- the prober's first heartbeat arrives. The prober will upsert this same row.
INSERT OR IGNORE INTO monitors (id, name, type, target, created_at)
VALUES ('home-network', 'Home Network', 'ping', 'torrent.aswincloud.com', 0);
