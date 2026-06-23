// Google sign-in + owner session, built on @aswincloud/auth.
//
// This file is now a thin adapter: the package owns the crypto (session
// signing, CSRF state, the OAuth code exchange + userinfo), and we keep the
// status-specific routing and UX — chiefly "never dead-end on an error, bounce
// home with ?auth=<code> for a dismissible banner".
//
// Flow (wired in index.ts):
//   /api/auth/login    → 302 to Google's consent screen (state cookie set)
//   /api/auth/callback → exchange + owner check → set `sess` cookie, redirect home
//   /api/auth/logout   → clear the cookie
//
// Owner-only: a verified Google email must be in OWNER_EMAIL to get a session.
// No users table — the session is a self-contained signed cookie.

import {
  createSessionCookie,
  clearSessionCookie,
  readSession,
  isOwner,
  startOAuth,
  handleOAuthCallback,
  clearStateCookie,
  type SessionConfig,
  type OAuthConfig,
} from "@aswincloud/auth";
import type { Env } from "./db";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const COOKIE = "sess";
const STATE_COOKIE = "oauth_state";

// Session cookie config. `sess` keeps the previous cookie name; the signed
// payload format differs from the old hand-rolled one, so anyone currently
// logged in re-authenticates once after this ships.
function sessionConfig(env: Env): SessionConfig {
  return { secret: env.SESSION_SECRET ?? "", cookieName: COOKIE, ttlSeconds: SESSION_TTL_SECONDS };
}

// OAuth config: Google only, status's callback path, matching state cookie name.
function oauthConfig(req: Request, env: Env): OAuthConfig {
  const origin = new URL(req.url).origin;
  return {
    clients: {
      google: { clientId: env.GOOGLE_CLIENT_ID ?? "", clientSecret: env.GOOGLE_CLIENT_SECRET ?? "" },
    },
    stateSecret: env.SESSION_SECRET ?? "",
    redirectUri: () => `${origin}/api/auth/callback`,
    stateCookieName: STATE_COOKIE,
  };
}

/**
 * Returns the signed-in OWNER email, or null. Composes the package's
 * readSession (cookie → subject) with the owner allowlist, so a validly signed
 * cookie for a non-owner email is still rejected.
 */
export async function getSession(req: Request, env: Env): Promise<string | null> {
  if (!env.SESSION_SECRET || !env.OWNER_EMAIL) return null;
  const email = await readSession(sessionConfig(env), req);
  if (!email) return null;
  return isOwner(env.OWNER_EMAIL, email) ? email : null;
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) {
    return new Response("SSO not configured", { status: 503 });
  }
  return startOAuth(oauthConfig(req, env), "google");
}

export async function handleCallback(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  const cfg = oauthConfig(req, env);

  // Bounce home with ?auth=<code> so the page can show a dismissible banner.
  // Always clear the one-shot state cookie; optionally clear the session cookie
  // too (wrong-account case). Mirrors the previous UX exactly.
  const backHome = (code: string, clearSess = false) => {
    const headers = new Headers({ Location: `${origin}/?auth=${code}` });
    headers.append("Set-Cookie", clearStateCookie(cfg));
    if (clearSess) headers.append("Set-Cookie", clearSessionCookie(sessionConfig(env)));
    return new Response(null, { status: 302, headers });
  };

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OWNER_EMAIL || !env.SESSION_SECRET) {
    return backHome("config");
  }

  const result = await handleOAuthCallback(cfg, "google", req);
  if (!result.ok) {
    // Map the package's stable error codes onto the page's banner vocabulary.
    if (result.error === "bad_state" || result.error === "missing_code") return backHome("state");
    if (result.error === "email_not_verified") return backHome("unverified");
    return backHome("exchange"); // token_exchange_failed | userinfo_failed | provider_error:*
  }

  if (!isOwner(env.OWNER_EMAIL, result.user.email)) {
    // Wrong Google account — banner + retry, and clear any stale session cookie.
    return backHome("denied", true);
  }

  const headers = new Headers({ Location: origin + "/" });
  headers.append("Set-Cookie", await createSessionCookie(sessionConfig(env), result.user.email));
  headers.append("Set-Cookie", clearStateCookie(cfg)); // clear one-shot state
  return new Response(null, { status: 302, headers });
}

export function handleLogout(req: Request): Response {
  const origin = new URL(req.url).origin;
  // Clearing only needs the cookie name, not the secret.
  return new Response(null, {
    status: 302,
    headers: {
      Location: origin + "/",
      "Set-Cookie": clearSessionCookie({ secret: "", cookieName: COOKIE }),
    },
  });
}
