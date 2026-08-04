/**
 * Google Routes API client (server-side only — never import this from src/).
 *
 * Uses the Routes API `computeRoutes` endpoint rather than the legacy
 * Directions API: it is the current product, it takes a future `departureTime`
 * for predictive traffic, and it returns per-route `warnings` (the
 * "restricted usage or private roads" advisories Mark needs to see).
 */

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const FIELD_MASK = [
  'routes.duration',
  'routes.staticDuration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.warnings',
  'routes.travelAdvisory',
].join(',');

/** Build a Routes API waypoint, preferring stored coordinates over geocoding. */
function toWaypoint(place) {
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { location: { latLng: { latitude: lat, longitude: lng } } };
  }
  if (place.address) {
    // Routes API geocodes address strings itself, so this is the fallback path
    // for locations with no lat/lng on the row.
    return { address: place.address };
  }
  throw new Error(`Location "${place.label || 'unknown'}" has neither coordinates nor an address.`);
}

/** Routes API returns durations as a string of seconds, e.g. "1837s". */
function parseDuration(value) {
  if (typeof value !== 'string') return 0;
  return Number(value.replace(/s$/, '')) || 0;
}

function collectWarnings(route) {
  const warnings = [...(route.warnings || [])];
  const advisory = route.travelAdvisory || {};
  if (advisory.routeRestrictionsPartiallyIgnored) {
    warnings.push(
      'Some route restrictions were ignored to produce this route — check access before relying on it.'
    );
  }
  if (advisory.tollInfo && Array.isArray(advisory.tollInfo.estimatedPrice)) {
    for (const price of advisory.tollInfo.estimatedPrice) {
      const amount = [price.units, price.nanos ? String(price.nanos).padStart(9, '0').slice(0, 2) : null]
        .filter(Boolean)
        .join('.');
      warnings.push(`Tolls on this leg (approx. ${price.currencyCode || ''} ${amount})`.trim());
    }
  }
  return warnings;
}

/**
 * Fetch a single driving leg.
 *
 * @param {object} origin       { label, lat, lng, address }
 * @param {object} destination  same shape
 * @param {number} departureMs  epoch ms; ignored (with a fallback to
 *                              traffic-unaware routing) if it is in the past,
 *                              since the API rejects past departure times.
 */
export async function fetchLeg(origin, destination, departureMs, options = {}) {
  const apiKey = options.apiKey || process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not set on the server.');
  }

  // Give the API a small margin — a departureTime that lands in the past
  // between building the request and it being served is rejected outright.
  const trafficAware = Number.isFinite(departureMs) && departureMs > Date.now() + 60_000;

  const body = {
    origin: toWaypoint(origin),
    destination: toWaypoint(destination),
    travelMode: 'DRIVE',
    routingPreference: trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: false,
    languageCode: 'en-AU',
    units: 'METRIC',
    regionCode: 'AU',
  };
  if (trafficAware) {
    body.departureTime = new Date(departureMs).toISOString();
  }

  const res = await fetch(ROUTES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(
      `Routes API failed for ${origin.label || 'origin'} → ${destination.label || 'destination'}: ${detail}`
    );
  }

  const route = payload.routes?.[0];
  if (!route) {
    throw new Error(
      `No driving route found between ${origin.label || 'origin'} and ${destination.label || 'destination'}.`
    );
  }

  const seconds = parseDuration(route.duration);
  const staticSeconds = parseDuration(route.staticDuration);

  return {
    seconds,
    // Surfacing the traffic-free duration lets the UI show how much of the leg
    // is congestion rather than distance.
    staticSeconds,
    trafficAware,
    meters: route.distanceMeters || 0,
    polyline: route.polyline?.encodedPolyline || null,
    warnings: collectWarnings(route),
  };
}
