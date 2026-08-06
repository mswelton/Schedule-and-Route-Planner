/**
 * POST /api/optimise
 *
 * Body: { base: { name, address, lat, lng }, stops: [{ locationId }] }
 *
 * Compares the order the stops are in against the best order Google can find,
 * and reports both. It does **not** reorder anything — it hands back a
 * suggested order for the client to offer, because which properties get
 * visited in which order is Mark's call and sometimes has reasons that are not
 * in the map.
 *
 * Two Routes calls: the current order and the optimised one. Both are
 * traffic-unaware, so the comparison is like for like rather than a snapshot
 * of this minute's traffic. Neither is used to build the itinerary — that is
 * `api/plan.js`, which re-prices every leg at the time it is actually driven.
 */

import { serverSupabase, scopeToUser, formatAddress } from '../lib/supabase.js';
import { authenticate } from '../lib/auth.js';
import { fetchRunOverview } from '../lib/google.js';

// Google's own limit on intermediates for an optimised route is well above
// anything a day of trimming looks like; this matches api/plan.js.
const MAX_STOPS = 25;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await authenticate(req, res);
  if (!user) return undefined;

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { base, stops } = body;

  if (!base || (!base.address && !(Number.isFinite(base.lat) && Number.isFinite(base.lng)))) {
    return res.status(400).json({ error: 'A base address is required.' });
  }
  if (!Array.isArray(stops) || stops.length < 3) {
    // Two stops have only one sensible order once the run starts and finishes
    // at base, so there is nothing to compare.
    return res.status(400).json({ error: 'Reordering needs at least three stops.' });
  }
  if (stops.length > MAX_STOPS) {
    return res.status(400).json({ error: `A run is limited to ${MAX_STOPS} stops.` });
  }

  try {
    const supabase = serverSupabase();
    const ids = stops.map((s) => s.locationId);
    const { data, error } = await scopeToUser(
      supabase
        .from('service_locations')
        .select('id, location_name, address_line1, address_line2, town_city, county, postcode, latitude, longitude')
        .in('id', ids),
      user.id
    );
    if (error) throw new Error(error.message);

    const byId = new Map((data || []).map((row) => [row.id, row]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      return res.status(400).json({ error: `Unknown service location(s): ${missing.join(', ')}` });
    }

    const ordered = ids.map((id) => {
      const row = byId.get(id);
      return {
        id: row.id,
        label: row.location_name,
        address: formatAddress(row),
        lat: row.latitude,
        lng: row.longitude,
      };
    });

    const baseLocation = {
      id: 'base',
      label: base.name || 'Base',
      address: base.address || '',
      lat: Number.isFinite(base.lat) ? base.lat : null,
      lng: Number.isFinite(base.lng) ? base.lng : null,
    };

    const [current, optimised] = await Promise.all([
      fetchRunOverview(baseLocation, ordered, { optimize: false }),
      fetchRunOverview(baseLocation, ordered, { optimize: true }),
    ]);

    const suggested = optimised.order.map((index) => ordered[index]);
    const unchanged = optimised.order.every((index, i) => index === i);

    return res.status(200).json({
      unchanged,
      current: { meters: current.meters, seconds: current.seconds },
      optimised: { meters: optimised.meters, seconds: optimised.seconds },
      saving: {
        meters: current.meters - optimised.meters,
        seconds: current.seconds - optimised.seconds,
      },
      order: suggested.map((stop) => ({ locationId: stop.id, label: stop.label })),
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
