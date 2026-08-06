import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegCache } from '../lib/legcache.js';

const leg = (seconds) => ({ seconds, meters: seconds * 10, warnings: [] });

/** A place with coordinates, as api/plan.js builds them. */
const at = (lat, lng) => ({ lat, lng, address: '' });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('a repeat of the same leg in the same departure bucket is not refetched', async () => {
  const cache = createLegCache({ now: clock().now });
  let calls = 0;
  const load = async () => {
    calls += 1;
    return leg(600);
  };

  const a = at(-38.4, 145.5);
  const b = at(-38.5, 145.6);
  const departure = Date.UTC(2026, 7, 6, 22, 3);

  assert.deepEqual(await cache.fetch(a, b, departure, load), leg(600));
  // Four minutes later is the same 15-minute bucket, so the same answer.
  assert.deepEqual(await cache.fetch(a, b, departure + 4 * 60 * 1000, load), leg(600));

  assert.equal(calls, 1);
  assert.deepEqual(cache.stats, { hits: 1, misses: 1, size: 1 });
});

test('a different bucket, direction or place is a different leg', async () => {
  const cache = createLegCache({ now: clock().now });
  let calls = 0;
  const load = async () => {
    calls += 1;
    return leg(calls);
  };

  const a = at(-38.4, 145.5);
  const b = at(-38.5, 145.6);
  const departure = Date.UTC(2026, 7, 6, 22, 3);

  await cache.fetch(a, b, departure, load);
  await cache.fetch(a, b, departure + 20 * 60 * 1000, load); // later bucket
  await cache.fetch(b, a, departure, load); // the run home is not the run out
  await cache.fetch(a, at(-38.9, 145.9), departure, load); // different stop

  assert.equal(calls, 4);
});

test('a base typed over with a new address does not reuse the old one', async () => {
  const cache = createLegCache({ now: clock().now });
  let calls = 0;
  const load = async () => {
    calls += 1;
    return leg(calls);
  };

  // Both are id 'base' to the rest of the app, which is exactly why the key
  // is built from where the place is rather than what it is called.
  const oldBase = { lat: null, lng: null, address: '205 Bass Rd, Bass' };
  const newBase = { lat: null, lng: null, address: '1 Other Rd, Wonthaggi' };
  const stop = at(-38.5, 145.6);
  const departure = Date.UTC(2026, 7, 6, 22, 3);

  await cache.fetch(oldBase, stop, departure, load);
  await cache.fetch(newBase, stop, departure, load);

  assert.equal(calls, 2);
});

test('entries go stale so a run is never planned on an old traffic estimate', async () => {
  const time = clock();
  const cache = createLegCache({ ttlMs: 10 * 60 * 1000, now: time.now });
  let calls = 0;
  const load = async () => {
    calls += 1;
    return leg(calls);
  };

  const a = at(-38.4, 145.5);
  const b = at(-38.5, 145.6);
  const departure = Date.UTC(2026, 7, 6, 22, 3);

  await cache.fetch(a, b, departure, load);
  time.advance(9 * 60 * 1000);
  await cache.fetch(a, b, departure, load);
  assert.equal(calls, 1, 'still fresh at nine minutes');

  time.advance(2 * 60 * 1000);
  await cache.fetch(a, b, departure, load);
  assert.equal(calls, 2, 'refetched past the ten-minute life');
});

test('a failed fetch is not remembered', async () => {
  const cache = createLegCache({ now: clock().now });
  const a = at(-38.4, 145.5);
  const b = at(-38.5, 145.6);
  const departure = Date.UTC(2026, 7, 6, 22, 3);

  await assert.rejects(
    () => cache.fetch(a, b, departure, async () => {
      throw new Error('transient Routes API failure');
    }),
    /transient/
  );

  let calls = 0;
  await cache.fetch(a, b, departure, async () => {
    calls += 1;
    return leg(600);
  });
  assert.equal(calls, 1, 'the retry actually reached the Routes API');
});
