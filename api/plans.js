/**
 * /api/plans
 *
 * GET            — the most recent saved runs, newest first (summaries only).
 * GET ?id=<uuid> — one saved run, with its full stored itinerary.
 * POST           — save the itinerary the browser is currently showing.
 * PUT ?id=<uuid> — replace a saved run with a freshly worked-out one.
 * DELETE ?id=    — remove a saved run.
 *
 * `PUT` exists so that reopening a run, adjusting it and re-planning updates
 * *that* row rather than adding a second one. Without it the table fills with
 * near-duplicates of the same day — which is not hypothetical: the fuel table
 * carries two identical rows for 2026-07-25, eight seconds apart.
 *
 * A planned run used to live until the tab closed. This keeps it, so a day can
 * be reopened later without recomputing — and without paying for — the Routes
 * API calls that produced it.
 *
 * `route_plans` (plus its child table `route_plan_stops`, one row per stop)
 * are the only tables this app owns. It deliberately does **not** write to
 * `appointments`: the planner suggests times, and changing bookings clients
 * have already been given stays a decision made in the main app.
 *
 * `route_plan_stops` exists for the Job Costing & Gross Profit module (a
 * different app against the same database) to apportion vehicle/fuel cost
 * per stop without unpacking `plan` JSONB - this app only ever writes it,
 * keyed off the same `plan.stops[]` already being saved. A `PUT` replaces a
 * run's stops wholesale (delete then re-insert) rather than diffing them,
 * mirroring how `PUT` replaces the parent row itself.
 *
 * The tables are created by docs/migrations/001_create_route_plans.sql and
 * 002_create_route_plan_stops.sql. Until those have been applied, these
 * endpoints say so rather than failing obscurely.
 */

import { serverSupabase, scopeToUser } from '../lib/supabase.js';
import { authenticate } from '../lib/auth.js';

const LIST_LIMIT = 25;

const SUMMARY_COLUMNS =
  'id, run_date, base_label, stop_count, total_distance_m, total_driving_seconds, ' +
  'total_on_site_minutes, day_length_seconds, leave_base_clock, return_to_base_clock, created_at';

/**
 * PostgREST surfaces Postgres' 42P01 ("relation does not exist") when a
 * migration has not been applied. Matches either owned table - "route_plan"
 * is a prefix of both `route_plans` and `route_plan_stops`. Exported so the
 * detection is tested — this is the difference between a useful message and
 * an opaque 500.
 */
export function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01') return true;
  return /relation .*route_plan.*does not exist/i.test(error.message || '');
}

/**
 * Merge the authoritative `route_plan_stops.appointment_ids` into a stored
 * plan's stops, by sequence.
 *
 * `plan` JSONB is a snapshot of what the browser was shown; `route_plan_stops`
 * is the row-per-stop projection the job-costing module reads. They are
 * written together, but only the table is guaranteed to carry the appointment
 * links: every run saved before appointment ids existed has no
 * `appointmentIds` key in its blob at all, while its stop rows are correct.
 *
 * That mattered because reopening a run rebuilds the editor from the blob, and
 * saving writes the stop rows back from it (`writeStopRows` deletes and
 * re-inserts). Reopening one of those older runs and re-saving therefore wiped
 * `appointment_ids` that were correct, silently taking the whole run out of
 * gross-profit reporting. Reading the table back here makes the blob's copy
 * advisory and the table's copy the truth, for every consumer of this endpoint.
 *
 * Merges positionally because `route_plan_stops.sequence` is assigned from the
 * same `plan.stops[]` index in `stopRows()`. A stop with no matching row keeps
 * whatever the blob had, rather than being blanked.
 */
export function withStoredAppointmentIds(plan, stopRows) {
  if (!plan || !Array.isArray(plan.stops)) return plan;
  if (!Array.isArray(stopRows) || stopRows.length === 0) return plan;

  const bySequence = new Map(stopRows.map((row) => [row.sequence, row]));

  return {
    ...plan,
    stops: plan.stops.map((stop, i) => {
      const row = bySequence.get(i);
      if (!row || !Array.isArray(row.appointment_ids)) return stop;
      return { ...stop, appointmentIds: row.appointment_ids };
    }),
  };
}

