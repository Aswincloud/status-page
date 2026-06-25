// Alert hook. Each channel activates only when its env vars are present, so the
// page works with any combination of channels (or none).
//   - Email   : RESEND_API_KEY + ALERT_FROM + ALERT_TO
//   - Slack    : SLACK_BOT_TOKEN + SLACK_CHANNEL
//   - Telegram : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID

import type { Env, MonitorRow } from "./db";
import {
  listActiveSubscribers,
  markSubscriberAlerted,
  getControl,
  setControl,
} from "./db";

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

  await Promise.allSettled([
    sendEmail(env, subject, line, monitor, ev),
    sendSlack(env, monitor, line, ev),
    sendTelegram(env, emoji, line),
  ]);
}

// ---- Slack (bot token, chat.postMessage) ----
async function sendSlack(env: Env, monitor: MonitorRow, line: string, ev: AlertEvent): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL) return;

  const down = ev.kind === "down";
  const emoji = down ? "🔴" : "🟢";
  const headline = `${emoji} ${monitor.name} ${down ? "is DOWN" : "recovered"}`;

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: env.SLACK_CHANNEL,
        text: headline, // fallback / notification text
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${headline}*\n${line}` } },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `${monitor.type} · ${monitor.target}` },
              { type: "mrkdwn", text: "<https://status.aswincloud.com|View status page>" },
            ],
          },
        ],
      }),
    });
    const j: { ok?: boolean; error?: string } = await res.json();
    if (!j.ok) console.error("slack send failed", j.error);
  } catch (err) {
    console.error("slack error", err);
  }
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

// ---- subscriber low-speed alerts ----------------------------------------------

const DEFAULT_SPEED_ALERT_MBPS = 150;
const SUB_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // per-subscriber: at most one low-speed email / 6h
const GLOBAL_LOWSPEED_GAP_MS = 30 * 60 * 1000; // don't even evaluate fan-out more than once / 30m

// Synchronous fallback (env var → built-in default), used where we only have env.
function speedThreshold(env: Env): number {
  const n = Number(env.SPEED_ALERT_MBPS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SPEED_ALERT_MBPS;
}

// The live threshold: a runtime-editable value in the `control` table (set from the
// signed-in UI) takes precedence over the env-var default, so it can change without
// a redeploy. Falls back to the env var, then the built-in default.
export async function liveSpeedThreshold(env: Env): Promise<number> {
  const v = await getControl(env.DB, "speed_alert_mbps");
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return speedThreshold(env);
}

function publicOrigin(env: Env): string {
  return (env.PUBLIC_ORIGIN || "https://status.aswincloud.com").replace(/\/$/, "");
}

// Low-overhead Resend send helper (subject + html + text + a single recipient).
async function resendSend(env: Env, to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.ALERT_FROM) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.ALERT_FROM, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      console.error("resend send failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("resend error", err);
    return false;
  }
}

function emailShell(inner: string): string {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14151a">
    <div style="border:1px solid #e3e6ea;border-radius:14px;padding:24px">${inner}</div>
    <p style="text-align:center;color:#9aa0ab;font-size:11px;margin-top:14px">aswincloud status</p>
  </div>`;
}

// Sent once when someone subscribes — they must click to confirm (double opt-in).
export async function sendConfirmEmail(env: Env, email: string, confirmToken: string): Promise<boolean> {
  const url = `${publicOrigin(env)}/api/subscribe/confirm?token=${encodeURIComponent(confirmToken)}`;
  const subject = "Confirm your aswincloud status alerts";
  const html = emailShell(`
      <strong style="font-size:17px">Confirm your subscription</strong>
      <p style="margin:12px 0 6px;font-size:14px;color:#5d6470">You asked to receive low-speed alerts for the aswincloud home network. Click below to start receiving them.</p>
      <p style="margin:0 0 18px;font-size:12px;color:#9aa0ab">If this wasn't you, just ignore this email — nothing happens without confirming.</p>
      <a href="${url}" style="display:inline-block;background:#14151a;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px">Confirm subscription →</a>`);
  const text = `Confirm your aswincloud status low-speed alerts:\n${url}\n\nIf this wasn't you, ignore this email.`;
  return resendSend(env, email, subject, html, text);
}

