// HTTP API handlers: POST /api/ingest (prober → DB) and GET /api/status (page ← DB).

import {
  Env,
  IncomingCheck,
  IncomingSpeedtest,
  MonitorRow,
  STALE_MS,
  getControl,
  insertCheck,
  insertSpeedtest,
  latestCheck,
  listMonitors,
  openIncident,
  resolveIncident,
  setControl,
  startIncident,
  upsertMonitor,
} from "./db";
import { notify } from "./alerts";
import { getSession } from "./auth";
import {
  dayBuckets,
  latencySeries,
  recentIncidents,
  speedSummary,
  uptimePct,
} from "./stats";

// The single Durable Object instance that links to the home agent.
function agentLink(env: Env): DurableObjectStub {
  return env.AGENT_LINK.get(env.AGENT_LINK.idFromName("home"));
}

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

// POST /api/speedtest — authenticated speed sample from the home speed agent.
export async function handleSpeedtest(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  let body: IncomingSpeedtest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.download_mbps !== "number" || typeof body.upload_mbps !== "number") {
    return json({ error: "download_mbps and upload_mbps required" }, { status: 400 });
  }

  await insertSpeedtest(env.DB, Date.now(), {
    download_mbps: body.download_mbps,
    upload_mbps: body.upload_mbps,
    ping_ms: typeof body.ping_ms === "number" ? body.ping_ms : null,
    server: typeof body.server === "string" ? body.server : null,
    isp: typeof body.isp === "string" ? body.isp : null,
  });
  return json({ ok: true });
}

const COOLDOWN_MS = 2 * 60 * 1000; // min gap between on-demand tests

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

// Decide whether a request is allowed to trigger an action. Two ways in:
//   1. signed Google session cookie (owner)  — the normal path (sign-in button)
//   2. legacy CONTROL_TOKEN bearer           — server-side fallback (curl/cron)
async function authorize(
  req: Request,
  env: Env,
): Promise<{ ok: boolean; via: "session" | "token" | null }> {
  if (await getSession(req, env)) return { ok: true, via: "session" };
  if (env.CONTROL_TOKEN && bearer(req) === env.CONTROL_TOKEN) return { ok: true, via: "token" };
  return { ok: false, via: null };
}

// GET /api/can-test — is THIS visitor signed in as owner? (uncached, per-session)
export async function handleCanTest(req: Request, env: Env): Promise<Response> {
  const { ok, via } = await authorize(req, env);
  const linked = await agentLink(env)
    .fetch("https://do/connected")
    .then((r) => r.json() as Promise<{ connected: boolean }>)
    .catch(() => ({ connected: false }));
  const ssoConfigured = !!(env.GOOGLE_CLIENT_ID && env.OWNER_EMAIL && env.SESSION_SECRET);
  return json(
    { canTest: ok, via, agentOnline: linked.connected, ssoConfigured },
    { headers: { "cache-control": "no-store" } },
  );
}

// POST /api/control-check — verify a legacy owner control token (manual unlock).
export async function handleControlCheck(req: Request, env: Env): Promise<Response> {
  const ok = !!env.CONTROL_TOKEN && bearer(req) === env.CONTROL_TOKEN;
  return json({ ok }, { status: ok ? 200 : 401 });
}

// POST /api/request-test — trigger an on-demand speed test. Authorized via session,
// home-IP, or token; rate-limited; pushed to the agent over its WebSocket (no poll).
export async function handleRequestTest(req: Request, env: Env): Promise<Response> {
  const { ok } = await authorize(req, env);
  if (!ok) return json({ error: "unauthorized" }, { status: 401 });

  const now = Date.now();
  const lastReq = Number((await getControl(env.DB, "test_requested_at")) ?? 0);
  if (now - lastReq < COOLDOWN_MS) {
    const retryInSec = Math.ceil((COOLDOWN_MS - (now - lastReq)) / 1000);
    return json({ error: "cooldown", retryInSec }, { status: 429 });
  }

  // Push the command down the agent's live socket.
  const pushed = await agentLink(env)
    .fetch("https://do/push", { method: "POST", body: JSON.stringify({ cmd: "run", at: now }) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!pushed) return json({ error: "agent_offline" }, { status: 503 });

  await setControl(env.DB, "test_requested_at", String(now));
  return json({ ok: true, requestedAt: now });
}

// GET /api/agent-ws — the home agent opens its persistent link here (INGEST_TOKEN
// via query, since WebSocket clients can't set Authorization headers everywhere).
export async function handleAgentWs(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? bearer(req);
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  return agentLink(env).fetch("https://do/connect", req);
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

  const [incidents, speed] = await Promise.all([
    recentIncidents(env.DB, now),
    speedSummary(env.DB, now),
  ]);

  // Overall: operational if all up, major if all down, partial otherwise.
  const total = out.length;
  const upCount = out.filter((m) => m.up).length;
  const overall = total === 0 ? "unknown" : upCount === total ? "operational" : upCount === 0 ? "major" : "partial";

  const res = json(
    { generated_at: now, overall, monitors: out, incidents, speed },
    { headers: { "cache-control": "public, max-age=15" } },
  );
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
