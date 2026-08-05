import test from 'node:test';
import assert from 'node:assert/strict';
import { keyRestrictionHint } from '../lib/google.js';

test('explains the referrer restriction, the one that blocks server-side calls', () => {
  const hint = keyRestrictionHint('Requests from referer <empty> are blocked.');
  assert.match(hint, /HTTP referrer restriction/);
  assert.match(hint, /Application restrictions to "None"/);
});

test('points at the key and enabled APIs for the other key failures', () => {
  for (const message of [
    'API key not valid. Please pass a valid API key.',
    'PERMISSION_DENIED',
    'Routes API has not been used in project 12345 before or it is disabled.',
  ]) {
    assert.match(keyRestrictionHint(message), /GOOGLE_MAPS_API_KEY/, message);
  }
});

test('stays quiet for errors that are not about the key', () => {
  assert.equal(keyRestrictionHint('ZERO_RESULTS'), '');
  assert.equal(keyRestrictionHint('Deadline exceeded'), '');
  assert.equal(keyRestrictionHint(undefined), '');
});
