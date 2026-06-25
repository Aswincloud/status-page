// HTTP API handlers: POST /api/ingest (prober → DB) and GET /api/status (page ← DB).

import {
  Env,
  IncomingCheck,
  IncomingSpeedtest,
  MonitorRow,
  STALE_MS,
  confirmSubscriber,
  countPendingSince,
  getControl,
  getSubscriberByEmail,
  insertCheck,
  insertSpeedtest,
  latestCheck,
  listMonitors,
  openIncident,
  resolveIncident,
  setControl,
  startIncident,
  unsubscribeByToken,
  upsertMonitor,
  upsertPendingSubscriber,
} from "./db";
import { notify, notifyLowSpeed, sendConfirmEmail, sendWelcomeEmail } from "./alerts";
import { getSession, ssoConfigured } from "./auth";
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

  const ts = Date.now();
  await insertSpeedtest(env.DB, ts, {
    download_mbps: body.download_mbps,
    upload_mbps: body.upload_mbps,
    ping_ms: typeof body.ping_ms === "number" ? body.ping_ms : null,
    server: typeof body.server === "string" ? body.server : null,
    isp: typeof body.isp === "string" ? body.isp : null,
  });
  // Fan out a low-speed alert to confirmed subscribers if this sample is below
  // the threshold (throttled inside notifyLowSpeed). Non-blocking-ish: awaited so
  // the Worker doesn't get torn down mid-send, but it self-gates to stay cheap.
  await notifyLowSpeed(env, body.download_mbps, body.upload_mbps, ts);
  return json({ ok: true });
}

// ---- low-speed email subscriptions (public, double opt-in) -------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBSCRIBE_WINDOW_MS = 60_000; // rate-limit window
const SUBSCRIBE_MAX_PER_WINDOW = 5; // max new pending subscribes per window (anti-abuse)

const randToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

// A tiny HTML page for the confirm/unsubscribe link landings (GET in a browser).
function landingPage(title: string, body: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · aswincloud status</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0b0f;color:#f2f2f7;display:grid;place-items:center;min-height:100vh;margin:0}
.box{max-width:420px;text-align:center;padding:32px;border:1px solid #26262f;border-radius:14px;background:#15151c}
h1{font-size:19px;margin:0 0 10px}p{color:#9a9aa6;font-size:14px;margin:0 0 20px}
a{display:inline-block;background:#f2f2f7;color:#14151a;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px}</style>
<div class="box"><h1>${title}</h1><p>${body}</p><a href="https://status.aswincloud.com">Go to status page →</a></div>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// POST /api/subscribe { email } — creates a PENDING subscriber + sends a confirm
// email. Nothing is delivered to the address until they click confirm (double
// opt-in), so this endpoint can't be used to mail-bomb arbitrary addresses.
export async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  if (!env.RESEND_API_KEY || !env.ALERT_FROM) {
    return json({ error: "email_not_configured" }, { status: 503 });
  }
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "invalid_email" }, { status: 400 });
  }

  // Rate-limit new pending subscribes (protects the Resend quota from abuse).
  const now = Date.now();
  const recent = await countPendingSince(env.DB, now - SUBSCRIBE_WINDOW_MS);
  if (recent >= SUBSCRIBE_MAX_PER_WINDOW) {
    return json({ error: "rate_limited" }, { status: 429 });
  }

  const existing = await getSubscriberByEmail(env.DB, email);
  // Already active → don't re-send anything; respond the same as a fresh request
  // so the endpoint doesn't leak who's already subscribed.
  if (existing && existing.status === "active") {
    return json({ ok: true });
  }

  // Always mint a fresh confirm token; keep the existing unsub token if any so a
  // prior unsubscribe link (e.g. from an earlier active stint) stays meaningful.
  const confirmToken = randToken();
  const unsubToken = existing?.unsub_token ?? randToken();
  await upsertPendingSubscriber(env.DB, email, confirmToken, unsubToken, now);
  await sendConfirmEmail(env, email, confirmToken);
  return json({ ok: true });
}

// GET /api/subscribe/confirm?token=... — activate a pending subscriber.
export async function handleSubscribeConfirm(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return landingPage("Invalid link", "This confirmation link is missing its token.");
  const row = await confirmSubscriber(env.DB, token, Date.now());
  if (!row) return landingPage("Link expired", "This confirmation link is invalid or already used.");
  await sendWelcomeEmail(env, row.email, row.unsub_token);
  return landingPage("You're subscribed ✓", "You'll get an email if the home internet speed drops below the alert threshold.");
}

// GET /api/subscribe/unsubscribe?token=... — remove a subscriber.
export async function handleUnsubscribe(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return landingPage("Invalid link", "This unsubscribe link is missing its token.");
  const email = await unsubscribeByToken(env.DB, token);
  if (!email) return landingPage("Already removed", "That subscription was already removed (or the link is invalid).");
  return landingPage("Unsubscribed", "You won't receive any more speed alerts. You can re-subscribe anytime.");
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
  return json(
    { canTest: ok, via, agentOnline: linked.connected, ssoConfigured: ssoConfigured(env) },
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
