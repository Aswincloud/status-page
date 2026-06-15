# aswincloud status

A self-hosted, BetterStack-style live status page for a home network.

The page lives on **Cloudflare's edge** (Worker + D1), so it stays up even when
home — or the prober itself — is down. An **external 24/7 server** runs a small
Docker prober that pings `torrent.aswincloud.com` and pushes heartbeats. Ping
succeeds → home network is up.

```
[external server]  --ping-->  torrent.aswincloud.com
       |  POST heartbeat (HTTPS, Bearer token)
       v
[Cloudflare Worker + D1]  ──>  https://status.aswincloud.com  (the public page)
```

Two failure modes both show correctly:
- **Home down** → prober's ping fails → recorded as down.
- **Prober/external server down** → no heartbeats → the Worker's per-minute cron
  watchdog flags the monitor stale and records a synthetic outage.

---

## Features

- Overall banner: *All systems operational / Partial outage / Major outage*
- Per-monitor cards with a status pill
- 90-day uptime bar (hover any day for its uptime %)
- Uptime % over 24h / 7d / 30d
- Response-time sparkline (last 2h)
- Incident timeline (ongoing + resolved, with durations)
- Dark / light theme toggle, fully responsive, zero JS dependencies
- Alerting hook (Telegram) — built but **dormant** until you add credentials

Adding more monitors later = edit **`prober/config.json`** only. The Worker
auto-discovers any monitor the prober reports (`ping`, `http`, or `tcp`).

---

## Layout

```
wrangler.jsonc     Worker + D1 + cron + static assets config
schema.sql         D1 tables + starter monitor seed
src/               Worker code (router, ingest/status API, stats, alerts)
public/            The status page (index.html, styles.css, app.js)
prober/            The Docker prober (copied to the external server)
```

---

## Part 1 — Deploy the status page (Cloudflare)

Run from this directory. Requires a Cloudflare account; `aswincloud.com` should be
on Cloudflare for the custom domain step.

```bash
npm install

# 1. Create the D1 database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create status-db

# 2. Create the tables (remote = the real database your Worker uses)
npx wrangler d1 execute status-db --file schema.sql --remote

# 3. Set the shared ingest secret. Generate a token and SAVE it — the prober
#    needs the exact same value.
#       openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN

# 4. Deploy
npx wrangler deploy
```

### Custom domain → `status.aswincloud.com`

Easiest via the dashboard: **Workers & Pages → home-status → Settings → Domains &
Routes → Add → Custom domain →** `status.aswincloud.com`. Cloudflare creates the
DNS + cert automatically.

Or in config: uncomment the `routes` block at the bottom of `wrangler.jsonc` and
`npx wrangler deploy` again.

Until the domain is attached, the Worker is reachable at
`https://home-status.<your-account>.workers.dev`.

---

## Part 2 — Run the prober (external 24/7 server, with Docker)

Copy the `prober/` folder to that server, then:

```bash
cd prober
cp .env.example .env
# put the SAME token you set in step 3 above into INGEST_TOKEN
nano .env

# config.json already points at https://status.aswincloud.com/api/ingest.
# If you're still on the workers.dev URL, update ingestUrl accordingly.

docker compose up -d
docker compose logs -f          # expect: "ok — home-network:23ms"
```

`restart: unless-stopped` keeps it running across reboots and crashes.

---

## Verify end-to-end

1. Open `https://status.aswincloud.com` — **Home Network** turns green within ~30s;
   the sparkline and 90-day bar fill in.
2. `curl -s https://status.aswincloud.com/api/status | jq '.overall, .monitors[0].up'`
   → `"operational"` and `true`.
3. **Outage test:** `docker compose stop` the prober (or block the ping). Within
   ~2 min the card flips red, an incident appears, uptime % dips. `docker compose
   start` again → it recovers and the incident shows resolved with a duration.

---

## Add another monitor

Edit `prober/config.json` and restart the prober — that's it. Examples:

```json
{
  "monitors": [
    { "id": "home-network", "name": "Home Network", "type": "ping", "target": "torrent.aswincloud.com" },
    { "id": "torrent-ui",   "name": "Torrent UI",   "type": "http", "target": "https://torrent.aswincloud.com" },
    { "id": "jellyfin",     "name": "Jellyfin",     "type": "tcp",  "target": "192.168.1.50:8096" }
  ]
}
```

```bash
docker compose restart
```

The new card appears on the page automatically. Removing a monitor from the config
stops new data; its history remains until it ages out (90 days). To delete it
immediately: `npx wrangler d1 execute status-db --remote --command "DELETE FROM monitors WHERE id='jellyfin'; DELETE FROM checks WHERE monitor_id='jellyfin';"`

---

## Turn on alerts (later)

Alerts are wired but off. To enable Telegram down/recovery messages:

1. Create a bot via **@BotFather**, copy its token.
2. Message your bot once, then get your chat id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates` (look for `chat.id`).
3. Set the secrets and redeploy:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   npx wrangler deploy
   ```

No code change needed — `src/alerts.ts` activates as soon as both secrets exist.

---

## Local development (optional, before deploying)

```bash
npx wrangler dev                       # local Worker + local D1 at :8787
# in another shell, seed the local DB:
npx wrangler d1 execute status-db --file schema.sql --local
# point the prober at it:
cd prober && INGEST_TOKEN=devtoken INGEST_URL=http://localhost:8787/api/ingest node prober.js
# (set the same INGEST_TOKEN for `wrangler dev` via a .dev.vars file: INGEST_TOKEN="devtoken")
```

Open `http://localhost:8787`.

---

## Notes & limits

- Everything fits comfortably in Cloudflare's free tier (Workers + D1 + cron).
- Raw checks are pruned after 90 days; uptime % and the day-bar use indexed
  aggregates and the `/api/status` JSON is edge-cached ~15s.
- `STALE_MS` (2 min) and `RETENTION_MS` (90 d) live in `src/db.ts`.
- Check interval lives in `prober/config.json` (`intervalSeconds`).
