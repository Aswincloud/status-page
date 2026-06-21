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
import { applyCheck, handleIngest, handleSpeedtest, handleStatus } from "./api";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/ingest" && req.method === "POST") {
      return handleIngest(req, env);
    }
    if (url.pathname === "/api/speedtest" && req.method === "POST") {
      return handleSpeedtest(req, env);
    }
    if (url.pathname === "/api/status" && req.method === "GET") {
      return handleStatus(req, env, ctx);
    }
    if (url.pathname === "/api/health") {
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
