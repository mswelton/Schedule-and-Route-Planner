import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMissingTable,
  withStoredAppointmentIds,
  countLinkedAppointments,
} from '../api/plans.js';

test('recognises the un-migrated database by its Postgres error code', () => {
  assert.equal(isMissingTable({ code: '42P01' }), true);
  // Supabase does not always populate `code`, so the message is a fallback.
  assert.equal(
    isMissingTable({ message: 'relation "public.route_plans" does not exist' }),
    true
  );
});

test('does not mistake other failures for a missing table', () => {
  assert.equal(isMissingTable(null), false);
  assert.equal(isMissingTable(undefined), false);
  assert.equal(isMissingTable({}), false);
  assert.equal(isMissingTable({ code: '23505', message: 'duplicate key value' }), false);
  // A row that is genuinely absent is a 404, not a missing table.
  assert.equal(isMissingTable({ message: 'JSON object requested, multiple rows returned' }), false);
  // Another table being absent is somebody else's problem.
  assert.equal(isMissingTable({ message: 'relation "public.horses" does not exist' }), false);
});

// ---------------------------------------------------------------------------
// Appointment links survive a reopen.
//
// The regression these cover: reopening a saved run rebuilt the editor from
// the `plan` blob, and saving wrote the stop rows back from it. Runs saved
// before appointment ids existed have no `appointmentIds` in their blob but
// correct `route_plan_stops.appointment_ids`, so that round trip silently
// wiped the links and took the run out of gross-profit reporting entirely.
// ---------------------------------------------------------------------------

const planWith = (stops) => ({ date: '2026-09-19', stops, totals: {} });

test('takes appointment links from the stop rows, not the stored blob', () => {
  const plan = planWith([
    { id: 'loc-a', onSiteMinutes: 150 },
    { id: 'loc-b', onSiteMinutes: 30 },
  ]);
  const merged = withStoredAppointmentIds(plan, [
    { sequence: 0, appointment_ids: ['appt-1', 'appt-2'] },
    { sequence: 1, appointment_ids: ['appt-3'] },
  ]);

  assert.deepEqual(merged.stops[0].appointmentIds, ['appt-1', 'appt-2']);
  assert.deepEqual(merged.stops[1].appointmentIds, ['appt-3']);
  // Everything else about the stop is left alone.
  assert.equal(merged.stops[0].onSiteMinutes, 150);
  assert.equal(merged.date, '2026-09-19');
});

test('the stop rows win even when the blob disagrees', () => {
  // Exactly the shape that lost the links: a blob remembering an empty array.
  const plan = planWith([{ id: 'loc-a', appointmentIds: [] }]);
  const merged = withStoredAppointmentIds(plan, [
    { sequence: 0, appointment_ids: ['appt-1'] },
  ]);
  assert.deepEqual(merged.stops[0].appointmentIds, ['appt-1']);
});

test('a stop with no matching row keeps what the blob had', () => {
  const plan = planWith([
    { id: 'loc-a', appointmentIds: ['appt-1'] },
    { id: 'loc-b', appointmentIds: ['appt-2'] },
  ]);
  // Only the first stop has a row — the second must not be blanked.
  const merged = withStoredAppointmentIds(plan, [
    { sequence: 0, appointment_ids: ['appt-9'] },
  ]);
  assert.deepEqual(merged.stops[0].appointmentIds, ['appt-9']);
  assert.deepEqual(merged.stops[1].appointmentIds, ['appt-2']);
});

test('merging is a no-op when there are no stop rows to merge', () => {
  const plan = planWith([{ id: 'loc-a', appointmentIds: ['appt-1'] }]);
  // An un-migrated database, or a run whose stops were never written.
  assert.deepEqual(withStoredAppointmentIds(plan, []), plan);
  assert.deepEqual(withStoredAppointmentIds(plan, null), plan);
  assert.deepEqual(withStoredAppointmentIds(plan, undefined), plan);
});

test('merging tolerates a plan that is not a plan', () => {
  const rows = [{ sequence: 0, appointment_ids: ['appt-1'] }];
  assert.equal(withStoredAppointmentIds(null, rows), null);
  assert.deepEqual(withStoredAppointmentIds({}, rows), {});
});

test('does not mutate the plan it was handed', () => {
  const plan = planWith([{ id: 'loc-a', appointmentIds: [] }]);
  withStoredAppointmentIds(plan, [{ sequence: 0, appointment_ids: ['appt-1'] }]);
  assert.deepEqual(plan.stops[0].appointmentIds, []);
});

test('counts the appointments a run is linked to', () => {
  assert.equal(
    countLinkedAppointments(
      planWith([{ appointmentIds: ['a', 'b'] }, { appointmentIds: ['c'] }])
    ),
    3
  );
});

test('counts zero for a run nothing is linked to, which is what gets flagged', () => {
  assert.equal(countLinkedAppointments(planWith([{ appointmentIds: [] }, {}])), 0);
  assert.equal(countLinkedAppointments(planWith([])), 0);
  assert.equal(countLinkedAppointments(null), 0);
  assert.equal(countLinkedAppointments({}), 0);
});
