// Google OIDC sign-in + a signed session cookie. No dependencies — uses WebCrypto.
//
// Flow:
//   /api/auth/login    → 302 to Google's consent screen (state cookie set)
//   /api/auth/callback → exchange code, verify id_token email == OWNER_EMAIL,
//                        set an HMAC-signed `sess` cookie, redirect home
//   /api/auth/logout   → clear the cookie
//
// The session cookie is `<base64url(payload)>.<base64url(hmac)>`; we verify the
// HMAC with SESSION_SECRET (constant-time) and check expiry on each request.

import type { Env } from "./db";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE = "sess";
const STATE_COOKIE = "oauth_state";

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const b64urlStr = (s: string) => b64url(enc.encode(s));
const fromB64url = (s: string) =>
  atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSession(env: Env, email: string): Promise<string> {
  const payload = b64urlStr(JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS }));
  const key = await hmacKey(env.SESSION_SECRET!);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return `${payload}.${sig}`;
}

// Returns the signed-in owner email, or null. Verifies HMAC + expiry + owner match.
export async function getSession(req: Request, env: Env): Promise<string | null> {
  if (!env.SESSION_SECRET || !env.OWNER_EMAIL) return null;
  const cookie = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)sess=([^;]+)/)?.[1];
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const key = await hmacKey(env.SESSION_SECRET);
  const expected = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(fromB64url(payload)) as { email: string; exp: number };
    if (data.exp < Date.now()) return null;
    if (data.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return null;
    return data.email;
  } catch {
    return null;
  }
}

const secureCookie = (name: string, value: string, maxAgeSec: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;

export function handleLogin(req: Request, env: Env): Response {
  if (!env.GOOGLE_CLIENT_ID) return new Response("SSO not configured", { status: 503 });
  const origin = new URL(req.url).origin;
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      // Short-lived state cookie to defend the callback against CSRF.
      "Set-Cookie": secureCookie(STATE_COOKIE, state, 600),
    },
  });
}

export async function handleCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];

  // Never strand the user on a dead-end error page: bounce back to the status
  // page with an ?auth=<code> flag the front-end turns into a dismissible banner
  // (with a "Try another account" action). Always clear the one-shot state cookie;
  // optionally clear any session cookie too (wrong-account case).
  const backHome = (code: string, clearSess = false) => {
    const headers = new Headers({ Location: `${origin}/?auth=${code}` });
    headers.append("Set-Cookie", secureCookie(STATE_COOKIE, "", 0));
    if (clearSess) headers.append("Set-Cookie", secureCookie(COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  };

  if (!code || !state || !stateCookie || !timingSafeEqual(state, stateCookie)) {
    return backHome("state");
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OWNER_EMAIL || !env.SESSION_SECRET) {
    return backHome("config");
  }

  // Exchange the code for tokens.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/api/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return backHome("exchange");
  const tok = (await tokenRes.json()) as { id_token?: string };
  if (!tok.id_token) return backHome("exchange");

  // The id_token is a JWT; the email/verified claims sit in the payload. Google
  // just minted it over TLS in direct response to our authenticated exchange, so
  // decoding the payload is sufficient here (no need to re-verify the signature).
  let claims: { email?: string; email_verified?: boolean | string };
  try {
    claims = JSON.parse(fromB64url(tok.id_token.split(".")[1]));
  } catch {
    return backHome("exchange");
  }
  const email = (claims.email ?? "").toLowerCase();
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!email || !verified) return backHome("unverified");
  if (email !== env.OWNER_EMAIL.toLowerCase()) {
    // Wrong Google account — send them home with a banner + a way to retry,
    // and clear any stale session cookie so they're not silently half-logged-in.
    return backHome("denied", true);
  }

  const session = await makeSession(env, email);
  const headers = new Headers({ Location: origin + "/" });
  headers.append("Set-Cookie", secureCookie(COOKIE, session, Math.floor(SESSION_TTL_MS / 1000)));
  headers.append("Set-Cookie", secureCookie(STATE_COOKIE, "", 0)); // clear state
  return new Response(null, { status: 302, headers });
}

export function handleLogout(req: Request): Response {
  const origin = new URL(req.url).origin;
  return new Response(null, {
    status: 302,
    headers: { Location: origin + "/", "Set-Cookie": secureCookie(COOKIE, "", 0) },
  });
}
