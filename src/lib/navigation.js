/**
 * Deep links into the phone's map app.
 *
 * The planner works out *when* to leave; the driving itself still happens in
 * Google or Apple Maps, and retyping an address at the gate is the thing this
 * saves. Coordinates are used where the row has them — they are exact, and
 * several of these properties are a paddock rather than a postal address.
 */

/** Google's URL API caps a directions link at nine intermediate waypoints. */
export const MAX_WAYPOINTS = 9;

/**
 * A coordinate, or null when the row hasn't got one.
 *
 * `Number(null)` is 0 and 0 is finite, so a plain `Number.isFinite` check turns
 * a missing latitude into a real place in the Gulf of Guinea rather than
 * falling through to the address.
 */
function coordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `-38.48,145.49` when the place has coordinates, else its address string. */
function target(place) {
  const lat = coordinate(place?.lat);
  const lng = coordinate(place?.lng);
  if (lat !== null && lng !== null) return `${lat},${lng}`;
  return place?.address || '';
}

/** Directions to a single stop, from wherever the driver currently is. */
export function googleMapsStopUrl(stop) {
  const destination = target(stop);
  if (!destination) return null;
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(destination)}`;
}

export function appleMapsStopUrl(stop) {
  const destination = target(stop);
  if (!destination) return null;
  return `https://maps.apple.com/?dirflg=d&daddr=${encodeURIComponent(destination)}`;
}

/**
 * The whole run as one Google Maps route: base → each stop → base.
 *
 * Returns `{ url, dropped }`, where `dropped` is the number of stops that did
 * not fit under the waypoint cap. A day that long is rare — the busiest recent
 * run was eight stops — but silently losing the tail of the route would be
 * worse than saying so.
 */
export function googleMapsDayUrl(base, stops) {
  const origin = target(base);
  const waypoints = stops.map(target).filter(Boolean);
  if (!origin || waypoints.length === 0) return null;

  const included = waypoints.slice(0, MAX_WAYPOINTS);
  const params = new URLSearchParams({
    api: '1',
    travelmode: 'driving',
    origin,
    // The run finishes where it started, so the last stop stays a waypoint.
    destination: origin,
    waypoints: included.join('|'),
  });

  return {
    url: `https://www.google.com/maps/dir/?${params.toString()}`,
    dropped: waypoints.length - included.length,
  };
}
