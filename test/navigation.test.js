import test from 'node:test';
import assert from 'node:assert/strict';
import {
  googleMapsStopUrl,
  appleMapsStopUrl,
  googleMapsDayUrl,
  MAX_WAYPOINTS,
} from '../src/lib/navigation.js';

const stop = (n, extra = {}) => ({ label: `Stop ${n}`, lat: -38.4 - n / 100, lng: 145.5, ...extra });

test('prefers stored coordinates over the address string', () => {
  const url = googleMapsStopUrl({ lat: -38.48, lng: 145.49, address: '205 Bass Rd, Bass' });
  assert.match(url, /destination=-38\.48%2C145\.49/);
  assert.doesNotMatch(url, /Bass%20Rd/);
});

test('falls back to the address when a row has no coordinates', () => {
  const url = googleMapsStopUrl({ lat: null, lng: null, address: '205 Bass Rd, Bass VIC 3991' });
  assert.match(url, /destination=205%20Bass%20Rd%2C%20Bass%20VIC%203991/);

  assert.equal(googleMapsStopUrl({ lat: null, lng: null, address: '' }), null);
  assert.equal(appleMapsStopUrl({}), null);
});

test('Apple Maps gets a driving directions link', () => {
  const url = appleMapsStopUrl({ lat: -38.48, lng: 145.49 });
  assert.match(url, /^https:\/\/maps\.apple\.com\/\?dirflg=d&daddr=-38\.48%2C145\.49$/);
});

test('the whole-day link starts and finishes at base, with the stops between', () => {
  const base = { label: 'Sondela Farm', lat: -38.48, lng: 145.49 };
  const { url, dropped } = googleMapsDayUrl(base, [stop(1), stop(2)]);

  assert.equal(dropped, 0);
  const params = new URL(url).searchParams;
  assert.equal(params.get('origin'), '-38.48,145.49');
  assert.equal(params.get('destination'), '-38.48,145.49');
  assert.equal(params.get('waypoints'), '-38.41,145.5|-38.42,145.5');
  assert.equal(params.get('travelmode'), 'driving');
});

test('reports the stops that do not fit under the waypoint cap', () => {
  const base = { label: 'Sondela Farm', lat: -38.48, lng: 145.49 };
  const stops = Array.from({ length: MAX_WAYPOINTS + 3 }, (_, i) => stop(i + 1));
  const { url, dropped } = googleMapsDayUrl(base, stops);

  assert.equal(dropped, 3);
  assert.equal(new URL(url).searchParams.get('waypoints').split('|').length, MAX_WAYPOINTS);
});

test('a day with no usable stops has no link', () => {
  assert.equal(googleMapsDayUrl({ lat: -38.48, lng: 145.49 }, []), null);
  assert.equal(googleMapsDayUrl({}, [stop(1)]), null);
});
