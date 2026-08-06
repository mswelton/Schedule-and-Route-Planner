/**
 * What a run costs in fuel.
 *
 * Pure arithmetic, kept out of the handler so the insert and the update paths
 * cannot drift apart — the derived figures are recomputed from the three
 * inputs on every write and never taken from the request. A client that sent
 * its own `trip_cost` would be writing a number nobody had checked into a
 * table the practice reads for its expenses.
 */

/**
 * Sanity bounds, not business rules. They exist to keep a typo out of the
 * practice database, not to tell Mark what a plausible day looks like.
 */
export const MAX_DISTANCE_KM = 2000;
export const MAX_CONSUMPTION = 100;
export const MAX_PRICE = 20;

const round = (n, places) => Number(n.toFixed(places));

function positiveNumber(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

/**
 * Check the three figures a human supplies.
 *
 * @returns {{ error: string } | { distanceKm, fuelConsumption, fuelPrice }}
 */
export function validateFuelInputs({ distanceKm, fuelConsumption, fuelPrice }) {
  const km = positiveNumber(distanceKm, MAX_DISTANCE_KM);
  if (km === null) return { error: `Distance must be between 0 and ${MAX_DISTANCE_KM} km.` };

  const consumption = positiveNumber(fuelConsumption, MAX_CONSUMPTION);
  if (consumption === null) {
    return { error: 'Fuel use must be a positive figure in litres per 100 km.' };
  }

  const price = positiveNumber(fuelPrice, MAX_PRICE);
  if (price === null) {
    return { error: 'Fuel price must be a positive figure in dollars per litre.' };
  }

  return { distanceKm: km, fuelConsumption: consumption, fuelPrice: price };
}

/**
 * The columns `fuel_cost_calculations` stores, derived from the three inputs.
 *
 * Rounded on the way in: the older hand-entered rows carry values like
 * 46.777499999999996, and anything written or corrected through here comes out
 * at the precision the numbers actually have.
 */
export function computeFuelFigures({ distanceKm, fuelConsumption, fuelPrice }) {
  const litres = (distanceKm * fuelConsumption) / 100;
  const tripCost = litres * fuelPrice;

  return {
    distance_traveled: round(distanceKm, 1),
    fuel_consumption: fuelConsumption,
    fuel_cost: fuelPrice,
    litres_consumption: round(litres, 2),
    trip_cost: round(tripCost, 2),
    cost_per_km: round(tripCost / distanceKm, 4),
  };
}
