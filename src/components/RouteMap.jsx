import { useEffect, useState } from 'react';
import { fetchRouteMap } from '../lib/api.js';

/**
 * Static map preview of the day. The image is fetched through our own function
 * (which holds the Maps key) and shown from an object URL, so no key or Maps
 * JS bundle reaches the browser.
 */
export default function RouteMap({ plan }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;

    const polylines = [
      plan.legToFirstStop?.polyline,
      ...plan.stops.map((stop) => stop.legToNext?.polyline),
    ].filter(Boolean);

    const markers = plan.stops
      .map((stop, i) => ({ lat: stop.lat, lng: stop.lng, label: String(i + 1) }))
      .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));

    if (polylines.length === 0) {
      setFailed(true);
      return undefined;
    }

    setFailed(false);
    fetchRouteMap({ polylines, markers })
      .then((url) => {
        if (cancelled || !url) {
          if (url) URL.revokeObjectURL(url);
          if (!url) setFailed(true);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => setFailed(true));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [plan]);

  if (failed) return null;
  if (!src) return <p className="muted small">Rendering map…</p>;

  return (
    <figure className="route-map">
      <img src={src} alt="Map of the day's route" />
    </figure>
  );
}
