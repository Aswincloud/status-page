#!/usr/bin/env node
// aswincloud status prober.
// Runs on an external 24/7 server. Every `intervalSeconds` it checks each monitor
// (ping / http / tcp), measures latency, and POSTs a batch heartbeat to the Worker.
// The Worker's config.json is the single source of truth for which monitors exist.

import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const cfg = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));
const TOKEN = process.env.INGEST_TOKEN;
const INGEST_URL = process.env.INGEST_URL || cfg.ingestUrl;
const INTERVAL = (cfg.intervalSeconds || 30) * 1000;

// Flap damping: each cycle, sample the monitor several times across a short window
// and only report a flip when it's UNANIMOUS — an outage requires the whole window
// offline, a recovery requires the whole window available. A mixed window (a blip)
// holds the previous state, so one transient failure never opens/closes an incident.
const CONFIRM_SECONDS = cfg.confirmSeconds || 5; // window length
const CONFIRM_SAMPLES = cfg.confirmSamples || 5; // samples within the window
const SAMPLE_TIMEOUT = cfg.sampleTimeoutSec || 2; // per-sample timeout (kept short so the window stays ~CONFIRM_SECONDS)
const lastState = new Map(); // monitor id → last reported up(bool), for hysteresis

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) {
  console.error("FATAL: INGEST_TOKEN env var is required (see .env.example).");
  process.exit(1);
}
if (!INGEST_URL || INGEST_URL.includes("PLACEHOLDER")) {
  console.error("FATAL: set ingestUrl in config.json (or INGEST_URL env).");
  process.exit(1);
}

// ---- check implementations ----

function checkPing(host, timeoutSec = 3) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Linux iputils ping: -c1 one packet, -w deadline seconds.
    execFile("ping", ["-c", "1", "-w", String(timeoutSec), host], { timeout: timeoutSec * 1000 + 500 }, (err, stdout) => {
      if (err) return resolve({ up: false, latency_ms: null });
      // Prefer the real RTT from "time=12.3 ms"; fall back to wall time.
      const m = /time[=<]([\d.]+)\s*ms/i.exec(stdout);
      const latency = m ? Math.round(parseFloat(m[1])) : Date.now() - t0;
      resolve({ up: true, latency_ms: latency });
    });
  });
}

async function checkHttp(url, timeoutSec = 8) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    // Up if the server answered with anything below 500.
    return { up: res.status < 500, latency_ms: Date.now() - t0 };
  } catch {
    return { up: false, latency_ms: null };
  } finally {
    clearTimeout(timer);
  }
}

function checkTcp(host, port, timeoutSec = 5) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (up) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ up, latency_ms: up ? Date.now() - t0 : null });
    };
    sock.setTimeout(timeoutSec * 1000);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

async function runCheck(mon, timeoutSec) {
  if (mon.type === "ping") return checkPing(mon.target, timeoutSec ?? 3);
  if (mon.type === "http") return checkHttp(mon.target, timeoutSec ?? 8);
  if (mon.type === "tcp") {
    const [host, port] = String(mon.target).split(":");
    return checkTcp(host, Number(port || 80), timeoutSec ?? 5);
  }
  console.warn(`unknown monitor type '${mon.type}' for ${mon.id}; marking down`);
  return { up: false, latency_ms: null };
}

// Sample a monitor across the confirm window and return a debounced verdict.
//   all samples up   → { up: true }   (5s continuously available  → recovered)
//   all samples down → { up: false }  (5s continuously offline     → outage)
//   mixed (a blip)   → hold the previous reported state
// Short-circuits as soon as the window is mixed, so a healthy monitor still
// finishes in one sample and a flip is only ever reported on a unanimous window.
async function confirmedCheck(mon) {
  const prev = lastState.has(mon.id) ? lastState.get(mon.id) : true; // assume up before first data
  const gap = CONFIRM_SAMPLES > 1 ? (CONFIRM_SECONDS * 1000) / (CONFIRM_SAMPLES - 1) : 0;

  const first = await runCheck(mon, SAMPLE_TIMEOUT);
  let lastLatency = first.latency_ms;

  for (let i = 1; i < CONFIRM_SAMPLES; i++) {
    await sleep(gap);
    const r = await runCheck(mon, SAMPLE_TIMEOUT);
    if (r.up !== first.up) {
      // Window disagrees → a blip. Hold previous state; don't flip.
      lastState.set(mon.id, prev);
      return { up: prev, latency_ms: prev ? (r.latency_ms ?? lastLatency) : null, flapped: true };
    }
    if (r.latency_ms != null) lastLatency = r.latency_ms;
  }

  // Unanimous window → trust it.
  lastState.set(mon.id, first.up);
  return { up: first.up, latency_ms: first.up ? lastLatency : null, flapped: false };
}

// ---- main loop ----

async function cycle() {
  const results = await Promise.all(
    cfg.monitors.map(async (mon) => ({ mon, r: await confirmedCheck(mon) })),
  );
  // What we send the Worker (its schema doesn't include `flapped`).
  const checks = results.map(({ mon, r }) => ({
    id: mon.id,
    name: mon.name,
    type: mon.type,
    target: mon.target,
    up: r.up,
    latency_ms: r.latency_ms,
  }));

  const summary = results
    .map(({ mon, r }) => `${mon.id}:${r.up ? (r.latency_ms ?? "?") + "ms" : "DOWN"}${r.flapped ? "(flap→held)" : ""}`)
    .join("  ");
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ checks }),
    });
    if (!res.ok) {
      console.error(`[${new Date().toISOString()}] ingest ${res.status} — ${summary}`);
    } else {
      console.log(`[${new Date().toISOString()}] ok — ${summary}`);
    }
  } catch (err) {
    // Network blip pushing to the Worker — the Worker's watchdog covers the gap.
    console.error(`[${new Date().toISOString()}] push failed: ${err.message} — ${summary}`);
  }
}

console.log(
  `prober up · ${cfg.monitors.length} monitor(s) · every ${INTERVAL / 1000}s · ` +
  `confirm ${CONFIRM_SAMPLES}×/${CONFIRM_SECONDS}s before flipping · → ${INGEST_URL}`,
);

// Self-scheduling loop: wait INTERVAL AFTER each cycle finishes, so a slow cycle
// (e.g. a down-confirm window) can never overlap the next one.
async function loop() {
  await cycle();
  setTimeout(loop, INTERVAL);
}
loop();
