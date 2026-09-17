import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoutePlanId } from '../api/fuel-log.js';

/**
 * Just enough of the Supabase query builder for resolveRoutePlanId's chain:
 * .from().select().eq().order().limit(), then scopeToUser's extra .eq() -
 * every step but the last returns the same chainable, thenable object.
 */
function fakeSupabase(result) {
  const builder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    then(resolve, reject) {
      Promise.resolve(result).then(resolve, reject);
    },
  };
  return { from: () => builder };
}

test('trusts a client-supplied routePlanId as-is, without querying the database', async () => {
  let queried = false;
  const supabase = {
    from() {
      queried = true;
      return {};
    },
  };
  const id = await resolveRoutePlanId(supabase, 'user-1', '2026-09-13', 'existing-id');
  assert.equal(id, 'existing-id');
  assert.equal(queried, false);
});

test('treats an empty-string routePlanId as none supplied, not a valid id', async () => {
  const supabase = fakeSupabase({ data: [{ id: 'found-id' }], error: null });
  const id = await resolveRoutePlanId(supabase, 'user-1', '2026-09-13', '');
  assert.equal(id, 'found-id');
});

test('falls back to the route_plans row for the same date when none was supplied', async () => {
  const supabase = fakeSupabase({ data: [{ id: 'found-id' }], error: null });
  assert.equal(await resolveRoutePlanId(supabase, 'user-1', '2026-09-13', null), 'found-id');
  assert.equal(await resolveRoutePlanId(supabase, 'user-1', '2026-09-13', undefined), 'found-id');
});

test('returns null when no route_plans row exists for the date', async () => {
  const supabase = fakeSupabase({ data: [], error: null });
  const id = await resolveRoutePlanId(supabase, 'user-1', '2026-09-13', null);
  assert.equal(id, null);
});

test('is best-effort: a lookup error resolves to null rather than throwing', async () => {
  const supabase = fakeSupabase({ data: null, error: { message: 'boom' } });
  const id = await resolveRoutePlanId(supabase, 'user-1', '2026-09-13', null);
  assert.equal(id, null);
});
