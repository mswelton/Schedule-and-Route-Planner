import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFuelFigures, validateFuelInputs, MAX_DISTANCE_KM } from '../lib/fuel.js';

test('reproduces a real logged run', () => {
  // The 2026-08-06 row: 231 km at 9 L/100 km and $2.25/L.
  const figures = computeFuelFigures({
    distanceKm: 231,
    fuelConsumption: 9,
    fuelPrice: 2.25,
  });

  assert.equal(figures.litres_consumption, 20.79);
  assert.equal(figures.trip_cost, 46.78);
  assert.equal(figures.cost_per_km, 0.2025);
  assert.equal(figures.distance_traveled, 231);
});

test('rounds to the precision the numbers actually have', () => {
  // Stored by hand as 46.777499999999996 before this helper existed.
  const { trip_cost: cost } = computeFuelFigures({
    distanceKm: 231,
    fuelConsumption: 9,
    fuelPrice: 2.25,
  });
  assert.equal(String(cost), '46.78');

  const { distance_traveled: km } = computeFuelFigures({
    distanceKm: 115.14159,
    fuelConsumption: 9,
    fuelPrice: 2.25,
  });
  assert.equal(km, 115.1);
});

test('cost per km does not depend on how far the run was', () => {
  // It is consumption times price, so two runs at the same rates cost the
  // same per kilometre however long they are.
  const short = computeFuelFigures({ distanceKm: 37, fuelConsumption: 8.8, fuelPrice: 2 });
  const long = computeFuelFigures({ distanceKm: 284, fuelConsumption: 8.8, fuelPrice: 2 });
  assert.equal(short.cost_per_km, long.cost_per_km);
  assert.equal(short.cost_per_km, 0.176);
});

test('accepts the three figures a human supplies', () => {
  const ok = validateFuelInputs({ distanceKm: '148', fuelConsumption: '8.7', fuelPrice: '2.34' });
  assert.deepEqual(ok, { distanceKm: 148, fuelConsumption: 8.7, fuelPrice: 2.34 });
});

test('refuses figures that would put nonsense in the practice database', () => {
  const cases = [
    [{ distanceKm: 0, fuelConsumption: 9, fuelPrice: 2 }, /Distance/],
    [{ distanceKm: -5, fuelConsumption: 9, fuelPrice: 2 }, /Distance/],
    [{ distanceKm: MAX_DISTANCE_KM + 1, fuelConsumption: 9, fuelPrice: 2 }, /Distance/],
    [{ distanceKm: 'not a number', fuelConsumption: 9, fuelPrice: 2 }, /Distance/],
    [{ distanceKm: 100, fuelConsumption: 0, fuelPrice: 2 }, /Fuel use/],
    [{ distanceKm: 100, fuelConsumption: 9, fuelPrice: 0 }, /Fuel price/],
    [{ distanceKm: 100, fuelConsumption: 9, fuelPrice: 999 }, /Fuel price/],
  ];

  for (const [input, expected] of cases) {
    const result = validateFuelInputs(input);
    assert.match(result.error || '', expected, JSON.stringify(input));
  }
});

test('a missing figure is an error, not a zero', () => {
  // Number(null) is 0 and Number(undefined) is NaN; neither should slip
  // through as a valid distance.
  for (const missing of [null, undefined, '']) {
    const result = validateFuelInputs({
      distanceKm: missing,
      fuelConsumption: 9,
      fuelPrice: 2,
    });
    assert.match(result.error || '', /Distance/, `distance of ${JSON.stringify(missing)}`);
  }
});
