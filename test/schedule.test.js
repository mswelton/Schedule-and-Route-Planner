import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItinerary } from '../lib/schedule.js';
import { zonedToInstant, instantToClock } from '../lib/time.js';

const TZ = 'Australia/Melbourne';

/** Stub leg fetcher driven by a from->to lookup of minutes and km. */
function stubLegs(table) {
  const calls = [];
  const getLeg = async (origin, destination, departureMs) => {
    const key = `${origin.label}->${destination.label}`;
    const entry = table[key];
    if (!entry) throw new Error(`No stub leg for ${key}`);
    calls.push({ key, departureMs });
    return {
      seconds: entry.minutes * 60,
      staticSeconds: entry.minutes * 60,
      trafficAware: true,
      meters: (entry.km ?? 0) * 1000,
      polyline: null,
      warnings: entry.warnings || [],
    };
  };
  return { getLeg, calls };
}

const base = { label: 'Sondela Farm', address: '205 Bass Rd, Bass, VIC 3991', lat: -38.48, lng: 145.49 };

test('builds the full schedule from the first appointment time', async () => {
  const stops = [
    { id: 'a', label: 'Wight Property', onSiteMinutes: 60 },
    { id: 'b', label: 'Milkins', onSiteMinutes: 45 },
    { id: 'c', label: 'Pryor - Residence', onSiteMinutes: 30 },
  ];

  const { getLeg } = stubLegs({
    'Sondela Farm->Wight Property': { minutes: 20, km: 15 },
    'Wight Property->Milkins': { minutes: 25, km: 20 },
    'Milkins->Pryor - Residence': { minutes: 15, km: 12 },
    'Pryor - Residence->Sondela Farm': { minutes: 30, km: 25 },
  });

  const firstAppointment = zonedToInstant('2026-08-06', '09:00', TZ);
  const plan = await buildItinerary({ base, stops, firstAppointment, getLeg });

  const clock = (ms) => instantToClock(ms, TZ);

  // Leave base = 09:00 minus the 20 min run to the first stop.
  assert.equal(clock(plan.leaveBase), '08:40');

  assert.equal(clock(plan.stops[0].arrival), '09:00');
  assert.equal(clock(plan.stops[0].departure), '10:00'); // +60 on site
  assert.equal(clock(plan.stops[1].arrival), '10:25'); // +25 drive
  assert.equal(clock(plan.stops[1].departure), '11:10'); // +45 on site
  assert.equal(clock(plan.stops[2].arrival), '11:25'); // +15 drive
  assert.equal(clock(plan.stops[2].departure), '11:55'); // +30 on site
  assert.equal(clock(plan.returnToBase), '12:25'); // +30 drive home

  assert.equal(plan.totals.drivingSeconds, (20 + 25 + 15 + 30) * 60);
  assert.equal(plan.totals.onSiteMinutes, 135);
  assert.equal(plan.totals.distanceMeters, 72000);
  assert.equal(plan.totals.dayLengthSeconds, (12 * 60 + 25 - (8 * 60 + 40)) * 60);
});

test('each leg is requested with the departure time it is actually driven at', async () => {
  const stops = [
    { id: 'a', label: 'Stop A', onSiteMinutes: 60 },
    { id: 'b', label: 'Stop B', onSiteMinutes: 30 },
  ];
  const { getLeg, calls } = stubLegs({
    'Sondela Farm->Stop A': { minutes: 30, km: 25 },
    'Stop A->Stop B': { minutes: 20, km: 18 },
    'Stop B->Sondela Farm': { minutes: 40, km: 35 },
  });

  const firstAppointment = zonedToInstant('2026-08-06', '09:00', TZ);
  const plan = await buildItinerary({ base, stops, firstAppointment, getLeg });
  const clock = (ms) => instantToClock(ms, TZ);

  // Leg 0 is priced twice: once at the appointment time to get a rough
  // duration, then again at the implied 08:30 leave time.
  assert.equal(calls[0].key, 'Sondela Farm->Stop A');
  assert.equal(clock(calls[0].departureMs), '09:00');
  assert.equal(calls[1].key, 'Sondela Farm->Stop A');
  assert.equal(clock(calls[1].departureMs), '08:30');

  // Subsequent legs are priced at the departure from the previous stop.
  assert.equal(clock(calls[2].departureMs), '10:00'); // leaving Stop A
  assert.equal(clock(calls[3].departureMs), '10:50'); // leaving Stop B
  assert.equal(clock(plan.returnToBase), '11:30');
});

test('a failed refinement of the first leg falls back to the rough estimate', async () => {
  let call = 0;
  const getLeg = async () => {
    call += 1;
    if (call === 2) throw new Error('transient Routes API failure');
    return { seconds: 900, staticSeconds: 900, trafficAware: true, meters: 10000, warnings: [] };
  };

  const firstAppointment = zonedToInstant('2026-08-06', '09:00', TZ);
  const plan = await buildItinerary({
    base,
    stops: [{ id: 'a', label: 'Stop A', onSiteMinutes: 30 }],
    firstAppointment,
    getLeg,
  });

  assert.equal(instantToClock(plan.leaveBase, TZ), '08:45');
});

test('routing warnings are attributed to the leg that produced them', async () => {
  const { getLeg } = stubLegs({
    'Sondela Farm->Stop A': { minutes: 20, km: 15 },
    'Stop A->Stop B': { minutes: 15, km: 10, warnings: ['This route has restricted usage or private roads.'] },
    'Stop B->Sondela Farm': { minutes: 25, km: 22 },
  });

  const plan = await buildItinerary({
    base,
    stops: [
      { id: 'a', label: 'Stop A', onSiteMinutes: 30 },
      { id: 'b', label: 'Stop B', onSiteMinutes: 30 },
    ],
    firstAppointment: zonedToInstant('2026-08-06', '09:00', TZ),
    getLeg,
  });

  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].from, 'Stop A');
  assert.equal(plan.warnings[0].to, 'Stop B');
  assert.match(plan.warnings[0].text, /private roads/);
  assert.equal(plan.stops[0].legToNext.warnings.length, 1);
});

test('a single-stop day still returns to base', async () => {
  const { getLeg } = stubLegs({
    'Sondela Farm->Stop A': { minutes: 45, km: 40 },
    'Stop A->Sondela Farm': { minutes: 45, km: 40 },
  });

  const plan = await buildItinerary({
    base,
    stops: [{ id: 'a', label: 'Stop A', onSiteMinutes: 90 }],
    firstAppointment: zonedToInstant('2026-08-06', '10:00', TZ),
    getLeg,
  });

  assert.equal(instantToClock(plan.leaveBase, TZ), '09:15');
  assert.equal(instantToClock(plan.returnToBase, TZ), '12:15');
});

test('rejects incomplete input', async () => {
  const getLeg = async () => ({ seconds: 0, meters: 0, warnings: [] });
  await assert.rejects(
    () => buildItinerary({ base, stops: [], firstAppointment: Date.now(), getLeg }),
    /At least one stop/
  );
  await assert.rejects(
    () => buildItinerary({ base: null, stops: [{ id: 'a', label: 'A' }], firstAppointment: Date.now(), getLeg }),
    /base location is required/
  );
});
