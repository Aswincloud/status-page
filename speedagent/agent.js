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

async function cycle() {
  const ts = new Date().toISOString();
  try {
    const s = await runSpeedtest();
    await push(s);
    console.log(`[${ts}] ok — ↓${s.download_mbps} ↑${s.upload_mbps} Mbps · ping ${s.ping_ms}ms · ${s.isp || ""}`);
  } catch (err) {
    // A failed test or push is non-fatal — try again next interval.
    console.error(`[${ts}] failed: ${err.message}`);
  }
}

console.log(`speed agent up · every ${INTERVAL / 1000}s · → ${INGEST_URL}`);
cycle();
setInterval(cycle, INTERVAL);
