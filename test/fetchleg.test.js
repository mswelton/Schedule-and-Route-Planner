import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLeg } from '../lib/google.js';

/**
 * What we send to the Routes API and what we make of the answer.
 *
 * `fetch` is stubbed rather than mocked at a distance, so these assert the
 * actual request body — the traffic-aware switch in particular, which decides
 * whether Google gives a predictive estimate or a free-flow one.
 */

const HOUR = 60 * 60 * 1000;
const origin = { label: 'Sondela Farm', lat: -38.48, lng: 145.49 };
const destination = { label: 'Wight Property', lat: -38.6, lng: 145.7 };

/** Swap in a fetch that records its request and returns `payload`. */
function stubFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status, json: async () => payload };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const routePayload = (route) => ({ routes: [route] });

test('a future departure is priced with traffic, and sent as the departure time', async (t) => {
  const stub = stubFetch(
    routePayload({
      duration: '1837s',
      staticDuration: '1500s',
      distanceMeters: 24500,
      polyline: { encodedPolyline: 'abc123' },
    })
  );
  t.after(stub.restore);

  const departure = Date.now() + 2 * HOUR;
  const leg = await fetchLeg(origin, destination, departure, { apiKey: 'test-key' });

  const { body, init } = stub.calls[0];
  assert.equal(body.routingPreference, 'TRAFFIC_AWARE');
  assert.equal(body.departureTime, new Date(departure).toISOString());
  assert.deepEqual(body.origin, { location: { latLng: { latitude: -38.48, longitude: 145.49 } } });
  assert.equal(init.headers['X-Goog-Api-Key'], 'test-key');

  assert.equal(leg.seconds, 1837);
  assert.equal(leg.staticSeconds, 1500);
  assert.equal(leg.meters, 24500);
  assert.equal(leg.polyline, 'abc123');
  assert.equal(leg.trafficAware, true);
});

test('a departure in the past falls back to traffic-unaware, with no departure time', async (t) => {
  const stub = stubFetch(routePayload({ duration: '1200s', distanceMeters: 18000 }));
  t.after(stub.restore);

  // The Routes API rejects a past departureTime outright, which is why this
  // is a fallback rather than an error.
  const leg = await fetchLeg(origin, destination, Date.now() - HOUR, { apiKey: 'test-key' });

  const { body } = stub.calls[0];
  assert.equal(body.routingPreference, 'TRAFFIC_UNAWARE');
  assert.equal('departureTime' in body, false);
  assert.equal(leg.trafficAware, false);
  assert.equal(leg.seconds, 1200);
});

test('a departure inside the next minute is treated as past', async (t) => {
  const stub = stubFetch(routePayload({ duration: '600s', distanceMeters: 9000 }));
  t.after(stub.restore);

  // A departureTime that lands in the past between building the request and
  // it being served is rejected, so there is a deliberate margin.
  const leg = await fetchLeg(origin, destination, Date.now() + 30_000, { apiKey: 'test-key' });
  assert.equal(leg.trafficAware, false);
  assert.equal(stub.calls[0].body.routingPreference, 'TRAFFIC_UNAWARE');
});

test('warnings, ignored restrictions and tolls all reach the itinerary', async (t) => {
  const stub = stubFetch(
    routePayload({
      duration: '900s',
      distanceMeters: 12000,
      warnings: ['This route has restricted usage or private roads.'],
      travelAdvisory: {
        routeRestrictionsPartiallyIgnored: true,
        tollInfo: { estimatedPrice: [{ currencyCode: 'AUD', units: '3', nanos: 500000000 }] },
      },
    })
  );
  t.after(stub.restore);

  const leg = await fetchLeg(origin, destination, Date.now() + HOUR, { apiKey: 'test-key' });

  assert.equal(leg.warnings.length, 3);
  assert.match(leg.warnings[0], /private roads/);
  assert.match(leg.warnings[1], /restrictions were ignored/);
  assert.equal(leg.warnings[2], 'Tolls on this leg (approx. AUD 3.50)');
});

test('a rejected key is reported with what to do about it', async (t) => {
  const stub = stubFetch(
    { error: { message: 'Requests from referer <empty> are blocked.' } },
    { ok: false, status: 403 }
  );
  t.after(stub.restore);

  await assert.rejects(
    () => fetchLeg(origin, destination, Date.now() + HOUR, { apiKey: 'test-key' }),
    (err) => {
      assert.match(err.message, /Sondela Farm → Wight Property/);
      assert.match(err.message, /HTTP referrer restriction/);
      return true;
    }
  );
});

test('a route Google cannot find names both ends', async (t) => {
  const stub = stubFetch({ routes: [] });
  t.after(stub.restore);

  await assert.rejects(
    () => fetchLeg(origin, destination, Date.now() + HOUR, { apiKey: 'test-key' }),
    /No driving route found between Sondela Farm and Wight Property/
  );
});

test('a missing key is caught before any request is made', async (t) => {
  const stub = stubFetch(routePayload({ duration: '60s' }));
  t.after(stub.restore);
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved;
  });

  await assert.rejects(
    () => fetchLeg(origin, destination, Date.now() + HOUR),
    /GOOGLE_MAPS_API_KEY is not set/
  );
  assert.equal(stub.calls.length, 0);
});
