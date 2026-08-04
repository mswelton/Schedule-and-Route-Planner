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

/** Optional single-operator scoping: set THC_USER_ID to filter rows by owner. */
export function scopeToUser(query) {
  const userId = process.env.THC_USER_ID;
  return userId ? query.eq('user_id', userId) : query;
}

/** Compose the address columns into one geocodable string. */
export function formatAddress(row) {
  return [row.address_line1, row.address_line2, row.town_city, row.county, row.postcode]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(', ');
}
