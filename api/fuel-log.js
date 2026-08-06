/**
 * /api/fuel-log
 *
 * GET  — the litres/100 km and $/litre from the last run logged, as defaults.
 * POST — record this run in `fuel_cost_calculations`.
 *
 * This is the one place the planner *writes* to the practice database.
 * Everything else here is read-only. The table already existed and was being
 * filled in by hand; the distance being typed in is the number this app
 * computes as a side effect of working out the day, so the typing is the part
 * worth removing.
 *
 * Body (POST):
 *   {
 *     date:             'YYYY-MM-DD',
 *     distanceKm:       number,     // from the plan's totals
 *     fuelConsumption:  number,     // litres per 100 km
 *     fuelPrice:        number,     // dollars per litre
 *     locationIds:      string[]    // the run's stops, in visit order
 *   }
 *
 * The description and the appointment ids are rebuilt server-side from those
 * location ids rather than taken from the request, so a logged run always
 * describes rows that actually exist. The distance is the exception: it is
 * echoed back from a plan this server produced moments earlier, and
 * recomputing it would mean paying for the whole run of Routes API calls
 * again. It is range-checked instead.
 */

import { serverSupabase, scopeToUser } from '../lib/supabase.js';
import { authenticate } from '../lib/auth.js';

// Sanity bounds, not business rules — they exist to keep a typo out of the
// practice database, not to tell Mark what a plausible day looks like.
const MAX_DISTANCE_KM = 2000;
const MAX_CONSUMPTION = 100;
const MAX_PRICE = 20;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function positiveNumber(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

const round = (n, places) => Number(n.toFixed(places));

async function handleGet(res, supabase) {
  // The table carries no user_id, so this is the practice's last run rather
  // than this operator's — which matches how the rows are written today.
  const { data, error } = await supabase
    .from('fuel_cost_calculations')
    .select('fuel_consumption, fuel_cost, trim_run_date')
    .order('trim_run_date', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);

  const last = data?.[0] || null;
  return res.status(200).json({
    fuelConsumption: last ? Number(last.fuel_consumption) : null,
    fuelPrice: last ? Number(last.fuel_cost) : null,
    fromRunDate: last?.trim_run_date || null,
  });
}

async function handlePost(req, res, supabase, userId) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { date, locationIds } = body;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return badRequest(res, 'A run date (YYYY-MM-DD) is required.');
  }
  const distanceKm = positiveNumber(body.distanceKm, MAX_DISTANCE_KM);
  if (distanceKm === null) {
    return badRequest(res, `Distance must be between 0 and ${MAX_DISTANCE_KM} km.`);
  }
  const fuelConsumption = positiveNumber(body.fuelConsumption, MAX_CONSUMPTION);
  if (fuelConsumption === null) {
    return badRequest(res, 'Fuel use must be a positive figure in litres per 100 km.');
  }
  const fuelPrice = positiveNumber(body.fuelPrice, MAX_PRICE);
  if (fuelPrice === null) {
    return badRequest(res, 'Fuel price must be a positive figure in dollars per litre.');
  }
  if (!Array.isArray(locationIds) || locationIds.length === 0) {
    return badRequest(res, 'A run needs at least one stop to log.');
  }

  const { data: locations, error: locError } = await scopeToUser(
    supabase.from('service_locations').select('id, location_name').in('id', locationIds),
    userId
  );
  if (locError) throw new Error(locError.message);

  const nameById = new Map((locations || []).map((row) => [row.id, row.location_name]));
  const missing = locationIds.filter((id) => !nameById.has(id));
  if (missing.length) {
    return badRequest(res, `Unknown service location(s): ${missing.join(', ')}`);
  }

  // The horses seen at each stop, so the description reads like the ones Mark
  // has been writing by hand: "Eichhorn - Wonga (Lyric, Charlie); …".
  //
  // The embed names its constraint because appointments.horse_id is a *text*
  // column pointing at horses.horse_id, not at the bigint horses.id — an
  // unqualified embed picks the wrong side of that.
  const { data: appointments, error: apptError } = await scopeToUser(
    supabase
      .from('appointments')
      .select(
        'id, service_location_id, scheduled_time, horses!appointments_horse_id_fkey ( name )'
      )
      .eq('scheduled_date', date)
      .in('service_location_id', locationIds)
      .order('scheduled_time', { ascending: true, nullsFirst: false }),
    userId
  );
  if (apptError) throw new Error(apptError.message);

  const horsesByLocation = new Map();
  const appointmentIds = [];
  for (const appt of appointments || []) {
    appointmentIds.push(appt.id);
    const name = appt.horses?.name;
    if (!name) continue;
    const list = horsesByLocation.get(appt.service_location_id) || [];
    list.push(name);
    horsesByLocation.set(appt.service_location_id, list);
  }

  // Visit order, not query order — the description should read like the run.
  const description = locationIds
    .map((id) => {
      const horses = horsesByLocation.get(id) || [];
      return horses.length ? `${nameById.get(id)} (${horses.join(', ')})` : nameById.get(id);
    })
    .join('; ');

  const litres = (distanceKm * fuelConsumption) / 100;
  const tripCost = litres * fuelPrice;

  const row = {
    trim_run_date: date,
    description,
    distance_traveled: round(distanceKm, 1),
    fuel_consumption: fuelConsumption,
    fuel_cost: fuelPrice,
    litres_consumption: round(litres, 2),
    trip_cost: round(tripCost, 2),
    cost_per_km: round(tripCost / distanceKm, 4),
    appointment_ids: appointmentIds.length ? appointmentIds : null,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('fuel_cost_calculations')
    .insert(row)
    .select('id, trip_cost, litres_consumption, cost_per_km, description, appointment_ids')
    .single();
  if (insertError) throw new Error(insertError.message);

  return res.status(201).json(inserted);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await authenticate(req, res);
  if (!user) return undefined;

  try {
    const supabase = serverSupabase();
    return req.method === 'GET'
      ? await handleGet(res, supabase)
      : await handlePost(req, res, supabase, user.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
