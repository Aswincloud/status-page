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

  // ---- sparkline (SVG path) ----
  function sparkline(points) {
    const W = 220,
      H = 40,
      pad = 3;
    const lat = points.map((p) => p.latency_ms).filter((v) => v != null);
    if (lat.length === 0) {
      return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    }
    const min = Math.min(...lat);
    const max = Math.max(...lat);
    const span = max - min || 1;
    const n = points.length;
    const x = (i) => pad + (i / Math.max(1, n - 1)) * (W - 2 * pad);
    const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);

    // Build path, breaking the line at down points (null latency).
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      if (p.latency_ms == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(p.latency_ms).toFixed(1)} `;
      pen = true;
    });

    // Area fill under the line (for the contiguous tail).
    const lastUp = points[n - 1].latency_ms != null;
    let area = "";
    if (lastUp) {
      // simple gradient fill from the visible line down
      area = `<path d="${d}L${x(n - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z" fill="url(#sg)" opacity="0.12"/>`;
    }
    return `
      <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--up)"/><stop offset="1" stop-color="var(--up)" stop-opacity="0"/>
        </linearGradient></defs>
        ${area}
        <path d="${d}" fill="none" stroke="var(--up)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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

      <div class="spark-row">
        ${sparkline(m.latency)}
        <div class="spark-meta">${lastLatency}<br><span style="color:var(--text-faint)">checked ${relTime(m.last_checked)}</span></div>
      </div>
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
