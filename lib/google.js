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

/**
 * A coordinate, or null when the row hasn't got one.
 *
 * `Number(null)` is 0 and 0 is finite, so checking `Number.isFinite(Number(x))`
 * alone turns a missing latitude into a real place in the Gulf of Guinea
 * instead of falling through to the address. Empty strings do the same.
 */
function coordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Build a Routes API waypoint, preferring stored coordinates over geocoding. */
export function toWaypoint(place) {
  const lat = coordinate(place.lat);
  const lng = coordinate(place.lng);
  if (lat !== null && lng !== null) {
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
 * Turn Google's key-restriction errors into something actionable.
 *
 * The referrer case is the one that actually bites: a key created for web use
 * defaults to an HTTP referrer restriction, and every call here is made
 * server-side with no Referer header, so all of them are rejected.
 */
export function keyRestrictionHint(detail) {
  const message = String(detail || '');
  if (/referer/i.test(message)) {
    return (
      ' — this key has an HTTP referrer restriction, which cannot work for' +
      ' server-side calls. In the Google Cloud Console set Application' +
      ' restrictions to "None" and restrict the key by API instead (Routes API,' +
      ' Maps Static API).'
    );
  }
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|has not been used|is disabled/i.test(message)) {
    return (
      ' — check GOOGLE_MAPS_API_KEY is correct and that the Routes API and Maps' +
      ' Static API are enabled on that key\'s project.'
    );
  }
  return '';
}

/**
 * Price a whole run in one call, optionally letting Google choose the order.
 *
 * This exists **only to compare orderings**. Do not build an itinerary from
 * it: a multi-waypoint route assumes you drive straight through, so it knows
 * nothing about the forty-five minutes spent at each property, and its leg
 * times are therefore priced at the wrong times of day. Once an order is
 * chosen, `buildItinerary` re-prices each leg at the moment it is actually
 * driven, which is the number Mark acts on.
 *
 * @param {object}   base          start and finish
 * @param {object[]} stops         the run, in the order to evaluate
 * @param {boolean}  optimize      let Google reorder the intermediates
 * @returns {Promise<{ seconds, meters, order: number[] }>} `order` indexes into
 *          `stops` — identity when `optimize` is false.
 */
export async function fetchRunOverview(base, stops, { optimize = false, apiKey } = {}) {
  const key = apiKey || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set on the server.');
  if (!stops.length) throw new Error('A run needs at least one stop.');

  const body = {
    origin: toWaypoint(base),
    // The run finishes where it started, so every stop is an intermediate.
    destination: toWaypoint(base),
    intermediates: stops.map(toWaypoint),
    travelMode: 'DRIVE',
    // Traffic-unaware on purpose: this compares orderings, and a comparison
    // wants the same conditions on both sides rather than a snapshot of
    // whatever the traffic happens to be doing right now.
    routingPreference: 'TRAFFIC_UNAWARE',
    optimizeWaypointOrder: optimize,
    languageCode: 'en-AU',
    units: 'METRIC',
    regionCode: 'AU',
  };

  const res = await fetch(ROUTES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': [
        'routes.duration',
        'routes.distanceMeters',
        'routes.optimizedIntermediateWaypointIndex',
      ].join(','),
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Routes API failed while comparing stop orders: ${detail}${keyRestrictionHint(detail)}`);
  }

  const route = payload.routes?.[0];
  if (!route) throw new Error('No driving route found for this run.');

  const optimized = route.optimizedIntermediateWaypointIndex;
  return {
    seconds: parseDuration(route.duration),
    meters: route.distanceMeters || 0,
    order: Array.isArray(optimized) ? optimized : stops.map((_, i) => i),
  };
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
      `Routes API failed for ${origin.label || 'origin'} → ${destination.label || 'destination'}: ${detail}${keyRestrictionHint(detail)}`
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
