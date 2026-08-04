/**
 * POST /api/plan
 *
 * Body:
 *   {
 *     date:                 'YYYY-MM-DD',
 *     firstAppointmentTime: 'HH:MM',            // local wall clock
 *     base:                 { name, address, lat, lng },
 *     stops:                [{ locationId, onSiteMinutes }]   // in visit order
 *   }
 *
 * Stop coordinates are resolved server-side from `service_locations` rather
 * than trusted from the request, so the itinerary always reflects the stored
 * data. The Google key never leaves this function.
 */

import { serverSupabase, scopeToUser, formatAddress } from '../lib/supabase.js';
import { fetchLeg } from '../lib/google.js';
import { buildItinerary } from '../lib/schedule.js';
import { zonedToInstant, instantToClock, isNextDay, DEFAULT_TIMEZONE } from '../lib/time.js';

const MAX_STOPS = 25;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { date, firstAppointmentTime, base, stops } = body;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return badRequest(res, 'A run date (YYYY-MM-DD) is required.');
  }
  if (!/^\d{2}:\d{2}$/.test(firstAppointmentTime || '')) {
    return badRequest(res, 'A first appointment time (HH:MM) is required.');
  }
  if (!base || (!base.address && !(Number.isFinite(base.lat) && Number.isFinite(base.lng)))) {
    return badRequest(res, 'A base address is required.');
  }
  if (!Array.isArray(stops) || stops.length === 0) {
    return badRequest(res, 'Add at least one stop to the day.');
  }
  if (stops.length > MAX_STOPS) {
    return badRequest(res, `A run is limited to ${MAX_STOPS} stops.`);
  }

  try {
    const supabase = serverSupabase();
    const ids = stops.map((s) => s.locationId);
    const { data, error } = await scopeToUser(
      supabase
        .from('service_locations')
        .select(
          'id, location_name, address_line1, address_line2, town_city, county, postcode, latitude, longitude, access_notes'
        )
        .in('id', ids)
    );
    if (error) throw new Error(error.message);

    const byId = new Map((data || []).map((row) => [row.id, row]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      return badRequest(res, `Unknown service location(s): ${missing.join(', ')}`);
    }

    // Preserve the order the client sent — that is the visit order.
    const orderedStops = stops.map((stop) => {
      const row = byId.get(stop.locationId);
      return {
        id: row.id,
        label: row.location_name,
        address: formatAddress(row),
        lat: row.latitude,
        lng: row.longitude,
        accessNotes: row.access_notes || null,
        onSiteMinutes: Math.max(0, Number(stop.onSiteMinutes) || 0),
      };
    });

    const baseLocation = {
      id: 'base',
      label: base.name || 'Base',
      address: base.address || '',
      lat: Number.isFinite(base.lat) ? base.lat : null,
      lng: Number.isFinite(base.lng) ? base.lng : null,
    };

    const firstAppointment = zonedToInstant(date, firstAppointmentTime, DEFAULT_TIMEZONE);

    const itinerary = await buildItinerary({
      base: baseLocation,
      stops: orderedStops,
      firstAppointment,
      getLeg: (origin, destination, departureMs) => fetchLeg(origin, destination, departureMs),
    });

    // Attach display-ready wall-clock strings so the browser never has to
    // reason about Melbourne's UTC offset itself.
    const clock = (ms) => instantToClock(ms, DEFAULT_TIMEZONE);
    const response = {
      date,
      timezone: DEFAULT_TIMEZONE,
      base: itinerary.base,
      leaveBase: { instant: itinerary.leaveBase, clock: clock(itinerary.leaveBase) },
      legToFirstStop: itinerary.legToFirstStop,
      stops: itinerary.stops.map((stop, i) => ({
        ...stop,
        accessNotes: orderedStops[i].accessNotes,
        lat: orderedStops[i].lat,
        lng: orderedStops[i].lng,
        arrivalClock: clock(stop.arrival),
        departureClock: clock(stop.departure),
      })),
      returnToBase: {
        instant: itinerary.returnToBase,
        clock: clock(itinerary.returnToBase),
        nextDay: isNextDay(itinerary.returnToBase, itinerary.leaveBase, DEFAULT_TIMEZONE),
      },
      totals: itinerary.totals,
      warnings: itinerary.warnings,
      geocodedFallbacks: orderedStops
        .filter((s) => !(Number.isFinite(s.lat) && Number.isFinite(s.lng)))
        .map((s) => s.label),
    };

    return res.status(200).json(response);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
