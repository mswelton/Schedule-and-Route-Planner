/**
 * A short-lived cache for Routes API legs (server-side only).
 *
 * A plan costs `stops + 2` Routes calls, and pressing "Work out my day" again
 * after nudging a stop's time on site used to pay for all of them a second
 * time — for legs whose answer had not changed. With seventeen locations there
 * are only so many distinct pairs, so most of that spend was repeat work.
 *
 * Two things make a cached leg safe to reuse:
 *
 * 1. **Departure times are bucketed.** Google's traffic estimate for a leg
 *    leaving at 08:07 and the same leg at 08:11 is the same answer to the
 *    precision anyone acts on, so departures are rounded to a 15-minute bucket
 *    and share an entry.
 * 2. **Entries expire.** A traffic estimate fetched an hour ago is not one you
 *    want to plan a run on, so entries live for ten minutes.
 *
 * This is deliberately in-memory rather than a table: it needs no schema in a
 * database this app does not own, and the case it exists for — pressing the
 * button repeatedly while adjusting a day — happens inside one warm serverless
 * instance. A cold start simply pays full price, which is the behaviour we had
 * before.
 */

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

/**
 * Identify a place by *where it is*, not by its id.
 *
 * The base is always id `base` even when Mark types a different address, so
 * keying on the id alone would serve him the previous base's drive times.
 */
function placeKey(place) {
  const lat = place?.lat ?? '';
  const lng = place?.lng ?? '';
  const address = place?.address ?? '';
  return `${lat},${lng},${address}`;
}

export function createLegCache({
  ttlMs = TEN_MINUTES,
  bucketMs = FIFTEEN_MINUTES,
  now = Date.now,
} = {}) {
  const entries = new Map();
  let hits = 0;
  let misses = 0;

  function evictExpired(at) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  }

  return {
    /**
     * Return a cached leg, or call `load()` and remember the result.
     *
     * A failed `load()` is not cached — a transient Routes API error should
     * not stick around for ten minutes.
     */
    async fetch(origin, destination, departureMs, load) {
      const at = now();
      const bucket = Number.isFinite(departureMs)
        ? Math.floor(departureMs / bucketMs) * bucketMs
        : 'none';
      const key = `${placeKey(origin)}->${placeKey(destination)}@${bucket}`;

      const existing = entries.get(key);
      if (existing && existing.expiresAt > at) {
        hits += 1;
        return existing.leg;
      }

      misses += 1;
      const leg = await load();
      entries.set(key, { leg, expiresAt: at + ttlMs });
      evictExpired(at);
      return leg;
    },

    get stats() {
      return { hits, misses, size: entries.size };
    },
  };
}

/**
 * The instance the handlers use. Module state on Vercel lives as long as the
 * warm instance does, which is exactly the window this is useful for.
 */
export const legCache = createLegCache();
