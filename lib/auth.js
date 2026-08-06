/**
 * Bearer-token authentication for the api/* handlers (server-side only —
 * never import this from src/).
 *
 * Every endpoint in this app reads practice data or spends the Maps key, so
 * every endpoint is behind this. The browser signs in with Supabase Auth and
 * sends the resulting access token; we verify it here and hand back the user,
 * whose id then scopes every query.
 *
 * Verification goes through Supabase rather than decoding the JWT locally.
 * That costs one round trip per request, but it keeps working across a JWT
 * secret rotation and needs no secret of its own beyond the anon key — which
 * is publishable by design.
 */

import { createClient } from '@supabase/supabase-js';

/** Caller is not signed in, or the token no longer verifies. */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

/** The server is missing the configuration needed to verify anything. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.status = 500;
  }
}

/**
 * Pull the token out of an `Authorization: Bearer <token>` header.
 *
 * Kept pure and exported so the parsing is unit-tested without a live token.
 * Node lower-cases incoming header names, but the dev-server shim and tests
 * can hand us either spelling.
 */
export function bearerToken(req) {
  const headers = req?.headers || {};
  const raw = headers.authorization ?? headers.Authorization ?? '';
  const match = /^Bearer[ \t]+(\S.*)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : null;
}

let cached = null;

function authClient() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new ConfigError(
      'SUPABASE_URL and SUPABASE_ANON_KEY must be set as server environment variables.'
    );
  }

  cached = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Verify the request's bearer token.
 *
 * @returns {Promise<{ id: string, email: string|null }>} the signed-in user
 * @throws {AuthError}   no token, or a token that does not verify
 * @throws {ConfigError} the server cannot verify tokens at all
 */
export async function requireUser(req) {
  const token = bearerToken(req);
  if (!token) throw new AuthError('Sign in to use the planner.');

  const { data, error } = await authClient().auth.getUser(token);
  if (error || !data?.user) {
    throw new AuthError('That session is no longer valid — sign in again.');
  }

  return { id: data.user.id, email: data.user.email || null };
}

/**
 * Standard handler preamble. Returns the user, or null once it has already
 * sent the error response — so callers `if (!user) return;` and move on.
 */
export async function authenticate(req, res) {
  try {
    return await requireUser(req);
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
    return null;
  }
}
