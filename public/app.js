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

  // ---- owner sign-in (gates the on-demand "Test now" button) ----
  // The owner signs in with Google; that session is the only thing that unlocks
  // the Test button in the UI. (A CONTROL_TOKEN bearer still works for server-side
  // curl/cron, but the page itself is sign-in only.) The page stays fully public.
  let canTest = false; // is this visitor signed in as owner?
  let agentOnline = false; // is the home agent's WebSocket linked?
  let ssoConfigured = false;
  let sessionEmail = null; // signed-in email (null if not signed in)
  let speedThreshold = null; // current low-speed alert threshold (Mbps)

  async function refreshCanTest() {
    try {
      const res = await fetch("/api/can-test", { cache: "no-store" });
      const j = await res.json();
      canTest = !!j.canTest;
      agentOnline = !!j.agentOnline;
      ssoConfigured = !!j.ssoConfigured;
      sessionEmail = j.email || null;
      speedThreshold = j.speedThreshold ?? null;
    } catch {
      canTest = false;
    }
    reflectUnlock();
    reflectSubscribe(); // prefill email + reveal threshold editor when signed in
    // The Test button lives in the speed panel, which renderSpeed() only rebuilds
    // on a status tick. If our owner state just changed (e.g. just signed in), the
    // panel was likely already rendered without the button — re-render it now so the
    // button appears (or disappears) immediately instead of after the next 20s tick.
    if (canTest !== prevCanTest) {
      prevCanTest = canTest;
      if (lastSpeedData) renderSpeed(lastSpeedData);
    }
  }
  let prevCanTest = false;

  function reflectUnlock() {
    const btn = $("#signin");
    if (!btn) return;
    btn.textContent = canTest ? "Sign out" : "Sign in";
    btn.classList.toggle("active", canTest);
    btn.title = canTest ? "Signed in as owner — click to sign out" : "Sign in (owner)";
  }

  // Which IdPs to offer, fetched lazily from the broker on first sign-in click and
  // cached for the page lifetime. Buttons are driven entirely by this list, so a
  // provider appears the moment its app is added on the broker — no UI change here.
  let providersCache = null;
  async function getProviders() {
    if (providersCache) return providersCache;
    try {
      const r = await fetch("/api/auth/providers", { cache: "no-store" });
      const j = await r.json();
      providersCache = Array.isArray(j.providers) && j.providers.length ? j.providers : null;
    } catch {
      providersCache = null;
    }
    return providersCache || [{ id: "google", name: "Google" }]; // never dead-end
  }

  // Signed in → logout. Signed out → pick a provider: one goes straight there,
  // several open a small popover anchored under the button.
  $("#signin").addEventListener("click", async (e) => {
    if (canTest) {
      window.location.href = "/api/auth/logout";
      return;
    }
    e.stopPropagation();
    const providers = await getProviders();
    if (providers.length === 1) {
      window.location.href = `/api/auth/login?provider=${encodeURIComponent(providers[0].id)}`;
      return;
    }
    openProviderMenu($("#signin"), providers);
  });

  function openProviderMenu(anchor, providers) {
    closeProviderMenu();
    const menu = document.createElement("div");
    menu.className = "provider-menu";
    menu.id = "provider-menu";
    menu.setAttribute("role", "menu");
    for (const p of providers) {
      const a = document.createElement("a");
      a.className = "provider-item";
      a.setAttribute("role", "menuitem");
      a.href = `/api/auth/login?provider=${encodeURIComponent(p.id)}`;
      a.textContent = `Continue with ${p.name}`;
      menu.appendChild(a);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + window.scrollY + 6)}px`;
    menu.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    document.body.appendChild(menu);
    // Defer wiring the outside-click so this same click doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener("click", closeProviderMenu, { once: true });
      document.addEventListener("keydown", onProviderMenuEsc);
    }, 0);
  }
  function onProviderMenuEsc(e) { if (e.key === "Escape") closeProviderMenu(); }
  function closeProviderMenu() {
    const m = $("#provider-menu");
    if (m) m.remove();
    document.removeEventListener("keydown", onProviderMenuEsc);
  }

  // ---- low-speed email subscription ----
  // Visitors: double opt-in (POST → confirmation email → click). The signed-in
  // owner subscribing their OWN email skips opt-in (the session proves ownership),
  // and gets an inline editor to change the alert threshold live.
  let reflectSubscribe = () => {}; // set below; called by refreshCanTest()
  (() => {
    const openBtn = $("#sub-open");
    const modal = $("#sub-modal");
    const form = $("#sub-form");
    const email = $("#sub-email");
    const submit = $("#sub-submit");
    const msg = $("#sub-msg");
    const thr = $("#sub-threshold");
    const thrInput = $("#thr-input");
    const thrSave = $("#thr-save");
    const thrMsg = $("#thr-msg");
    if (!openBtn || !modal || !form) return;

    const showMsg = (text, kind) => {
      msg.textContent = text;
      msg.className = "sub-msg" + (kind ? " " + kind : "");
      msg.hidden = false;
    };

    // ---- modal open/close ----
    let lastFocus = null;
    const openModal = () => {
      lastFocus = document.activeElement;
      modal.hidden = false;
      msg.hidden = true;
      if (sessionEmail && !email.value) email.value = sessionEmail;
      // focus the first useful field
      setTimeout(() => email.focus(), 0);
    };
    const closeModal = () => {
      modal.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };
    openBtn.addEventListener("click", openModal);
    // backdrop + any [data-close] (the × and backdrop) close it
    modal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) closeModal();
    });

    // Prefill the email for the signed-in owner, and show/hide the threshold
    // editor (owner only). Don't clobber a field the user is typing in.
    reflectSubscribe = () => {
      if (sessionEmail && document.activeElement !== email && !email.value) {
        email.value = sessionEmail;
      }
      if (thr) {
        thr.hidden = !canTest;
        if (canTest && speedThreshold != null && document.activeElement !== thrInput) {
          thrInput.value = speedThreshold;
        }
      }
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const addr = email.value.trim();
      if (!addr) return;
      submit.disabled = true;
      submit.textContent = "Sending…";
      try {
        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: addr }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          if (j.status === "active") {
            // Signed-in owner: activated instantly, no email confirmation needed.
            showMsg("Subscribed ✓ — you'll get an email if speed drops.", "ok");
          } else {
            // Generic — we don't reveal whether the address was new.
            showMsg("Check your inbox to confirm your subscription. 📬", "ok");
          }
        } else if (res.status === 429) {
          showMsg("Too many sign-ups right now — try again in a minute.", "err");
        } else if (res.status === 503) {
          showMsg("Email alerts aren't available right now.", "err");
        } else {
          showMsg("That doesn't look like a valid email.", "err");
        }
      } catch {
        showMsg("Network error — please try again.", "err");
      } finally {
        submit.disabled = false;
        submit.textContent = "Subscribe";
      }
    });

    // Threshold editor (owner only) — PATCH the live alert threshold.
    if (thrSave) {
      thrSave.addEventListener("click", async () => {
        const mbps = Number(thrInput.value);
        if (!Number.isFinite(mbps) || mbps <= 0) {
          thrMsg.textContent = "Enter a number > 0";
          thrMsg.className = "thr-msg err";
          return;
        }
        thrSave.disabled = true;
        const prev = thrSave.textContent;
        thrSave.textContent = "Saving…";
        try {
          const res = await fetch("/api/subscribe/threshold", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mbps }),
          });
          if (res.ok) {
            const j = await res.json();
            speedThreshold = j.mbps;
            thrMsg.textContent = `Saved · alert below ${j.mbps} Mbps`;
            thrMsg.className = "thr-msg ok";
          } else if (res.status === 401) {
            thrMsg.textContent = "Sign in to change this.";
            thrMsg.className = "thr-msg err";
          } else {
            thrMsg.textContent = "Couldn't save.";
            thrMsg.className = "thr-msg err";
          }
        } catch {
          thrMsg.textContent = "Network error.";
          thrMsg.className = "thr-msg err";
        } finally {
          thrSave.disabled = false;
          thrSave.textContent = prev;
        }
      });
    }
  })();

  // ---- sign-in result banner ----
  // The OAuth callback can't render UI, so on any failure it redirects to
  // /?auth=<code>. Turn that into a dismissible banner here (with a retry that
  // re-opens Google's account chooser), then scrub the param from the URL.
  function showAuthBanner() {
    const code = new URLSearchParams(location.search).get("auth");
    if (!code) return;
    const messages = {
      denied: "That Google account isn't authorized. Sign in with the owner account.",
      unverified: "That Google account's email isn't verified.",
      state: "Sign-in expired or was interrupted. Please try again.",
      exchange: "Couldn't complete sign-in with Google. Please try again.",
      config: "Sign-in isn't configured on the server.",
    };
    const msg = messages[code] || "Sign-in didn't complete.";
    const retryable = code !== "config";

    const bar = document.createElement("div");
    bar.className = "auth-banner";
    bar.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.className = "auth-banner-msg";
    text.textContent = msg;
    bar.appendChild(text);
    if (retryable) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "auth-banner-btn";
      retry.textContent = "Try another account";
      retry.addEventListener("click", () => { window.location.href = "/api/auth/login"; });
      bar.appendChild(retry);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "auth-banner-x";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () => bar.remove());
    bar.appendChild(close);

    const wrap = $(".wrap") || document.body;
    wrap.insertBefore(bar, wrap.firstChild);

    // Scrub ?auth= so a refresh doesn't re-show it.
    const url = new URL(location.href);
    url.searchParams.delete("auth");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  // ---- on-demand speed test ----
  let testing = false;
  let testPollTimer = null;
  let lastSpeedTs = null; // ts of the latest speed sample seen (to detect a fresh one)
  let lastSpeedData = null; // last speed payload, so we can re-render when canTest flips

  async function requestSpeedTest() {
    if (!canTest || testing) return;
    const baselineTs = lastSpeedTs;
    let res;
    try {
      // Session cookie carries authorization (sign-in only); no header needed.
      res = await fetch("/api/request-test", { method: "POST" });
    } catch {
      setTestBtn("error", "Network error");
      return;
    }
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      setTestBtn("cooldown", `Wait ${Math.ceil((j.retryInSec || 120) / 60)}m`);
      setTimeout(() => setTestBtn("idle"), 4000);
      return;
    }
    if (res.status === 503) {
      setTestBtn("error", "Agent offline");
      setTimeout(() => setTestBtn("idle"), 4000);
      return;
    }
    if (res.status === 401) {
      await refreshCanTest();
      tick();
      return;
    }
    if (!res.ok) {
      setTestBtn("error", "Failed");
      setTimeout(() => setTestBtn("idle"), 4000);
      return;
    }
    // queued — pushed to the agent over WS; wait for a fresh sample (~30s test).
    testing = true;
    setTestBtn("testing");
    let waited = 0;
    clearInterval(testPollTimer);
    testPollTimer = setInterval(async () => {
      waited += 5;
      await tick();
      if (lastSpeedTs && lastSpeedTs !== baselineTs) {
        testing = false;
        clearInterval(testPollTimer);
        setTestBtn("done");
        setTimeout(() => setTestBtn("idle"), 3000);
      } else if (waited > 90) {
        testing = false;
        clearInterval(testPollTimer);
        setTestBtn("timeout", "Still running…");
        setTimeout(() => setTestBtn("idle"), 5000);
      }
    }, 5000);
  }

  function setTestBtn(state, msg) {
    const btn = $("#test-now");
    if (!btn) return;
    btn.classList.toggle("busy", state === "testing");
    btn.disabled = state === "testing" || state === "cooldown";
    const labels = {
      idle: "Test now",
      testing: "Testing…",
      done: "✓ Updated",
      cooldown: msg || "On cooldown",
      timeout: msg || "Still running…",
      error: msg || "Error",
    };
    btn.textContent = labels[state] || "Test now";
  }

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
      hour12: true,
    });
  }

  // 12-hour clock (e.g. "3:05 PM") — shared by chart axes and hover tooltips.
  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
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
  function showTipHTML(html, x, y) {
    tip.innerHTML = html;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
    tip.hidden = false;
  }
  const hideTip = () => (tip.hidden = true);

  // ---- chart cursor: a vertical guide line + marker dot(s), reused across charts.
  // The charts use preserveAspectRatio="none" (x/y stretched), so markers are HTML
  // overlays positioned in screen space — that keeps the dot perfectly round. ----
  function fixedEl(cls) {
    const d = document.createElement("div");
    d.className = cls;
    d.hidden = true;
    document.body.appendChild(d);
    return d;
  }
  const guideEl = fixedEl("chart-guide");
  const dotEls = [fixedEl("chart-dot"), fixedEl("chart-dot")];
  function hideChartCursor() {
    guideEl.hidden = true;
    dotEls.forEach((d) => (d.hidden = true));
    hideTip();
  }

  // Attach hover-to-read to one chart SVG.
  // cfg = { points, vb:{W,H,padT,padB,padX}, top, series:[{key,label,color,unit}] }
  function attachChartHover(svg, cfg) {
    if (!svg || !cfg || !cfg.points || cfg.points.length === 0 || cfg.top == null) return;
    const { points, vb, series } = cfg;
    const top = cfg.top;
    const base = cfg.base ?? 0;
    const n = points.length;
    svg.style.cursor = "crosshair";

    svg.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      let f = (e.clientX - rect.left) / rect.width;
      f = Math.max(0, Math.min(1, f));
      const i = Math.round(f * (n - 1));
      const p = points[i];
      const px = rect.left + (n === 1 ? 0 : i / (n - 1)) * rect.width;

      guideEl.style.left = px + "px";
      guideEl.style.top = rect.top + "px";
      guideEl.style.height = rect.height + "px";
      guideEl.hidden = false;

      const rows = [];
      let topY = null;
      series.forEach((s, si) => {
        const v = p[s.key];
        const dot = dotEls[si];
        if (v == null) {
          if (dot) dot.hidden = true;
          rows.push(`<span class="tip-key" style="color:var(--text-faint,#999)">${s.label}: down</span>`);
          return;
        }
        const vbY = vb.padT + (1 - (v - base) / (top - base)) * (vb.H - vb.padT - vb.padB);
        const py = rect.top + (vbY / vb.H) * rect.height;
        if (dot) {
          dot.style.left = px + "px";
          dot.style.top = py + "px";
          dot.style.background = s.color;
          dot.hidden = false;
        }
        if (topY == null || py < topY) topY = py;
        const val = v >= 100 ? Math.round(v) : v.toFixed(1);
        rows.push(`<span class="tip-key"><i style="background:${s.color}"></i>${s.label}</span> <b>${val}${s.unit ? " " + s.unit : ""}</b>`);
      });
      for (let k = series.length; k < dotEls.length; k++) dotEls[k].hidden = true;

      showTipHTML(`<div class="tip-time">${fmtClock(p.ts)}</div>${rows.join("<br>")}`, px, topY != null ? topY : rect.top);
    });
    svg.addEventListener("mouseleave", hideChartCursor);
  }

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

  // ---- chart scale + axes ----------------------------------------------------
  // Round a number to a "nice" 1/2/5 × 10ⁿ value (for tick steps & bounds).
  function niceNum(x, round) {
    if (!(x > 0)) return 1;
    const e = Math.floor(Math.log10(x));
    const f = x / Math.pow(10, e);
    const nf = round
      ? f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
      : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, e);
  }

  // Smart Y-scale: zero baseline normally; if the data sits in a very tight band
  // high above zero (e.g. a rock-steady 330 Mbps), lift the baseline so the
  // variation is visible — without fully zooming away the zero reference.
  // Returns { base, top, ticks } with clean rounded bounds.
  function computeScale(vals) {
    const dMin = Math.min(...vals);
    const dMax = Math.max(...vals);
    const range = dMax - dMin;
    let lo = 0;
    if (dMin > 0 && range < 0.08 * dMax) {
      // tight band → partial baseline lift (keeps some zero context)
      lo = Math.max(0, dMin - range * 1.2 - dMax * 0.04);
    }
    const step = niceNum((dMax - lo) / 3 || 1, true);
    const base = Math.max(0, Math.floor(lo / step) * step);
    const headroom = (dMax - base) * 0.04;
    let top = Math.ceil((dMax + headroom) / step) * step;
    if (top <= base) top = base + step;
    const ticks = [];
    for (let v = base; v <= top + 1e-9; v += step) ticks.push(+v.toFixed(6));
    return { base, top, ticks };
  }

  const fmtTick = (t) => (t >= 1000 ? t / 1000 + "k" : String(Math.round(t)));

  // Build gridlines (SVG) + Y labels + X time labels for a scale.
  function buildAxes(scale, vb, points) {
    const { base, top, ticks } = scale;
    const { W, H, padT, padB } = vb;
    const yv = (v) => padT + (1 - (v - base) / (top - base)) * (H - padT - padB);
    const grid = ticks
      .map((t) => `<line class="grid" x1="0" y1="${yv(t).toFixed(1)}" x2="${W}" y2="${yv(t).toFixed(1)}"/>`)
      .join("");
    const yLabels = ticks
      .map((t) => `<span style="top:${((yv(t) / H) * 100).toFixed(2)}%">${fmtTick(t)}</span>`)
      .join("");
    let xLabels = "";
    if (points && points.length > 1) {
      // Evenly-spaced time ticks across the window (a real x-axis scale, not just
      // the two endpoints). Index-based like the plotted line, so they line up.
      // .chart-x is flex/space-between, so N spans distribute evenly with no CSS.
      const n = points.length;
      const want = Math.min(5, n);
      const idx = [...new Set(
        Array.from({ length: want }, (_, k) => Math.round((k / (want - 1)) * (n - 1))),
      )];
      xLabels = idx.map((i) => `<span>${fmtClock(points[i].ts)}</span>`).join("");
    }
    return { grid, yLabels, xLabels };
  }

  // ---- latency chart (per-monitor response time, time-series) ----
  // Stretchy SVG (line + gridlines); axis numbers are HTML overlays so they
  // don't distort. viewBox units; CSS sizes it.
  function latencyChart(points, uid) {
    const vb = { W: 600, H: 96, padT: 8, padB: 6, padX: 4 };
    const { W, H, padT, padB, padX } = vb;
    const chartId = "lat-" + uid;
    const lat = points.map((p) => p.latency_ms).filter((v) => v != null);
    if (lat.length === 0) {
      return { html: `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`, hover: null };
    }
    const scale = computeScale(lat);
    const { base, top } = scale;
    const n = points.length;
    const x = (i) => padX + (i / Math.max(1, n - 1)) * (W - 2 * padX);
    const y = (v) => padT + (1 - (v - base) / (top - base)) * (H - padT - padB);

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
    const ax = buildAxes(scale, vb, points);

    const html = `
      <div class="chart-wrap">
        <svg class="chart" data-chart="${chartId}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs><linearGradient id="lg-${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--up)"/><stop offset="1" stop-color="var(--up)" stop-opacity="0"/>
          </linearGradient></defs>
          ${ax.grid}
          ${area}
          <path d="${line}" fill="none" stroke="var(--up)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="chart-y">${ax.yLabels}</div>
      </div>
      <div class="chart-x">${ax.xLabels}</div>`;
    // Normalise points to {ts, latency_ms} for the hover reader.
    const hover = {
      id: chartId,
      cfg: {
        points: points.map((p) => ({ ts: p.ts, latency_ms: p.latency_ms })),
        vb,
        base,
        top,
        series: [{ key: "latency_ms", label: "Response", color: "var(--up)", unit: "ms" }],
      },
    };
    return { html, hover };
  }

  // ---- internet speed panel ----
  let speedUid = 0;
  function renderSpeed(speed) {
    lastSpeedData = speed; // remember so refreshCanTest() can re-render on sign-in
    const section = $("#speed");
    if (!speed || !speed.latest) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const card = $("#speed-card");
    const s = speed;
    const uid = "sp" + speedUid++;

    // Track the freshest sample timestamp (how the on-demand poll detects a new test).
    lastSpeedTs = s.latest.ts;

    // dual-area throughput chart (download teal, upload violet)
    const chart = throughputChart(s.series, uid);
    const fmt = (v) => (v == null ? "—" : v >= 100 ? Math.round(v) : v.toFixed(1));
    // (hover attached after innerHTML below)
    const pingTxt = s.latest.ping != null ? `${s.latest.ping.toFixed(1)} ms` : "—";

    const serverLabel = [s.isp, s.server].filter(Boolean).join(" · ") || "speed test";
    const testBtn = canTest
      ? `<button id="test-now" class="test-now" type="button"${agentOnline ? "" : " disabled title='Home agent offline'"}>${testing ? "Testing…" : "Test now"}</button>`
      : "";
    card.innerHTML = `
      <div class="speed-top">
        <div>
          <div class="speed-title">Internet speed</div>
          <div class="speed-sub">${escapeHtml(serverLabel)}</div>
        </div>
        <div class="speed-actions">
          ${testBtn}
          <div class="speed-ping">
            <div class="stat-label">Ping</div>
            <div class="stat-val">${pingTxt}</div>
          </div>
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

      ${chart.html}

      <div class="speed-legend">
        <span class="key"><span class="swatch dl"></span>Download</span>
        <span class="key"><span class="swatch ul"></span>Upload</span>
        <span class="when">last ${s.windowHours}h · tested ${relTime(s.latest.ts)}</span>
      </div>
    `;

    // hover-to-read on the throughput chart
    if (chart.hover) {
      attachChartHover(card.querySelector(`[data-chart="${chart.hover.id}"]`), chart.hover.cfg);
    }

    // wire the owner-only Test now button (re-created on each render)
    const tn = $("#test-now", card);
    if (tn) {
      if (testing) setTestBtn("testing");
      tn.addEventListener("click", requestSpeedTest);
    }
  }

  // dual stacked-area chart: download + upload Mbps over the window
  function throughputChart(series, uid) {
    const vb = { W: 600, H: 120, padT: 8, padB: 6, padX: 4 };
    const { W, H, padT, padB, padX } = vb;
    const chartId = "spd-" + uid;
    if (!series || series.length === 0) {
      return { html: `<div class="speed-empty">Waiting for the first speed test…</div>`, hover: null };
    }
    const allVals = series.flatMap((p) => [p.down, p.up]);
    const scale = computeScale(allVals);
    const { base, top } = scale;
    const n = series.length;
    const x = (i) => padX + (i / Math.max(1, n - 1)) * (W - 2 * padX);
    const y = (v) => padT + (1 - (v - base) / (top - base)) * (H - padT - padB);

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
    const ax = buildAxes(scale, vb, series);

    const html = `
      <div class="chart-wrap">
        <svg class="speed-chart" data-chart="${chartId}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="dl-${uid}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--dl)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--dl)" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="ul-${uid}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--ul)" stop-opacity="0.30"/><stop offset="1" stop-color="var(--ul)" stop-opacity="0"/>
            </linearGradient>
          </defs>
          ${ax.grid}
          <path d="${ulArea}" fill="url(#ul-${uid})"/>
          <path d="${dlArea}" fill="url(#dl-${uid})"/>
          <path d="${ulLine}" fill="none" stroke="var(--ul)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          <path d="${dlLine}" fill="none" stroke="var(--dl)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="chart-y">${ax.yLabels}</div>
      </div>
      <div class="chart-x">${ax.xLabels}</div>`;
    const hover = {
      id: chartId,
      cfg: {
        points: series.map((p) => ({ ts: p.ts, down: p.down, up: p.up })),
        vb,
        base,
        top,
        series: [
          { key: "down", label: "Download", color: "var(--dl)", unit: "Mbps" },
          { key: "up", label: "Upload", color: "var(--ul)", unit: "Mbps" },
        ],
      },
    };
    return { html, hover };
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

    const latChart = latencyChart(m.latency, m.id);

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
      ${latChart.html}
    `;

    // wire tooltips on day cells
    card.querySelectorAll(".day").forEach((cell) => {
      cell.addEventListener("mouseenter", (e) => {
        const r = e.target.getBoundingClientRect();
        showTip(e.target.dataset.tip, r.left + r.width / 2, r.top);
      });
      cell.addEventListener("mouseleave", hideTip);
    });

    // hover-to-read on the response-time chart
    if (latChart.hover) {
      attachChartHover(card.querySelector(`[data-chart="${latChart.hover.id}"]`), latChart.hover.cfg);
    }

    return card;
  }

  // ---- incidents ----
  const INCIDENTS_SHOWN = 5; // collapse the rest behind a "Show more" button
  let incidentsExpanded = false;
  let lastIncidents = []; // cached so the Show more/less toggle re-renders without a refetch

  $("#incident-more").addEventListener("click", () => {
    incidentsExpanded = !incidentsExpanded;
    renderIncidents(lastIncidents);
  });

  function incidentItem(inc) {
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
  }

  function renderIncidents(incidents) {
    lastIncidents = incidents || [];
    const list = $("#incident-list");
    const moreBtn = $("#incident-more");
    if (!incidents || incidents.length === 0) {
      list.innerHTML = `<li class="incident-empty">No incidents in the last 90 days. 🎉</li>`;
      if (moreBtn) moreBtn.hidden = true;
      return;
    }
    // Most recent first; show the first N unless the user expanded the list.
    const sorted = [...incidents].sort((a, b) => b.started_at - a.started_at);
    const hiddenCount = Math.max(0, sorted.length - INCIDENTS_SHOWN);
    const visible = incidentsExpanded ? sorted : sorted.slice(0, INCIDENTS_SHOWN);
    list.innerHTML = visible.map(incidentItem).join("");

    if (moreBtn) {
      if (hiddenCount === 0) {
        moreBtn.hidden = true;
      } else {
        moreBtn.hidden = false;
        moreBtn.textContent = incidentsExpanded
          ? "Show less"
          : `Show ${hiddenCount} more`;
      }
    }
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

  showAuthBanner(); // surface any ?auth=<code> from a failed sign-in callback
  refreshCanTest(); // decide whether to show the Test button (home / session / token)
  tick();
  setInterval(tick, REFRESH_MS);
  setInterval(refreshCanTest, 60_000); // re-check (IP can change; session can expire)
  // refresh immediately when the tab regains focus
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      tick();
      refreshCanTest();
    }
  });
})();
