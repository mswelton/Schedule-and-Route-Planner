import test from 'node:test';
import assert from 'node:assert/strict';
import { keyRestrictionHint, toWaypoint } from '../lib/google.js';

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

test('uses stored coordinates when the row has them', () => {
  assert.deepEqual(toWaypoint({ lat: -38.48, lng: 145.49, address: '205 Bass Rd' }), {
    location: { latLng: { latitude: -38.48, longitude: 145.49 } },
  });
});

test('a row with no coordinates geocodes its address rather than routing to 0,0', () => {
  // Number(null) is 0 and 0 is a finite latitude, so this is the case that
  // silently sent a stop to the Gulf of Guinea instead of falling through.
  for (const missing of [null, undefined, '']) {
    assert.deepEqual(
      toWaypoint({ lat: missing, lng: missing, address: '205 Bass Rd, Bass VIC 3991' }),
      { address: '205 Bass Rd, Bass VIC 3991' },
      `lat/lng of ${JSON.stringify(missing)}`
    );
  }
});

test('a place with neither coordinates nor an address is an error, not a guess', () => {
  assert.throws(() => toWaypoint({ label: 'Nowhere' }), /neither coordinates nor an address/);
});

test('stays quiet for errors that are not about the key', () => {
  assert.equal(keyRestrictionHint('ZERO_RESULTS'), '');
  assert.equal(keyRestrictionHint('Deadline exceeded'), '');
  assert.equal(keyRestrictionHint(undefined), '');
});
