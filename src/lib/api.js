import { accessToken } from './auth.js';

/**
 * Every endpoint is behind Supabase Auth, so every call carries the access
 * token. Sending it from one place means a handler can never be added that
 * quietly forgets it.
 */
async function authHeaders(extra) {
  const token = await accessToken();
  if (!token) throw new Error('Sign in to use the planner.');
  return { ...extra, Authorization: `Bearer ${token}` };
}

async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers: await authHeaders(options.headers) });
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

/** Saved runs. `route_plans` is the only table this app owns. */
export function fetchSavedRuns() {
  return request('/api/plans');
}

export function fetchSavedRun(id) {
  return request(`/api/plans?id=${encodeURIComponent(id)}`);
}

export function saveRun(plan) {
  return request('/api/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
}

/** Compares the current stop order against Google's best; changes nothing. */
export function optimiseOrder(payload) {
  return request('/api/optimise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Last-used litres/100 km and $/litre, to prefill the fuel log. */
export function fetchFuelDefaults() {
  return request('/api/fuel-log');
}

export function logFuelCost(payload) {
  return request('/api/fuel-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Returns an object URL for the rendered route map, or null if unavailable. */
export async function fetchRouteMap({ polylines, markers }) {
  const res = await fetch('/api/staticmap', {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ polylines, markers, width: 640, height: 420 }),
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
