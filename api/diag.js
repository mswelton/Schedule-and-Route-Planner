/**
 * GET /api/diag
 *
 * Self-test for the three external dependencies, runnable from a browser on the
 * deployment itself — no terminal, no local checkout. Answers the question the
 * itinerary error cannot: *which* environment and *which* key is this
 * deployment actually using, and what does Google say when called with it.
 *
 * Deliberately leaks nothing. The Maps key is reported only as a length and a
 * SHA-256 prefix, which is enough to tell whether two deployments are using the
 * same key without revealing any of it. No client data is returned — only
 * counts and whether the home base was found.
 */

import { createHash } from 'node:crypto';
import { serverSupabase, scopeToUser, formatAddress } from '../lib/supabase.js';
import { fetchLeg } from '../lib/google.js';

/** Identify a secret without disclosing it. */
function fingerprint(value) {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

async function checkSupabase() {
  const result = { configured: false, ok: false };
  result.configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!result.configured) {
    result.error = 'SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set in this environment.';
    return { result, locations: [] };
  }

  try {
    const supabase = serverSupabase();
    const { data, error } = await scopeToUser(
      supabase
        .from('service_locations')
        .select(
          'id, location_name, address_line1, address_line2, town_city, county, postcode, latitude, longitude, is_home, clients!service_locations_client_id_fkey ( first_name, last_name )'
        )
        .eq('is_archived', false)
        .order('is_home', { ascending: false })
    );
    if (error) throw new Error(error.message);

    const rows = data || [];
    result.ok = true;
    result.activeLocations = rows.length;
    result.withCoordinates = rows.filter(
      (r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude)
    ).length;
    result.homeBaseFound = rows.some((r) => r.is_home === true);
    // Proves the two-FK client embed resolves; the names themselves stay out.
    result.clientNameJoinOk = rows.some((r) => r.clients);
    return { result, locations: rows };
  } catch (err) {
    result.error = err.message;
    return { result, locations: [] };
  }
}

async function checkRoutesApi(locations) {
  const result = { configured: Boolean(process.env.GOOGLE_MAPS_API_KEY), ok: false };
  if (!result.configured) {
    result.error = 'GOOGLE_MAPS_API_KEY is not set in this environment.';
    return result;
  }

  const usable = locations.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));

  const toPlace = (row) => ({
    label: row.location_name,
    lat: row.latitude,
    lng: row.longitude,
    address: formatAddress(row),
  });

  // The point of this check is the Maps key, so it must not be blocked by an
  // unrelated Supabase failure — fall back to two fixed Gippsland points.
  let from;
  let to;
  if (usable.length >= 2) {
    from = toPlace(usable[0]);
    to = toPlace(usable[1]);
    result.usedRealLocations = true;
  } else {
    from = { label: 'Bass VIC', lat: -38.4876134, lng: 145.4905527 };
    to = { label: 'Wonthaggi VIC', lat: -38.6076, lng: 145.5917 };
    result.usedRealLocations = false;
    result.note = 'Supabase locations unavailable — tested with fixed coordinates instead.';
  }

  try {
    // Depart in an hour so this exercises the traffic-aware path the planner
    // normally uses, rather than a different code path.
    const leg = await fetchLeg(from, to, Date.now() + 3600_000);
    result.ok = true;
    result.trafficAware = leg.trafficAware;
    result.testLegMinutes = Math.round(leg.seconds / 60);
    result.testLegKm = Math.round(leg.meters / 100) / 10;
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

async function checkStaticMaps() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const result = { configured: Boolean(apiKey), ok: false };
  if (!apiKey) return result;

  try {
    const params = new URLSearchParams({
      size: '100x100',
      center: '-38.4876,145.4906',
      zoom: '8',
      key: apiKey,
    });
    const res = await fetch(`https://maps.googleapis.com/maps/api/staticmap?${params}`);
    if (res.ok) {
      result.ok = true;
    } else {
      // Static Maps reports key problems as plain text, not JSON.
      result.error = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`.trim();
    }
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
  const { result: supabase, locations } = await checkSupabase();
  const [routesApi, staticMaps] = await Promise.all([
    checkRoutesApi(locations),
    checkStaticMaps(),
  ]);

  const checks = { supabase, routesApi, staticMaps };
  const allOk = Object.values(checks).every((c) => c.ok);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: allOk,
    // Which deployment is answering. A key set for Production does not apply to
    // a Preview deployment, and vice versa — this is usually the missing piece.
    environment: {
      vercelEnv: process.env.VERCEL_ENV || 'not on Vercel (local dev)',
      region: process.env.VERCEL_REGION || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    },
    // Identifies the key without revealing it: same fingerprint means same key.
    googleMapsKey: {
      set: Boolean(mapsKey),
      length: mapsKey.length || 0,
      sha256Prefix: fingerprint(mapsKey),
    },
    checks,
    hint: allOk
      ? 'All three dependencies are working in this environment.'
      : 'See checks[].error. If routesApi reports a referrer restriction, the key with this sha256Prefix is not the one you edited — compare it against the other Vercel environments.',
  });
}
