#!/usr/bin/env node
// aswincloud status — home speed agent.
// Runs AT HOME (so it measures the real home connection). Every intervalSeconds
// it runs an Ookla speed test and POSTs the result to the Worker's /api/speedtest.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.INGEST_TOKEN;
const INGEST_URL = process.env.INGEST_URL || "https://status.aswincloud.com/api/speedtest";
const INTERVAL = (Number(process.env.INTERVAL_SECONDS) || 900) * 1000; // default 15 min
const SPEEDTEST = process.env.SPEEDTEST_BIN || "speedtest";
// Persistent control link: derive the wss:// agent-ws URL from the ingest URL.
const WS_URL =
  process.env.WS_URL ||
  INGEST_URL.replace(/^http/, "ws").replace(/\/speedtest$/, `/agent-ws?token=${encodeURIComponent(TOKEN || "")}`);

if (!TOKEN) {
  console.error("FATAL: INGEST_TOKEN env var is required.");
  process.exit(1);
}

function runSpeedtest() {
  return new Promise((resolve, reject) => {
    execFile(
      SPEEDTEST,
      ["--accept-license", "--accept-gdpr", "-f", "json"],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const r = JSON.parse(stdout);
          // Ookla "bandwidth" is bytes/sec → Mbps = bytes/s * 8 / 1e6.
          const toMbps = (bw) => (bw * 8) / 1e6;
          resolve({
            download_mbps: +toMbps(r.download.bandwidth).toFixed(2),
            upload_mbps: +toMbps(r.upload.bandwidth).toFixed(2),
            ping_ms: r.ping && typeof r.ping.latency === "number" ? +r.ping.latency.toFixed(2) : null,
            server: r.server ? [r.server.name, r.server.location].filter(Boolean).join(", ") : null,
            isp: r.isp || null,
          });
        } catch (e) {
          reject(new Error("could not parse speedtest json: " + e.message));
        }
      },
    );
  });
}

async function push(sample) {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(sample),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${await res.text()}`);
}

// A single in-flight guard so scheduled + on-demand tests never overlap (a test
// saturates the line; running two at once would skew both).
let running = false;

async function cycle(reason) {
  if (running) return;
  running = true;
  const ts = new Date().toISOString();
  try {
    const s = await runSpeedtest();
    await push(s);
    console.log(`[${ts}] ok (${reason}) — ↓${s.download_mbps} ↑${s.upload_mbps} Mbps · ping ${s.ping_ms}ms · ${s.isp || ""}`);
  } catch (err) {
    // A failed test or push is non-fatal — try again next interval.
    console.error(`[${ts}] failed (${reason}): ${err.message}`);
  } finally {
    running = false;
  }
}

// Persistent outbound WebSocket to the Worker (held open by a Durable Object).
// The Worker pushes {cmd:'run'} when someone clicks "Test now" — instant, no poll.
// Auto-reconnects with capped backoff; a heartbeat ping keeps the link healthy.
let ws = null;
let backoff = 1000;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    backoff = 1000;
    console.log(`[${new Date().toISOString()}] control link connected`);
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
    if (msg && msg.cmd === "run") {
      console.log(`[${new Date().toISOString()}] on-demand test requested`);
      cycle("on-demand");
    }
  });

  const reconnect = () => {
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  ws.addEventListener("close", reconnect);
  ws.addEventListener("error", () => { try { ws.close(); } catch { /* ignore */ } });
}

// Keep the link warm (and detect dead sockets) with a periodic ping frame.
setInterval(() => {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd: "ping" })); } catch { /* ignore */ }
}, 45_000);

console.log(`speed agent up · scheduled every ${INTERVAL / 1000}s · on-demand via WebSocket · → ${INGEST_URL}`);
cycle("startup");
setInterval(() => cycle("scheduled"), INTERVAL);
connect();
