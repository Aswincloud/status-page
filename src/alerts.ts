// Alert hook. Each channel activates only when its env vars are present, so the
// page works with no alerts, email only, Telegram only, or both.
//   - Email  : RESEND_API_KEY + ALERT_FROM + ALERT_TO
//   - Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID

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
  const when = new Date(ev.since).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const down = ev.kind === "down";
  const emoji = down ? "🔴" : "🟢";
  const subject = down
    ? `🔴 ${monitor.name} is DOWN`
    : `🟢 ${monitor.name} recovered`;
  const line = down
    ? `${monitor.name} is DOWN since ${when}.`
    : `${monitor.name} recovered — was down for ${fmtDuration(ev.durationMs ?? 0)}.`;

  await Promise.allSettled([sendEmail(env, subject, line, monitor, ev), sendTelegram(env, emoji, line)]);
}

// ---- Email via Resend ----
async function sendEmail(
  env: Env,
  subject: string,
  line: string,
  monitor: MonitorRow,
  ev: AlertEvent,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.ALERT_FROM || !env.ALERT_TO) return;

  const down = ev.kind === "down";
  const color = down ? "#ff453a" : "#30d158";
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14151a">
    <div style="border:1px solid #e3e6ea;border-radius:14px;padding:24px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="width:12px;height:12px;border-radius:50%;background:${color};display:inline-block"></span>
        <strong style="font-size:17px">${escapeHtml(monitor.name)} ${down ? "is down" : "recovered"}</strong>
      </div>
      <p style="margin:0 0 6px;font-size:14px;color:#5d6470">${escapeHtml(line)}</p>
      <p style="margin:0 0 18px;font-size:13px;color:#9aa0ab">${escapeHtml(monitor.type)} · ${escapeHtml(monitor.target)}</p>
      <a href="https://status.aswincloud.com" style="display:inline-block;background:#14151a;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px">View status page →</a>
    </div>
    <p style="text-align:center;color:#9aa0ab;font-size:11px;margin-top:14px">aswincloud status · automated alert</p>
  </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.ALERT_FROM,
        to: env.ALERT_TO.split(",").map((s) => s.trim()),
        subject,
        text: `${line}\n\nView: https://status.aswincloud.com`,
        html,
      }),
    });
    if (!res.ok) console.error("resend send failed", res.status, await res.text());
  } catch (err) {
    console.error("resend error", err);
  }
}

// ---- Telegram (optional) ----
async function sendTelegram(env: Env, emoji: string, line: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${emoji} ${line}` }),
    });
  } catch (err) {
    console.error("telegram send failed", err);
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
