// HTTP API handlers: POST /api/ingest (prober → DB) and GET /api/status (page ← DB).

import {
  Env,
  IncomingCheck,
  MonitorRow,
  STALE_MS,
  insertCheck,
  latestCheck,
  listMonitors,
  openIncident,
  resolveIncident,
  startIncident,
  upsertMonitor,
} from "./db";
import { notify } from "./alerts";
import {
  dayBuckets,
  latencySeries,
  recentIncidents,
  uptimePct,
} from "./stats";

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

// Apply one incoming check: record it, and open/close incidents + fire alerts on a
// state transition. Shared so the cron watchdog can reuse the same logic.
export async function applyCheck(
  env: Env,
  monitor: MonitorRow,
  up: boolean,
  latencyMs: number | null,
  ts: number,
  source: "prober" | "watchdog",
): Promise<void> {
  const prev = await latestCheck(env.DB, monitor.id);
  await insertCheck(env.DB, monitor.id, ts, up, latencyMs, source);

  const wasUp = prev ? prev.up === 1 : true; // assume up before first data point
  if (wasUp && !up) {
    // up → down: open an incident (guard against duplicates).
    const existing = await openIncident(env.DB, monitor.id);
    if (!existing) {
      await startIncident(env.DB, monitor.id, ts);
      await notify(env, monitor, { kind: "down", since: ts });
    }
  } else if (!wasUp && up) {
    // down → up: resolve the open incident.
    const existing = await openIncident(env.DB, monitor.id);
    if (existing) {
      await resolveIncident(env.DB, existing.id, ts);
      await notify(env, monitor, {
        kind: "recovered",
        since: existing.started_at,
        durationMs: ts - existing.started_at,
      });
    }
  }
}

// POST /api/ingest — authenticated batch heartbeat from the prober.
export async function handleIngest(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { checks?: IncomingCheck[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, { status: 400 });
  }
  if (!Array.isArray(body.checks)) {
    return json({ error: "missing checks[]" }, { status: 400 });
  }

  const now = Date.now();
  let accepted = 0;
  for (const c of body.checks) {
    if (!c || typeof c.id !== "string" || typeof c.up !== "boolean") continue;
    await upsertMonitor(env.DB, { id: c.id, name: c.name, type: c.type, target: c.target }, now);
    const monitor: MonitorRow = {
      id: c.id,
      name: c.name,
      type: c.type,
      target: c.target,
      created_at: now,
    };
    const latency = typeof c.latency_ms === "number" ? Math.round(c.latency_ms) : null;
    await applyCheck(env, monitor, c.up, latency, now, "prober");
    accepted++;
  }
  return json({ ok: true, accepted });
}

// GET /api/status — public snapshot the page polls. Cached ~15s at the edge.
export async function handleStatus(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/status", req.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const now = Date.now();
  const monitors = await listMonitors(env.DB);

  const out = [];
  for (const m of monitors) {
    const last = await latestCheck(env.DB, m.id);
    const stale = !last || now - last.ts > STALE_MS;
    // Effective current state: down if stale (covers a dead prober) or last was down.
    const currentUp = last ? last.up === 1 && !stale : false;
    const [u24, u7, u30, buckets, spark] = await Promise.all([
      uptimePct(env.DB, m.id, 24 * 60 * 60 * 1000, now),
      uptimePct(env.DB, m.id, 7 * 24 * 60 * 60 * 1000, now),
      uptimePct(env.DB, m.id, 30 * 24 * 60 * 60 * 1000, now),
      dayBuckets(env.DB, m.id, now),
      latencySeries(env.DB, m.id, now),
    ]);
    out.push({
      id: m.id,
      name: m.name,
      type: m.type,
      target: m.target,
      up: currentUp,
      stale,
      last_checked: last?.ts ?? null,
      last_latency_ms: last?.up === 1 ? last.latency_ms : null,
      uptime: { d1: u24, d7: u7, d30: u30 },
      days: buckets,
      latency: spark,
    });
  }

  const incidents = await recentIncidents(env.DB, now);

  // Overall: operational if all up, major if all down, partial otherwise.
  const total = out.length;
  const upCount = out.filter((m) => m.up).length;
  const overall = total === 0 ? "unknown" : upCount === total ? "operational" : upCount === 0 ? "major" : "partial";

  const res = json(
    { generated_at: now, overall, monitors: out, incidents },
    { headers: { "cache-control": "public, max-age=15" } },
  );
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
