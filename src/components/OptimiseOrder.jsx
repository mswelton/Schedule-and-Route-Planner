import { useState } from 'react';
import { optimiseOrder } from '../lib/api.js';
import { formatDistance, formatDuration } from '../lib/format.js';

/**
 * Suggests a better visit order. Off by default and never automatic — which
 * property to visit first sometimes has reasons that are not on the map.
 *
 * Unavailable once any stop carries a booked time: reordering those would
 * break the times clients have already been given, and the useful moment for
 * this is *before* the day is booked, when Mark is deciding what order to
 * offer.
 */
export default function OptimiseOrder({ base, stops, onApply, disabled }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const booked = stops.filter((stop) => stop.scheduledTime).length;
  const tooFew = stops.length < 3;

  const compare = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await optimiseOrder({ base, stops: stops.map((s) => ({ locationId: s.locationId })) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (tooFew) return null;

  if (booked > 0) {
    return (
      <p className="muted small optimise-note">
        {booked === 1 ? 'One stop has' : `${booked} stops have`} a booked time, so the order is
        fixed. Clear {booked === 1 ? 'it' : 'them'} to compare a different order.
      </p>
    );
  }

  return (
    <div className="optimise">
      <button type="button" className="secondary" onClick={compare} disabled={busy || disabled}>
        {busy ? 'Comparing…' : 'Try a better order'}
      </button>

      {result && result.unchanged && (
        <p className="notice">
          This is already the shortest order — {formatDistance(result.current.meters)} of driving.
        </p>
      )}

      {result && !result.unchanged && (
        <div className="optimise-result">
          <p>
            A different order saves <strong>{formatDistance(result.saving.meters)}</strong> and{' '}
            <strong>{formatDuration(result.saving.seconds)}</strong> of driving —{' '}
            {formatDistance(result.optimised.meters)} instead of{' '}
            {formatDistance(result.current.meters)}.
          </p>
          <ol className="optimise-order">
            {result.order.map((stop) => (
              <li key={stop.locationId}>{stop.label}</li>
            ))}
          </ol>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              onApply(result.order.map((stop) => stop.locationId));
              setResult(null);
            }}
          >
            Use this order
          </button>
          <p className="muted small">
            Applying it only reorders the list — press “Work out my day” to time the run.
          </p>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
