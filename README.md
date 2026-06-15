<div align="center">

# 🟢 aswincloud status

**A self-hosted, [BetterStack](https://betterstack.com/)-style live status page for a home network.**

Built on the Cloudflare edge so the page stays up *even when home — or the prober — is down.*

[**▶ Live demo: status.aswincloud.com**](https://status.aswincloud.com)

[![Deploy](https://img.shields.io/badge/deploy-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Database](https://img.shields.io/badge/data-D1%20SQLite-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Prober](https://img.shields.io/badge/prober-Docker-2496ED?logo=docker&logoColor=white)](#-part-2--run-the-prober-external-always-on-server)
[![CI](https://img.shields.io/badge/CI%2FCD-Workers%20Builds-success?logo=githubactions&logoColor=white)](#-continuous-deployment)
[![Free tier](https://img.shields.io/badge/cost-%240%20free%20tier-30d158)](#-notes--limits)
[![Deps](https://img.shields.io/badge/frontend%20deps-zero-9a9aa6)](#)

</div>

---

## How it works

A status page that lives *at home* dies *with* home — useless. So the page runs on
**Cloudflare's global edge** (a Worker + a D1 SQLite database), and an
**external always-on server** runs a tiny **Docker prober** that checks your
home and pushes heartbeats in.

```
 ┌─ external always-on server ─┐         ┌──────────── Cloudflare edge ───────────┐
 │  prober (Docker)            │         │  Worker  ·  D1  ·  per-minute cron      │
 │   every 30s:                │  HTTPS  │                                         │
 │     check home  ───────────────────▶  │  POST /api/ingest   → record + detect   │
 │     POST heartbeat          │ (Bearer)│                       up/down flips     │
 └─────────────────────────────┘         │  GET  /api/status   → JSON for the page │
                                         │  scheduled()        → watchdog + prune  │
   visitor ─── GET / ─────────────────▶  │  static assets      → the status page   │
                                         └─────────────────────────────────────────┘
                                                        │ on a down/up flip
                                                        ▼
                                            📧 Email · 💬 Slack · ✈ Telegram
```

**Both failure modes surface correctly:**

| What breaks | How it's caught |
|---|---|
| 🏠 **Home is down** | The prober's check fails → pushes `down` → recorded, incident opened, alerts fire. |
| 🖥️ **The prober/server itself dies** | No heartbeats arrive → the Worker's per-minute **cron watchdog** sees stale data (>2 min) and records a synthetic outage. No silent green. |

> **A note on the check type.** The demo monitors `torrent.aswincloud.com`, which is
> **proxied through Cloudflare**. A `ping` to it would only reach Cloudflare's edge
> (always up) and show false-green — so the monitor uses an **HTTP check** that flows
> *through* Cloudflare to the home origin: `200` when home is up, `52x` when it isn't.
> For a direct (non-proxied) host, `ping` or `tcp` work too. The prober supports all three.

---

## ✨ Features

- **Overall banner** — *All systems operational · Partial outage · Major outage*
- **Per-monitor cards** with a live status pill
- **90-day uptime bar** — hover any day for that day's uptime %
- **Uptime %** over 24h / 7d / 30d
- **Response-time sparkline** (last 2 hours, SVG, breaks the line on downtime)
- **Incident timeline** — ongoing + resolved, with durations
- **Alerts** on every down/recovery — **Email (Resend)**, **Slack**, and **Telegram**, each independent
- **Dark / light theme** toggle · fully responsive · **zero frontend dependencies**
- **Config-driven** — add a monitor by editing one JSON file; the page auto-discovers it

Supported check types: `http` · `tcp` · `ping`.

---

## 🗂️ Layout

```
wrangler.jsonc     Worker + D1 + cron + static-assets + custom-domain config
schema.sql         D1 tables + starter monitor seed
src/
  index.ts         fetch() router + scheduled() cron watchdog
  api.ts           /api/ingest (auth) + /api/status (edge-cached JSON)
  db.ts            D1 helpers + Env types + tunables (STALE_MS, RETENTION_MS)
  stats.ts         uptime %, 90-day buckets, latency series, incidents
  alerts.ts        email / Slack / Telegram — each activates only when its secrets exist
public/            The status page — index.html · styles.css · app.js
prober/            The Docker prober (copied to the external server)
```

---

## 🚀 Part 1 — Deploy the page (Cloudflare)

Requires a Cloudflare account. For the custom domain, your zone should be on Cloudflare.

```bash
npm install

# 1. Create the D1 database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create status-db

# 2. Create the tables (remote = the real database the Worker uses)
npx wrangler d1 execute status-db --file schema.sql --remote

# 3. Set the shared ingest secret — SAVE it, the prober needs the same value
#       openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN

# 4. Deploy
npx wrangler deploy
```

**Custom domain** → in `wrangler.jsonc` the `routes` block maps `status.aswincloud.com`;
since the zone is on Cloudflare, DNS + TLS are provisioned automatically on deploy.
Before a domain is attached, the Worker is live at `home-status.<account>.workers.dev`.

---

## 🐳 Part 2 — Run the prober (external, always-on server)

Copy the `prober/` folder to that server, then:

```bash
cd prober
cp .env.example .env
nano .env                       # INGEST_TOKEN = the same value from step 3 above

# config.json already points at https://status.aswincloud.com/api/ingest
docker compose up -d
docker compose logs -f          # expect: "ok — home-network:140ms"
```

`restart: unless-stopped` + Docker-on-boot keep it running across reboots and crashes.

---

## ✅ Verify end-to-end

1. Open the page — the monitor turns green within ~30s; sparkline + 90-day bar fill in.
2. `curl -s https://status.aswincloud.com/api/status | jq '.overall, .monitors[0].up'` → `"operational"`, `true`.
3. **Outage test:** `docker compose stop` the prober. Within ~2 min the card flips
   red, an incident opens, alerts fire. `docker compose start` → it recovers and the
   incident shows resolved with a duration.

---

## ➕ Add another monitor

Edit `prober/config.json`, then `docker compose restart`. The new card appears automatically.

```json
{
  "monitors": [
    { "id": "home-network", "name": "Home Network", "type": "http", "target": "https://torrent.aswincloud.com" },
    { "id": "jellyfin",     "name": "Jellyfin",     "type": "tcp",  "target": "192.168.1.50:8096" },
    { "id": "router",       "name": "Router",       "type": "ping", "target": "192.168.1.1" }
  ]
}
```

> `ping`/`tcp` to LAN addresses require the prober to have a network route to them.
> To delete a monitor's history immediately:
> `npx wrangler d1 execute status-db --remote --command "DELETE FROM monitors WHERE id='jellyfin'; DELETE FROM checks WHERE monitor_id='jellyfin';"`

---

## 🔔 Alerts

`src/alerts.ts` fires on every down/recovery transition. **Each channel activates only
when its secrets are present** — run any combination, or none. Secrets live in
Cloudflare, never in this repo.

**📧 Email (Resend)**
```bash
npx wrangler secret put RESEND_API_KEY   # resend.com — sending domain must be verified
npx wrangler secret put ALERT_FROM       # "aswincloud status <status@aswincloud.com>"
npx wrangler secret put ALERT_TO         # aswin@aswincloud.com  (comma-separated for several)
```

**💬 Slack** — create an app with the `chat:write` scope, `/invite` the bot to a channel,
grab the channel ID (`C0…`):
```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_CHANNEL
```

**✈ Telegram** — create a bot via **@BotFather**, read your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`:
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

After setting secrets, just push to `main` (or `npx wrangler deploy`) — no code change.

---

## 🔄 Continuous deployment

Connected to **Cloudflare Workers Builds**: every push to `main` runs
`npx wrangler deploy`; pushes to other branches run `npx wrangler versions upload`
(preview). Worker secrets persist across builds.

> The prober is **not** part of this pipeline — it's a container on an external box.
> Update it there with `git pull && docker compose up -d --build`.

---

## 🧪 Local development

```bash
npx wrangler dev                                            # local Worker + D1 at :8787
npx wrangler d1 execute status-db --file schema.sql --local # seed the local DB
cd prober && INGEST_TOKEN=devtoken INGEST_URL=http://localhost:8787/api/ingest node prober.js
# (give wrangler dev the matching token via a .dev.vars file: INGEST_TOKEN="devtoken")
```

Open `http://localhost:8787`.

---

## 📝 Notes & limits

- Fits comfortably in Cloudflare's **free tier** (Workers + D1 + cron).
- Raw checks are pruned after **90 days**; uptime % and the day-bar use indexed
  aggregates, and `/api/status` is **edge-cached ~15s** so page loads never re-scan.
- Tunables: `STALE_MS` (2 min) and `RETENTION_MS` (90 d) in `src/db.ts`; check
  interval in `prober/config.json` (`intervalSeconds`).
- Secrets (`INGEST_TOKEN`, alert credentials) are **Cloudflare Worker secrets** — never committed.

---

<div align="center">
<sub>Built with Cloudflare Workers · D1 · Docker — and zero frontend dependencies.</sub>
</div>
