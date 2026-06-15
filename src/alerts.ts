// Alert hook — intentionally dormant until credentials are provided via env vars.
// Wire-up later: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID as wrangler secrets and
// redeploy; no code change needed. Email can be added the same way.

import type { Env, MonitorRow } from "./db";

export interface AlertEvent {
  kind: "down" | "recovered";
  since: number; // unix ms the incident started
  durationMs?: number; // set on recovery
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export async function notify(env: Env, monitor: MonitorRow, ev: AlertEvent): Promise<void> {
  // No channel configured → silently do nothing. This is the "decide later" state.
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const emoji = ev.kind === "down" ? "🔴" : "🟢";
  const when = new Date(ev.since).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const text =
    ev.kind === "down"
      ? `${emoji} *${monitor.name}* is DOWN\nsince ${when}`
      : `${emoji} *${monitor.name}* recovered\nwas down ${fmtDuration(ev.durationMs ?? 0)}`;

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("alert send failed", err);
  }
}
