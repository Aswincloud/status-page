// Sign-in + owner session, via the central OAuth broker (auth.aswincloud.com).
//
// This site no longer holds its own OAuth client. The broker authenticates the
// user with the provider and relays the verified email back, signed with this
// site's RELAY_SECRET. We then apply the access policy (ACCESS_MODE) and issue
// our own `sess` cookie.
//
//   /api/auth/login    → set a signed nonce cookie, 302 to the broker's start
//   /api/auth/callback → verify the relay token + nonce, apply access policy,
//                        set `sess`, redirect home (banner on failure)
//   /api/auth/logout   → clear the cookie
//
// The session cookie format is unchanged, so existing sessions stay valid.

import {
  createSessionCookie,
  clearSessionCookie,
  readSession,
  emailAllowed,
  parseAccessMode,
  signToken,
  verifyToken,
  verifyRelay,
  serializeCookie,
  readCookie,
  randomSecret,
  type SessionConfig,
} from "@aswincloud/auth";
import type { Env } from "./db";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const COOKIE = "sess";
const NONCE_COOKIE = "oauth_nonce";
const NONCE_PURPOSE = "broker_nonce";
const NONCE_TTL_SECONDS = 10 * 60;
const SITE_ID = "status"; // how this site is registered with the broker
const KNOWN_PROVIDERS = ["google", "github", "microsoft"] as const;
const DEFAULT_PROVIDER = "google";

function sessionConfig(env: Env): SessionConfig {
  return { secret: env.SESSION_SECRET ?? "", cookieName: COOKIE, ttlSeconds: SESSION_TTL_SECONDS };
}

/** The signed-in, allowed email or null. Composes readSession + the access policy. */
export async function getSession(req: Request, env: Env): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const email = await readSession(sessionConfig(env), req);
  if (!email) return null;
  return emailAllowed({
    mode: parseAccessMode(env.ACCESS_MODE),
    email,
    owners: env.OWNER_EMAIL,
    domains: env.ACCESS_DOMAINS,
  })
    ? email
    : null;
}

/** Is sign-in wired up (broker URL + relay secret + session secret present)? */
export function ssoConfigured(env: Env): boolean {
  return !!(env.AUTH_BROKER_URL && env.RELAY_SECRET && env.SESSION_SECRET);
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  if (!ssoConfigured(env)) return new Response("SSO not configured", { status: 503 });
  const url = new URL(req.url);
  const origin = url.origin;

  // Which IdP to use. Validated against the known set; anything else (or absent)
  // falls back to Google. The broker still enforces that the site is actually
  // registered for this provider, so an unsupported value just fails there.
  const reqProvider = url.searchParams.get("provider");
  const provider = (KNOWN_PROVIDERS as readonly string[]).includes(reqProvider ?? "")
    ? (reqProvider as string)
    : DEFAULT_PROVIDER;

  // A fresh nonce binds this login attempt to the relay we get back. We carry it
  // in a signed, short-lived cookie and also hand it to the broker as ?nonce.
  const nonce = randomSecret(16);
  const nonceTok = await signToken(env.SESSION_SECRET ?? "", nonce, NONCE_PURPOSE, NONCE_TTL_SECONDS);

  const ret = `${origin}/api/auth/callback`;
  const start = new URL(`${env.AUTH_BROKER_URL!.replace(/\/$/, "")}/api/oauth/${provider}/start`);
  start.searchParams.set("site", SITE_ID);
  start.searchParams.set("return", ret);
  start.searchParams.set("nonce", nonce);

  return new Response(null, {
    status: 302,
    headers: {
      Location: start.toString(),
      "Set-Cookie": serializeCookie(NONCE_COOKIE, nonceTok, { maxAgeSeconds: NONCE_TTL_SECONDS }),
    },
  });
}

// GET /api/auth/providers — which IdPs the sign-in UI should offer. We proxy the
// broker's own list (registered-for-this-site ∩ configured-on-the-broker) so a
// provider's button appears automatically once its app is added on the broker,
// with no change here. Falls back to Google on any broker hiccup so sign-in is
// never left button-less.
export async function handleProviders(req: Request, env: Env): Promise<Response> {
  const fallback = { providers: [{ id: DEFAULT_PROVIDER, name: "Google" }] };
  const headers = { "content-type": "application/json", "cache-control": "max-age=300" };
  if (!ssoConfigured(env)) return new Response(JSON.stringify({ providers: [] }), { headers });

  try {
    const base = env.AUTH_BROKER_URL!.replace(/\/$/, "");
    const r = await fetch(`${base}/api/oauth/providers?site=${SITE_ID}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return new Response(JSON.stringify(fallback), { headers });
    const body = (await r.json()) as { providers?: Array<{ id: string; name: string }> };
    const list = Array.isArray(body.providers) && body.providers.length ? body.providers : fallback.providers;
    return new Response(JSON.stringify({ providers: list }), { headers });
  } catch {
    return new Response(JSON.stringify(fallback), { headers });
  }
}

export async function handleCallback(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;

  const backHome = (code: string, clearSess = false) => {
    const headers = new Headers({ Location: `${origin}/?auth=${code}` });
    headers.append("Set-Cookie", serializeCookie(NONCE_COOKIE, "", { maxAgeSeconds: 0 })); // clear nonce
    if (clearSess) headers.append("Set-Cookie", clearSessionCookie(sessionConfig(env)));
    return new Response(null, { status: 302, headers });
  };

  if (!ssoConfigured(env)) return backHome("config");

  const url = new URL(req.url);
  const relayError = url.searchParams.get("relay_error");
  if (relayError) return backHome(relayError === "email_not_verified" ? "unverified" : "exchange");
  const relay = url.searchParams.get("relay");
  if (!relay) return backHome("state");

  // Verify the broker's relay token with our per-site secret, and that its nonce
  // matches the one we issued (replay/cross-login defense).
  const claims = await verifyRelay(env.RELAY_SECRET ?? "", relay);
  if (!claims) return backHome("state");
  const nonceTok = readCookie(req, NONCE_COOKIE);
  const expectedNonce = nonceTok ? await verifyToken(env.SESSION_SECRET ?? "", nonceTok, NONCE_PURPOSE) : null;
  if (!expectedNonce || expectedNonce !== claims.nonce) return backHome("state");

  // Access policy: owner-only by default for status.
  const allowed = emailAllowed({
    mode: parseAccessMode(env.ACCESS_MODE),
    email: claims.email,
    owners: env.OWNER_EMAIL,
    domains: env.ACCESS_DOMAINS,
  });
  if (!allowed) return backHome("denied", true);

  const headers = new Headers({ Location: origin + "/" });
  headers.append("Set-Cookie", await createSessionCookie(sessionConfig(env), claims.email));
  headers.append("Set-Cookie", serializeCookie(NONCE_COOKIE, "", { maxAgeSeconds: 0 })); // clear nonce
  return new Response(null, { status: 302, headers });
}

export function handleLogout(req: Request): Response {
  const origin = new URL(req.url).origin;
  return new Response(null, {
    status: 302,
    headers: {
      Location: origin + "/",
      "Set-Cookie": clearSessionCookie({ secret: "", cookieName: COOKIE }),
    },
  });
}