/**
 * How many appointments a plan's stops are linked to. Zero means the run is
 * invisible to job costing — no revenue of its own, and no share of the day's
 * vehicle or fuel cost — which is worth saying out loud at save time rather
 * than leaving to be noticed in a margin report weeks later.
 */
export function countLinkedAppointments(plan) {
  if (!plan || !Array.isArray(plan.stops)) return 0;
  return plan.stops.reduce(
    (total, stop) => total + (Array.isArray(stop.appointmentIds) ? stop.appointmentIds.length : 0),
    0
  );
}

function missingTableResponse(res) {
  return res.status(503).json({
    error:
      'Saved runs need the route_plans and route_plan_stops tables. Apply ' +
      'docs/migrations/001_create_route_plans.sql and 002_create_route_plan_stops.sql ' +
      'in the Supabase SQL editor, then try again.',
  });
}

const integer = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * The stored columns for an itinerary. The totals are echoed back from a plan
 * this server produced, the same trade api/fuel-log.js makes: recomputing
 * would mean paying for every Routes call again, and they are only ever read
 * back out to the same user.
 */
function planRow(plan) {
  return {
    run_date: plan.date,
    base_label: plan.base?.label || null,
    base_address: plan.base?.address || null,
    stop_count: plan.stops.length,
    total_distance_m: integer(plan.totals.distanceMeters),
    total_driving_seconds: integer(plan.totals.drivingSeconds),
    total_on_site_minutes: integer(plan.totals.onSiteMinutes),
    day_length_seconds: integer(plan.totals.dayLengthSeconds),
    leave_base_clock: plan.leaveBase?.clock || null,
    return_to_base_clock: plan.returnToBase?.clock || null,
    plan,
  };
}

/**
 * One `route_plan_stops` row per stop in the itinerary.
 *
 * `legToNext` is the drive *leaving* each stop (see lib/schedule.js), so the
 * very first leg - base to stop 0 - belongs to no stop's `legToNext`. It is
 * folded into sequence 0 here instead of dropped, which is what makes these
 * rows sum to `route_plans.total_distance_m` / `total_driving_seconds`
 * exactly, across every stop on the run.
 */
function stopRows(routePlanId, plan) {
  return plan.stops.map((stop, i) => {
    const leadingLeg = i === 0 ? plan.legToFirstStop : null;
    return {
      route_plan_id: routePlanId,
      sequence: i,
      service_location_id: stop.id,
      appointment_ids: Array.isArray(stop.appointmentIds) ? stop.appointmentIds : [],
      leg_distance_m: integer((leadingLeg?.meters || 0) + (stop.legToNext?.meters || 0)),
      leg_duration_s: integer((leadingLeg?.seconds || 0) + (stop.legToNext?.seconds || 0)),
      on_site_minutes: integer(stop.onSiteMinutes),
      arrival_at: new Date(stop.arrival).toISOString(),
      departure_at: new Date(stop.departure).toISOString(),
    };
  });
}

/**
 * Replace a run's stop rows wholesale. Used by both POST (first save) and PUT
 * (re-plan) — a PUT deletes what was there before re-inserting, since a
 * re-plan can add, remove or reorder stops, not just adjust one in place.
 */
async function writeStopRows(supabase, routePlanId, plan) {
  const { error: deleteError } = await supabase
    .from('route_plan_stops')
    .delete()
    .eq('route_plan_id', routePlanId);
  if (deleteError) throw new Error(deleteError.message);

  const { error: insertError } = await supabase
    .from('route_plan_stops')
    .insert(stopRows(routePlanId, plan));
  if (insertError) throw new Error(insertError.message);
}

/** Shared shape check for POST and PUT. Returns a message, or null if fine. */
function planProblem(plan) {
  if (!plan || typeof plan !== 'object') return 'A planned run is required.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date || '')) return 'That run has no valid date.';
  if (!Array.isArray(plan.stops) || plan.stops.length === 0) return 'That run has no stops.';
  if (!plan.totals || typeof plan.totals !== 'object') return 'That run has no totals.';
  return null;
}

