// Durable Object that holds the home speed-agent's persistent outbound WebSocket.
// The agent connects once and keeps it open; the Worker asks this DO to push a
// "run test" command down that socket on demand — true push, no polling, and no
// inbound exposure to the home network (the socket is outbound from home).

import type { Env } from "./db";

export class AgentLink {
  state: DurableObjectState;
  env: Env;
  socket: WebSocket | null = null;
  connectedAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // The agent upgrades here to establish the long-lived link.
    if (url.pathname === "/connect") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      // Replace any stale socket with the new one.
      if (this.socket) {
        try { this.socket.close(1000, "replaced"); } catch { /* ignore */ }
      }
      this.socket = server;
      this.connectedAt = Date.now();

      server.addEventListener("close", () => {
        if (this.socket === server) this.socket = null;
      });
      server.addEventListener("error", () => {
        if (this.socket === server) this.socket = null;
      });
      // The agent may send pings; we don't need to act on them.
      return new Response(null, { status: 101, webSocket: client });
    }

    // Worker → DO: is the agent currently linked?
    if (url.pathname === "/connected") {
      return Response.json({ connected: !!this.socket, connectedAt: this.connectedAt });
    }

    // Worker → DO: push a command to the agent (e.g. run a speed test).
    if (url.pathname === "/push" && req.method === "POST") {
      if (!this.socket) return Response.json({ ok: false, reason: "agent_offline" }, { status: 503 });
      try {
        this.socket.send(await req.text());
        return Response.json({ ok: true });
      } catch {
        this.socket = null;
        return Response.json({ ok: false, reason: "send_failed" }, { status: 503 });
      }
    }

    return new Response("not found", { status: 404 });
  }
}
