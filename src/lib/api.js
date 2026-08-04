async function request(path, options) {
  const res = await fetch(path, options);
  const contentType = res.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    if (!res.ok) throw new Error(`Request to ${path} failed (HTTP ${res.status}).`);
    return res;
  }

  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || `Request to ${path} failed (HTTP ${res.status}).`);
  return payload;
}

export function fetchLocations() {
  return request('/api/locations');
}

export function fetchAppointments(date) {
  return request(`/api/appointments?date=${encodeURIComponent(date)}`);
}

export function planRoute(payload) {
  return request('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Returns an object URL for the rendered route map, or null if unavailable. */
export async function fetchRouteMap({ polylines, markers }) {
  const res = await fetch('/api/staticmap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polylines, markers, width: 640, height: 420 }),
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