async function handleGet(req, res, supabase, userId) {
  const id = (req.query?.id || '').toString();

  if (id) {
    const { data, error } = await scopeToUser(
      supabase.from('route_plans').select('id, run_date, plan, created_at').eq('id', id),
      userId
    ).maybeSingle();
    if (error) {
      if (isMissingTable(error)) return missingTableResponse(res);
      throw new Error(error.message);
    }
    if (!data) return res.status(404).json({ error: 'That saved run no longer exists.' });

    // The stop rows are the authoritative copy of the appointment links — see
    // withStoredAppointmentIds. Not scoped to the user, and does not need to
    // be: `route_plan_stops` has no `user_id` of its own, and the parent row
    // above was fetched through scopeToUser and 404s when it is not this
    // operator's, so `data.id` is already proven to be theirs. Same reasoning
    // writeStopRows relies on. A missing table is not fatal here: the run is
    // still worth showing, just with whatever the blob remembers.
    const { data: stopRows, error: stopsError } = await supabase
      .from('route_plan_stops')
      .select('sequence, appointment_ids')
      .eq('route_plan_id', data.id)
      .order('sequence', { ascending: true });
    if (stopsError && !isMissingTable(stopsError)) throw new Error(stopsError.message);

    return res.status(200).json({ ...data, plan: withStoredAppointmentIds(data.plan, stopRows) });
  }

  const { data, error } = await scopeToUser(
    supabase
      .from('route_plans')
      .select(SUMMARY_COLUMNS)
      .order('run_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT),
    userId
  );
  if (error) {
    if (isMissingTable(error)) return missingTableResponse(res);
    throw new Error(error.message);
  }

  return res.status(200).json({ plans: data || [] });
}

async function handlePost(req, res, supabase, userId) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const problem = planProblem(body.plan);
  if (problem) return res.status(400).json({ error: problem });

  const { data, error } = await supabase
    .from('route_plans')
    .insert({ user_id: userId, ...planRow(body.plan) })
    .select(SUMMARY_COLUMNS)
    .single();
  if (error) {
    if (isMissingTable(error)) return missingTableResponse(res);
    throw new Error(error.message);
  }

  try {
    await writeStopRows(supabase, data.id, body.plan);
  } catch (err) {
    if (isMissingTable(err)) return missingTableResponse(res);
    throw err;
  }

  return res.status(201).json({ ...data, linked_appointment_count: countLinkedAppointments(body.plan) });
}

async function handlePut(req, res, supabase, userId) {
  const id = (req.query?.id || '').toString();
  if (!id) return res.status(400).json({ error: 'Which saved run should be updated?' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const problem = planProblem(body.plan);
  if (problem) return res.status(400).json({ error: problem });

  // Scoped, so one operator cannot overwrite another's saved run by id.
  const { data, error } = await scopeToUser(
    supabase.from('route_plans').update(planRow(body.plan)).eq('id', id),
    userId
  )
    .select(SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return missingTableResponse(res);
    throw new Error(error.message);
  }
  if (!data) return res.status(404).json({ error: 'That saved run no longer exists.' });

  try {
    await writeStopRows(supabase, id, body.plan);
  } catch (err) {
    if (isMissingTable(err)) return missingTableResponse(res);
    throw err;
  }

  return res.status(200).json({ ...data, linked_appointment_count: countLinkedAppointments(body.plan) });
}

async function handleDelete(req, res, supabase, userId) {
  const id = (req.query?.id || '').toString();
  if (!id) return res.status(400).json({ error: 'Which saved run should be deleted?' });

  const { data, error } = await scopeToUser(
    supabase.from('route_plans').delete().eq('id', id),
    userId
  )
    .select('id')
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return missingTableResponse(res);
    throw new Error(error.message);
  }
  if (!data) return res.status(404).json({ error: 'That saved run no longer exists.' });

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
    if (req.method === 'GET') return await handleGet(req, res, supabase, user.id);
    if (req.method === 'POST') return await handlePost(req, res, supabase, user.id);
    if (req.method === 'PUT') return await handlePut(req, res, supabase, user.id);
    return await handleDelete(req, res, supabase, user.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
