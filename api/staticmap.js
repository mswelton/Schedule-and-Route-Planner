/**
 * POST /api/staticmap
 *
 * Body: { polylines: string[], markers: [{ lat, lng, label }], width, height }
 *
 * Renders the day's route as a Static Maps image and streams the bytes back, so
 * the Maps key stays server-side. The client fetches this and wraps the
 * response in an object URL rather than pointing an <img src> at Google.
 *
 * POST rather than GET because encoded polylines for a full day comfortably
 * exceed what is sane to put in a query string.
 */

import { authenticate } from '../lib/auth.js';

const STATIC_MAPS_ENDPOINT = 'https://maps.googleapis.com/maps/api/staticmap';

// A day's run is base + stops + return. Capping well above that keeps this
// from being usable as a general-purpose Static Maps proxy on our key.
const MAX_PATHS = 30;
const MAX_MARKERS = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await authenticate(req, res);
  if (!user) return undefined;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY is not set on the server.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const polylines = (Array.isArray(body.polylines) ? body.polylines.filter(Boolean) : []).slice(
    0,
    MAX_PATHS
  );
  const markers = (Array.isArray(body.markers) ? body.markers : []).slice(0, MAX_MARKERS);

  if (!polylines.length && !markers.length) {
    return res.status(400).json({ error: 'Nothing to draw.' });
  }

  const params = new URLSearchParams();
  params.set('size', `${Math.min(Number(body.width) || 640, 640)}x${Math.min(Number(body.height) || 420, 640)}`);
  params.set('scale', '2');
  params.set('maptype', 'roadmap');
  params.set('key', apiKey);

  for (const polyline of polylines) {
    params.append('path', `color:0xE8621Aff|weight:4|enc:${polyline}`);
  }
  for (const marker of markers) {
    if (!Number.isFinite(marker.lat) || !Number.isFinite(marker.lng)) continue;
    const label = String(marker.label ?? '').slice(0, 1).toUpperCase() || '•';
    params.append('markers', `color:0x3D3D3Dff|label:${label}|${marker.lat},${marker.lng}`);
  }

  try {
    const upstream = await fetch(`${STATIC_MAPS_ENDPOINT}?${params.toString()}`);
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return res
        .status(502)
        .json({ error: `Static Maps request failed (HTTP ${upstream.status}). ${detail}`.trim() });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
