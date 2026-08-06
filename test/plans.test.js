import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingTable } from '../api/plans.js';

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
