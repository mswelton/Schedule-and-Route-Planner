import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedToInstant, instantToClock, isNextDay } from '../lib/time.js';

const TZ = 'Australia/Melbourne';

test('converts Melbourne wall-clock times to instants on both sides of DST', () => {
  // August: AEST, UTC+10.
  assert.equal(new Date(zonedToInstant('2026-08-06', '09:00', TZ)).toISOString(), '2026-08-05T23:00:00.000Z');
  // January: AEDT, UTC+11.
  assert.equal(new Date(zonedToInstant('2026-01-15', '09:00', TZ)).toISOString(), '2026-01-14T22:00:00.000Z');
});

test('round-trips wall-clock times through instants', () => {
  for (const [date, time] of [
    ['2026-08-06', '06:35'],
    ['2026-01-15', '17:45'],
    ['2026-04-05', '09:00'], // DST ends in Victoria on this date
    ['2026-10-04', '09:00'], // DST starts
  ]) {
    assert.equal(instantToClock(zonedToInstant(date, time, TZ), TZ), time, `${date} ${time}`);
  }
});

test('detects a return that rolls past midnight', () => {
  const leave = zonedToInstant('2026-08-06', '22:00', TZ);
  const backSameDay = zonedToInstant('2026-08-06', '23:30', TZ);
  const backNextDay = zonedToInstant('2026-08-07', '01:15', TZ);

  assert.equal(isNextDay(backSameDay, leave, TZ), false);
  assert.equal(isNextDay(backNextDay, leave, TZ), true);
});

test('rejects malformed date or time strings', () => {
  assert.throws(() => zonedToInstant('not-a-date', '09:00', TZ), /Invalid date\/time/);
  assert.throws(() => zonedToInstant('2026-08-06', 'noon', TZ), /Invalid date\/time/);
});
