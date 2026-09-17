/**
 * /api/fuel-log
 *
 * GET             — the litres/100 km and $/litre from the last run logged.
 * GET ?history=1  — every logged run, newest first, for the History screen.
 * POST            — record this run in `fuel_cost_calculations`.
 * PUT ?id=        — correct a logged run.
 * DELETE ?id=     — remove one.
 *
 * This is the one place the planner *writes* to a table it does not own.
 * The table already existed and was being filled in by hand; the distance
 * being typed in is the number this app computes as a side effect of working
 * out the day, so the typing is the part worth removing.
 *
 * **`fuel_cost_calculations` has no `user_id` column, so none of this can be
 * scoped to one operator.** The history is the practice's, and an edit or a
 * delete here changes rows the main hoof-tracker app also writes. That is a
 * deliberate, discussed choice — it is one operator and one vehicle, and 15 of
 * the rows were hand-entered before this app existed — but it is why the
 * client confirms a delete by naming the row rather than just asking.
 *
 * Body (POST):
 *   {
 *     date:             'YYYY-MM-DD',
 *     distanceKm:       number,     // from the plan's totals
 *     fuelConsumption:  number,     // litres per 100 km
 *     fuelPrice:        number,     // dollars per litre
 *     locationIds:      string[],   // the run's stops, in visit order
 *     routePlanId:      string?     // the saved run this belongs to, if any
 *   }
 *
 * `routePlanId` ties this entry to a specific saved run (`route_plans.id`) for
 * the Job Costing & Gross Profit module's vehicle/fuel cost split - optional
 * because a run can be logged without ever being saved. Not checked against
 * `scopeToUser` before use: a bogus or someone-else's id simply fails the
 * foreign key constraint on insert (a normal error, not a 403) - acceptable
 * because this is an optional cross-reference the client itself derived from
 * its own saved-run state, not a value a caller could use to probe for ids.
 *
 * When the client sends no `routePlanId` (App.jsx only has one to send after
 * an explicit Save or after reopening a saved run from History - re-planning
 * an already-saved date from scratch, the natural way to catch up on a missed
 * day, leaves it null even though a saved run for that date already exists),
 * this falls back to looking up a `route_plans` row for the same `date` and
 * links to that instead of leaving the entry permanently unlinked. Best
 * effort: a lookup failure never blocks the fuel log itself from saving.
 *
 * Body (PUT): the same three figures plus `date` and `description`, all of
 * which a human may have corrected. The derived columns are recomputed from
 * them rather than accepted.
 *
 * On POST the description and appointment ids are rebuilt server-side from the
 * location ids, so a logged run always describes rows that exist. The distance
 * is the exception: it is echoed back from a plan this server produced moments
 * earlier, and recomputing it would mean paying for the whole run of Routes API
 * calls again. It is range-checked instead.
 */

import { serverSupabase, scopeToUser } from '../lib/supabase.js';
import { authenticate } from '../lib/auth.js';
import { validateFuelInputs, computeFuelFigures } from '../lib/fuel.js';

const HISTORY_LIMIT = 200;

const ROW_COLUMNS =
  'id, trim_run_date, description, distance_traveled, fuel_consumption, fuel_cost, ' +
  'litres_consumption, trip_cost, cost_per_km, appointment_ids, route_plan_id, created_at';

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/**
 * Resolves the route_plan_id to link this fuel entry to. Trusts a client-
 * supplied id as-is (the normal path - see the file header for why it isn't
 * scopeToUser-checked here). Only when the client sent none does this fall
 * back to the most recently created `route_plans` row for the same date, so
 * re-planning an already-saved day (rather than reopening it from History)
 * still links for job costing instead of leaving the entry stranded.
 */
export async function resolveRoutePlanId(supabase, userId, date, routePlanId) {
  if (typeof routePlanId === 'string' && routePlanId) return routePlanId;

  const { data, error } = await scopeToUser(
    supabase
      .from('route_plans')
      .select('id')
      .eq('run_date', date)
      .order('created_at', { ascending: false })
      .limit(1),
    userId
  );
  if (error) return null; // best effort - never block the fuel log over this
  return data?.[0]?.id ?? null;
}

async function handleGet(req, res, supabase) {
  if (req.query?.history) {
    const { data, error } = await supabase
      .from('fuel_cost_calculations')
      .select(ROW_COLUMNS)
      .order('trim_run_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw new Error(error.message);
    return res.status(200).json({ entries: data || [] });
  }

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
  const { date, locationIds, routePlanId } = body;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return badRequest(res, 'A run date (YYYY-MM-DD) is required.');
  }
  const figures = validateFuelInputs(body);
  if (figures.error) return badRequest(res, figures.error);

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
      .select('id, service_location_id, scheduled_time, horses!appointments_horse_id_fkey ( name )')
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

  const resolvedRoutePlanId = await resolveRoutePlanId(supabase, userId, date, routePlanId);

  const { data: inserted, error: insertError } = await supabase
    .from('fuel_cost_calculations')
    .insert({
      trim_run_date: date,
      description,
      ...computeFuelFigures(figures),
      appointment_ids: appointmentIds.length ? appointmentIds : null,
      route_plan_id: resolvedRoutePlanId,
    })
    .select(ROW_COLUMNS)
    .single();
  if (insertError) throw new Error(insertError.message);

  return res.status(201).json(inserted);
}

async function handlePut(req, res, supabase) {
  const id = (req.query?.id || '').toString();
  if (!id) return badRequest(res, 'Which logged run should be updated?');

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) {
    return badRequest(res, 'A run date (YYYY-MM-DD) is required.');
  }
  const figures = validateFuelInputs(body);
  if (figures.error) return badRequest(res, figures.error);

  // The description is the operator's own words on an edit, unlike the insert
  // path where it is composed from the run. `appointment_ids` is left alone —
  // which appointments a run covered is not something an edit should rewrite.
  const description = typeof body.description === 'string' ? body.description.trim() : null;

  const { data, error } = await supabase
    .from('fuel_cost_calculations')
    .update({
      trim_run_date: body.date,
      description: description || null,
      ...computeFuelFigures(figures),
    })
    .eq('id', id)
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return res.status(404).json({ error: 'That logged run no longer exists.' });

  return res.status(200).json(data);
}

async function handleDelete(req, res, supabase) {
  const id = (req.query?.id || '').toString();
  if (!id) return badRequest(res, 'Which logged run should be deleted?');

  const { data, error } = await supabase
    .from('fuel_cost_calculations')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return res.status(404).json({ error: 'That logged run no longer exists.' });

  return res.status(200).json({ id: data.id });
}

export default async function handler(req, res) {
  const allowed = ['GET', 'POST', 'PUT', 'DELETE'];
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await authenticate(req, res);
  if (!user) return undefined;

  try {
    const supabase = serverSupabase();
    if (req.method === 'GET') return await handleGet(req, res, supabase);
    if (req.method === 'POST') return await handlePost(req, res, supabase, user.id);
    if (req.method === 'PUT') return await handlePut(req, res, supabase);
    return await handleDelete(req, res, supabase);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
