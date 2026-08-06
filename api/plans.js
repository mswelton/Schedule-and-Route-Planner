/**
 * /api/plans
 *
 * GET            — the most recent saved runs, newest first (summaries only).
 * GET ?id=<uuid> — one saved run, with its full stored itinerary.
 * POST           — save the itinerary the browser is currently showing.
 *
 * A planned run used to live until the tab closed. This keeps it, so a day can
 * be reopened later without recomputing — and without paying for — the Routes
 * API calls that produced it.
 *
 * `route_plans` is the only table this app owns. It deliberately does **not**
 * write to `appointments`: the planner suggests times, and changing bookings
 * clients have already been given stays a decision made in the main app.
 *
 * The table is created by docs/migrations/001_create_route_plans.sql. Until
 * that has been applied, these endpoints say so rather than failing obscurely.
 */

import { serverSupabase, scopeToUser } from '../lib/supabase.js';
import { authenticate } from '../lib/auth.js';

const LIST_LIMIT = 25;

const SUMMARY_COLUMNS =
  'id, run_date, base_label, stop_count, total_distance_m, total_driving_seconds, ' +
  'total_on_site_minutes, day_length_seconds, leave_base_clock, return_to_base_clock, created_at';

/**
 * PostgREST surfaces Postgres' 42P01 ("relation does not exist") when the
 * migration has not been applied. Exported so the detection is tested — this
 * is the difference between a useful message and an opaque 500.
 */
export function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01') return true;
  return /relation .*route_plans.* does not exist/i.test(error.message || '');
}

function missingTableResponse(res) {
  return res.status(503).json({
    error:
      'Saved runs need the route_plans table. Apply ' +
      'docs/migrations/001_create_route_plans.sql in the Supabase SQL editor, then try again.',
  });
}

const integer = (value) => Math.max(0, Math.round(Number(value) || 0));

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
    return res.status(200).json(data);
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
  const plan = body.plan;

  if (!plan || typeof plan !== 'object') {
    return res.status(400).json({ error: 'A planned run is required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date || '')) {
    return res.status(400).json({ error: 'That run has no valid date.' });
  }
  if (!Array.isArray(plan.stops) || plan.stops.length === 0) {
    return res.status(400).json({ error: 'That run has no stops.' });
  }
  if (!plan.totals || typeof plan.totals !== 'object') {
    return res.status(400).json({ error: 'That run has no totals.' });
  }

  // The totals are echoed back from an itinerary this server produced, the
  // same trade api/fuel-log.js makes: recomputing would mean paying for every
  // Routes call again. They are only ever read back out to this same user.
  const row = {
    user_id: userId,
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

  const { data, error } = await supabase
    .from('route_plans')
    .insert(row)
    .select(SUMMARY_COLUMNS)
    .single();
  if (error) {
    if (isMissingTable(error)) return missingTableResponse(res);
    throw new Error(error.message);
  }

  return res.status(201).json(data);
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
      ? await handleGet(req, res, supabase, user.id)
      : await handlePost(req, res, supabase, user.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