// Sent after a successful confirm.
export async function sendWelcomeEmail(env: Env, email: string, unsubToken: string): Promise<boolean> {
  const unsub = `${publicOrigin(env)}/api/subscribe/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
  const subject = "You're subscribed to aswincloud status alerts";
  const html = emailShell(`
      <strong style="font-size:17px">Subscription confirmed ✓</strong>
      <p style="margin:12px 0 18px;font-size:14px;color:#5d6470">You'll get an email if the home internet speed drops below ${speedThreshold(env)} Mbps. We keep it quiet — at most one alert every few hours.</p>
      <a href="${publicOrigin(env)}" style="display:inline-block;background:#14151a;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px">View status page →</a>
      <p style="margin:16px 0 0;font-size:11px;color:#9aa0ab">Don't want these? <a href="${unsub}" style="color:#9aa0ab">Unsubscribe</a>.</p>`);
  const text = `You're subscribed to aswincloud low-speed alerts (below ${speedThreshold(env)} Mbps).\n\nUnsubscribe: ${unsub}`;
  return resendSend(env, email, subject, html, text);
}

// Called on each new speed sample. If down OR up is below the threshold, email
// all active subscribers — globally throttled (≤1 fan-out per 30m) and per-
// subscriber throttled (≤1 per 6h) so a sustained dip can't spam anyone.
export async function notifyLowSpeed(env: Env, downMbps: number, upMbps: number, ts: number): Promise<void> {
  const threshold = await liveSpeedThreshold(env);
  if (downMbps >= threshold && upMbps >= threshold) return; // speed is fine
  if (!env.RESEND_API_KEY || !env.ALERT_FROM) return; // email not configured

  // Global gate: don't even scan subscribers more than once per GLOBAL gap.
  const lastFan = Number((await getControl(env.DB, "lowspeed_fanout_at")) ?? 0);
  if (ts - lastFan < GLOBAL_LOWSPEED_GAP_MS) return;

  const subs = await listActiveSubscribers(env.DB);
  if (subs.length === 0) return;
  await setControl(env.DB, "lowspeed_fanout_at", String(ts));

  const origin = publicOrigin(env);
  const worst = Math.min(downMbps, upMbps);
  const subject = `🐢 Home internet is slow — ${worst.toFixed(0)} Mbps`;
  const detail = `Download ${downMbps.toFixed(0)} Mbps · Upload ${upMbps.toFixed(0)} Mbps (alert threshold ${threshold} Mbps).`;

  for (const s of subs) {
    if (s.last_alert_at && ts - s.last_alert_at < SUB_ALERT_COOLDOWN_MS) continue; // recently warned
    const unsub = `${origin}/api/subscribe/unsubscribe?token=${encodeURIComponent(s.unsub_token)}`;
    const html = emailShell(`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="width:12px;height:12px;border-radius:50%;background:#ffd60a;display:inline-block"></span>
        <strong style="font-size:17px">Home internet is running slow</strong>
      </div>
      <p style="margin:0 0 6px;font-size:14px;color:#5d6470">${escapeHtml(detail)}</p>
      <p style="margin:0 0 18px;font-size:13px;color:#9aa0ab">Measured ${new Date(ts).toISOString().replace("T", " ").slice(0, 16)} UTC</p>
      <a href="${origin}" style="display:inline-block;background:#14151a;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px">View status page →</a>
      <p style="margin:16px 0 0;font-size:11px;color:#9aa0ab"><a href="${unsub}" style="color:#9aa0ab">Unsubscribe</a></p>`);
    const text = `Home internet is slow. ${detail}\n\nView: ${origin}\nUnsubscribe: ${unsub}`;
    const ok = await resendSend(env, s.email, subject, html, text);
    if (ok) await markSubscriberAlerted(env.DB, s.id, ts);
  }
}
