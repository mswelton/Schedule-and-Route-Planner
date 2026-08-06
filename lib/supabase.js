/**
 * Server-side Supabase access (never import this from src/).
 *
 * We query `service_locations` directly with the service-role key from inside
 * the Vercel function rather than going through the deployed `db-proxy` edge
 * function. Both were on the table; direct is simpler to wire up correctly —
 * a real query builder instead of hand-assembled PostgREST query strings, one
 * fewer network hop, and no dependency on a shared endpoint whose contract
 * this app does not own.
 */

import { createClient } from '@supabase/supabase-js';

let cached = null;

export function serverSupabase() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as server environment variables.'
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Scope a query to the rows owned by the signed-in operator.
 *
 * The id comes from the verified access token (see `lib/auth.js`), never from
 * the request body and no longer from a `THC_USER_ID` environment variable —
 * scoping is something the server enforces, not something a deployment
 * configures. Callers must pass a verified id; there is no unscoped path.
 */
export function scopeToUser(query, userId) {
  if (!userId) throw new Error('scopeToUser requires a verified user id.');
  return query.eq('user_id', userId);
}

/** Compose the address columns into one geocodable string. */
export function formatAddress(row) {
  return [row.address_line1, row.address_line2, row.town_city, row.county, row.postcode]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(', ');
}
