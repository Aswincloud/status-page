/* aswincloud status — front-end. No dependencies.
   Polls /api/status, renders the overall banner, monitor cards (90-day bar,
   uptime stats, latency sparkline), and the incident timeline. */

(() => {
  "use strict";

  const REFRESH_MS = 20_000;
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---- theme toggle (persisted) ----
  const root = document.documentElement;
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  $("#theme-toggle").addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  });

  // ---- helpers ----
  const pct = (v) => (v == null ? "—" : `${v.toFixed(v >= 99.95 || v === 0 ? (v === 100 ? 0 : 2) : 2)}%`);

  function relTime(ts) {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ---- tooltip (shared, for day bars) ----
  const tip = $("#tip");
  function showTip(text, x, y) {
    tip.textContent = text;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
    tip.hidden = false;
  }
  const hideTip = () => (tip.hidden = true);

  // ---- overall banner ----
  function renderOverall(data) {
    const el = $("#overall");
    const title = $("#overall-title");
    const sub = $("#overall-sub");
    el.className = "overall";
    const total = data.monitors.length;
    const up = data.monitors.filter((m) => m.up).length;

    if (data.overall === "operational") {
      el.classList.add("overall--operational");
      title.textContent = "All systems operational";
      sub.textContent = total === 1 ? "1 monitor up" : `${up}/${total} monitors up`;
    } else if (data.overall === "partial") {
      el.classList.add("overall--partial");
      title.textContent = "Partial outage";
      sub.textContent = `${total - up} of ${total} monitors down`;
    } else if (data.overall === "major") {
      el.classList.add("overall--major");
      title.textContent = "Major outage";
      sub.textContent = "All monitors are down";
    } else {
      el.classList.add("overall--loading");
      title.textContent = "No monitors yet";
      sub.textContent = "Waiting for the first heartbeat";
    }
  }

  // ---- latency chart (per-monitor response time, time-series) ----
  // Larger than a sparkline: y-axis max label, gridline, gradient area, line
  // that breaks on downtime. viewBox units; CSS sizes it.
  function latencyChart(points, uid) {
    const W = 600,
      H = 96,
      padT = 8,
      padB = 6,
      padX = 4;
    const lat = points.map((p) => p.latency_ms).filter((v) => v != null);
    if (lat.length === 0) {
      return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    }
    const max = Math.max(...lat);
    const min = Math.min(...lat);
    const top = max * 1.15 || 1; // headroom; baseline at 0 for honest scale
    const n = points.length;
    const x = (i) => padX + (i / Math.max(1, n - 1)) * (W - 2 * padX);
    const y = (v) => padT + (1 - v / top) * (H - padT - padB);

    let line = "";
    let pen = false;
    points.forEach((p, i) => {
      if (p.latency_ms == null) {
        pen = false;
        return;
      }
      line += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(p.latency_ms).toFixed(1)} `;
      pen = true;
    });
    const lastUp = points[n - 1].latency_ms != null;
    const area = lastUp
      ? `<path d="${line}L${x(n - 1).toFixed(1)} ${H - padB} L${x(0).toFixed(1)} ${H - padB} Z" fill="url(#lg-${uid})" opacity="0.16"/>`
      : "";
    const midY = y(top / 2).toFixed(1);

    return `
      <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="lg-${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--up)"/><stop offset="1" stop-color="var(--up)" stop-opacity="0"/>
        </linearGradient></defs>
        <line class="grid" x1="0" y1="${midY}" x2="${W}" y2="${midY}"/>
        ${area}
        <path d="${line}" fill="none" stroke="var(--up)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>`;
  }

  // ---- internet speed panel ----
  let speedUid = 0;
  function renderSpeed(speed) {
    const section = $("#speed");
    if (!speed || !speed.latest) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const card = $("#speed-card");
    const s = speed;
    const uid = "sp" + speedUid++;

    // dual-area throughput chart (download teal, upload violet)
    const chart = throughputChart(s.series, uid);
    const fmt = (v) => (v == null ? "—" : v >= 100 ? Math.round(v) : v.toFixed(1));
    const pingTxt = s.latest.ping != null ? `${s.latest.ping.toFixed(1)} ms` : "—";

    const serverLabel = [s.isp, s.server].filter(Boolean).join(" · ") || "speed test";
    card.innerHTML = `
      <div class="speed-top">
        <div>
          <div class="speed-title">Internet speed</div>
          <div class="speed-sub">${escapeHtml(serverLabel)}</div>
        </div>
        <div class="speed-ping">
          <div class="stat-label">Ping</div>
          <div class="stat-val">${pingTxt}</div>
        </div>
      </div>

      <div class="speed-now">
        <div class="reading dl">
          <div class="reading-head"><span class="reading-dot"></span><span class="reading-label">Download</span></div>
          <div class="reading-val">${fmt(s.latest.down)}<span class="unit">Mbps</span></div>
          <div class="reading-meta">avg ${fmt(s.avgDown)} · peak ${fmt(s.peakDown)}</div>
        </div>
        <div class="reading ul">
          <div class="reading-head"><span class="reading-dot"></span><span class="reading-label">Upload</span></div>
          <div class="reading-val">${fmt(s.latest.up)}<span class="unit">Mbps</span></div>
          <div class="reading-meta">avg ${fmt(s.avgUp)} · peak ${fmt(s.peakUp)}</div>
        </div>
      </div>

      ${chart}

      <div class="speed-legend">
        <span class="key"><span class="swatch dl"></span>Download</span>
        <span class="key"><span class="swatch ul"></span>Upload</span>
        <span class="when">last ${s.windowHours}h · tested ${relTime(s.latest.ts)}</span>
      </div>
    `;
  }

  // dual stacked-area chart: download + upload Mbps over the window
  function throughputChart(series, uid) {
    const W = 600,
      H = 120,
      padT = 8,
      padB = 6,
      padX = 4;
    if (!series || series.length === 0) {
      return `<div class="speed-empty">Waiting for the first speed test…</div>`;
    }
    const allVals = series.flatMap((p) => [p.down, p.up]);
    const top = Math.max(...allVals) * 1.15 || 1;
    const n = series.length;
    const x = (i) => padX + (i / Math.max(1, n - 1)) * (W - 2 * padX);
    const y = (v) => padT + (1 - v / top) * (H - padT - padB);

    const pathFor = (key) => {
      let d = "";
      series.forEach((p, i) => {
        d += `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)} `;
      });
      return d;
    };
    const dlLine = pathFor("down");
    const ulLine = pathFor("up");
    const baseline = H - padB;
    const dlArea = `${dlLine}L${x(n - 1).toFixed(1)} ${baseline} L${x(0).toFixed(1)} ${baseline} Z`;
    const ulArea = `${ulLine}L${x(n - 1).toFixed(1)} ${baseline} L${x(0).toFixed(1)} ${baseline} Z`;
    const midY = y(top / 2).toFixed(1);

    return `
      <svg class="speed-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="dl-${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--dl)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--dl)" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="ul-${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--ul)" stop-opacity="0.30"/><stop offset="1" stop-color="var(--ul)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line class="grid" x1="0" y1="${midY}" x2="${W}" y2="${midY}"/>
        <path d="${ulArea}" fill="url(#ul-${uid})"/>
        <path d="${dlArea}" fill="url(#dl-${uid})"/>
        <path d="${ulLine}" fill="none" stroke="var(--ul)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        <path d="${dlLine}" fill="none" stroke="var(--dl)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>`;
  }

  // ---- monitor card ----
  function renderCard(m) {
    const card = document.createElement("div");
    card.className = "card";

    const statusClass = m.up ? "up" : "down";
    const statusLabel = m.up ? "Operational" : m.stale ? "No data" : "Down";

    // day bar
    const dayHtml = m.days
      .map((d) => {
        const label =
          d.state === "nodata"
            ? "No data"
            : `${d.uptime != null ? d.uptime.toFixed(d.uptime === 100 ? 0 : 1) + "% up" : ""}`;
        const date = new Date(d.day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        return `<div class="day ${d.state}" data-tip="${date} · ${label || d.state}"></div>`;
      })
      .join("");

    const firstDay = m.days.find((d) => d.state !== "nodata");
    const rangeLabel = firstDay
      ? new Date(firstDay.day).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "90 days ago";

    const lastLatency =
      m.last_latency_ms != null ? `<b>${Math.round(m.last_latency_ms)} ms</b>` : "—";

    card.innerHTML = `
      <div class="card-top">
        <div class="card-id">
          <span class="status-dot ${statusClass}"></span>
          <div style="min-width:0">
            <div class="card-name">${escapeHtml(m.name)}</div>
            <div class="card-target">${escapeHtml(m.type)} · ${escapeHtml(m.target)}</div>
          </div>
        </div>
        <span class="pill ${statusClass}">${statusLabel}</span>
      </div>

      <div class="daybar">${dayHtml}</div>
      <div class="daybar-legend"><span>${rangeLabel}</span><span>today</span></div>

      <div class="stats">
        <div class="stat"><div class="stat-label">24h</div><div class="stat-val ${m.uptime.d1 == null ? "muted" : ""}">${pct(m.uptime.d1)}</div></div>
        <div class="stat"><div class="stat-label">7 days</div><div class="stat-val ${m.uptime.d7 == null ? "muted" : ""}">${pct(m.uptime.d7)}</div></div>
        <div class="stat"><div class="stat-label">30 days</div><div class="stat-val ${m.uptime.d30 == null ? "muted" : ""}">${pct(m.uptime.d30)}</div></div>
      </div>

      <div class="chart-head">
        <span class="chart-title">Response time</span>
        <span class="chart-now">${lastLatency} · <span style="color:var(--text-faint)">checked ${relTime(m.last_checked)}</span></span>
      </div>
      ${latencyChart(m.latency, m.id)}
    `;

    // wire tooltips on day cells
    card.querySelectorAll(".day").forEach((cell) => {
      cell.addEventListener("mouseenter", (e) => {
        const r = e.target.getBoundingClientRect();
        showTip(e.target.dataset.tip, r.left + r.width / 2, r.top);
      });
      cell.addEventListener("mouseleave", hideTip);
    });

    return card;
  }

  // ---- incidents ----
  function renderIncidents(incidents) {
    const list = $("#incident-list");
    if (!incidents || incidents.length === 0) {
      list.innerHTML = `<li class="incident-empty">No incidents in the last 90 days. 🎉</li>`;
      return;
    }
    list.innerHTML = incidents
      .map((inc) => {
        const ongoing = inc.resolved_at == null;
        const dur = ongoing
          ? fmtDur(Date.now() - inc.started_at)
          : fmtDur(inc.resolved_at - inc.started_at);
        return `
        <li class="incident ${ongoing ? "ongoing" : "resolved"}">
          <span class="incident-icon"></span>
          <div class="incident-body">
            <div class="incident-name">${escapeHtml(inc.monitor_name)} ${ongoing ? "is down" : "outage"}</div>
            <div class="incident-when">${fmtDate(inc.started_at)}${ongoing ? "" : " → " + fmtDate(inc.resolved_at)}</div>
          </div>
          <div class="incident-dur ${ongoing ? "ongoing" : ""}">${ongoing ? "ongoing · " + dur : dur}</div>
        </li>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- main render + poll ----
  async function tick() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error("status " + res.status);
      const data = await res.json();

      renderOverall(data);

      const mon = $("#monitors");
      mon.removeAttribute("aria-busy");
      mon.innerHTML = "";
      if (data.monitors.length === 0) {
        mon.innerHTML = `<div class="incident-empty">No monitors reporting yet. Start the prober to see data here.</div>`;
      } else {
        data.monitors.forEach((m) => mon.appendChild(renderCard(m)));
      }

      renderSpeed(data.speed);
      renderIncidents(data.incidents);
      $("#updated").textContent = "Updated " + relTime(data.generated_at);
    } catch (err) {
      $("#overall-sub").textContent = "Couldn't reach the status API — retrying…";
      console.error(err);
    }
  }

  tick();
  setInterval(tick, REFRESH_MS);
  // refresh immediately when the tab regains focus
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
})();
