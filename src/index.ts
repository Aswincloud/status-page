// Worker entry: fetch() router for /api/* + scheduled() cron watchdog.
// Static assets (the page) are served by Cloudflare before the Worker runs,
// per the `assets.run_worker_first` config — so only /api/* reaches here.

import {
  Env,
  RETENTION_MS,
  STALE_MS,
  listMonitors,
  latestCheck,
  pruneOldChecks,
  pruneOldSpeedtests,
} from "./db";
import {
  applyCheck,
  handleAgentWs,
  handleCanTest,
  handleControlCheck,
  handleIngest,
  handleRequestTest,
  handleSpeedtest,
  handleStatus,
  handleSubscribe,
  handleSubscribeConfirm,
  handleUnsubscribe,
} from "./api";
import { handleCallback, handleLogin, handleLogout } from "./auth";

export { AgentLink } from "./agent-link";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/ingest" && req.method === "POST") return handleIngest(req, env);
    if (p === "/api/speedtest" && req.method === "POST") return handleSpeedtest(req, env);
    if (p === "/api/agent-ws") return handleAgentWs(req, env);
    if (p === "/api/can-test" && req.method === "GET") return handleCanTest(req, env);
    if (p === "/api/control-check" && req.method === "POST") return handleControlCheck(req, env);
    if (p === "/api/request-test" && req.method === "POST") return handleRequestTest(req, env);
    if (p === "/api/status" && req.method === "GET") return handleStatus(req, env, ctx);

    // Low-speed email subscriptions (public; double opt-in)
    if (p === "/api/subscribe" && req.method === "POST") return handleSubscribe(req, env);
    if (p === "/api/subscribe/confirm" && req.method === "GET") return handleSubscribeConfirm(req, env);
    if (p === "/api/subscribe/unsubscribe" && req.method === "GET") return handleUnsubscribe(req, env);

    // Google OIDC
    if (p === "/api/auth/login") return handleLogin(req, env);
    if (p === "/api/auth/callback") return handleCallback(req, env);
    if (p === "/api/auth/logout") return handleLogout(req);

    if (p === "/api/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // Anything else under /api is a 404; non-api routes never reach the Worker.
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },

  // Cron: every minute. Watchdog for dead probers + retention.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    const monitors = await listMonitors(env.DB);

    for (const m of monitors) {
      const last = await latestCheck(env.DB, m.id);
      // If the newest check is stale and not already recorded as down, write a
      // synthetic watchdog "down" so a dead prober/server surfaces as an outage.
      if (last && now - last.ts > STALE_MS && last.up === 1) {
        await applyCheck(env, m, false, null, now, "watchdog");
      }
    }

    await pruneOldChecks(env.DB, now - RETENTION_MS);
    await pruneOldSpeedtests(env.DB, now - RETENTION_MS);
  },
};
