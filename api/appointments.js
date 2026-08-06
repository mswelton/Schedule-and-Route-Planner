/**
 * GET /api/appointments?date=YYYY-MM-DD
 *
 * Convenience path for pre-filling the day: returns the booked appointments for
 * a date grouped by service location, in scheduled-time order, with the horse
 * durations summed so each location becomes one stop.
 */

import { serverSupabase, scopeToUser } from '../lib/supabase.js';
import { authenticate } from '../lib/auth.js';

const EXCLUDED_STATUSES = new Set(['cancelled', 'declined', 'no_show']);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await authenticate(req, res);
  if (!user) return undefined;

  const date = (req.query?.date || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A date query parameter (YYYY-MM-DD) is required.' });
  }

  try {
    const supabase = serverSupabase();
    const { data, error } = await scopeToUser(
      supabase
        .from('appointments')
        .select(
          'id, horse_id, scheduled_time, estimated_duration_minutes, status, service_location_id'
        )
        .eq('scheduled_date', date)
        .not('service_location_id', 'is', null)
        .order('scheduled_time', { ascending: true, nullsFirst: false }),
      user.id
    );
    if (error) throw new Error(error.message);

    const grouped = new Map();
    for (const appt of data || []) {
      if (EXCLUDED_STATUSES.has((appt.status || '').toLowerCase())) continue;

      const existing = grouped.get(appt.service_location_id);
      const minutes = Number(appt.estimated_duration_minutes) || 0;
      if (existing) {
        existing.onSiteMinutes += minutes;
        existing.appointmentCount += 1;
        if (!existing.earliestTime && appt.scheduled_time) {
          existing.earliestTime = appt.scheduled_time;
        }
      } else {
        grouped.set(appt.service_location_id, {
          locationId: appt.service_location_id,
          onSiteMinutes: minutes,
          appointmentCount: 1,
          earliestTime: appt.scheduled_time || null,
        });
      }
    }

    return res.status(200).json({ date, stops: [...grouped.values()] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
