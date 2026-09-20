import { useCallback, useEffect, useState } from 'react';
import { fetchSavedRuns, fetchSavedRun } from '../lib/api.js';
import { formatDistance, formatDuration, formatLongDate } from '../lib/format.js';

/**
 * Runs saved previously. Opening one restores the itinerary *and* the day that
 * produced it, so a run can be looked at, adjusted and re-planned rather than
 * only read.
 *
 * Reopening costs no Routes API calls — the stored itinerary is rendered as it
 * was saved.
 */
export default function SavedRuns({ refreshToken, onOpen }) {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchSavedRuns()
      .then((data) => {
        setRuns(data.plans);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // `refreshToken` changes when a run is saved, which is the only thing that
  // can add to this list.
  useEffect(load, [load, refreshToken]);

  const open = async (id) => {
    setOpeningId(id);
    setError(null);
    try {
      const saved = await fetchSavedRun(id);
      // The id matters: without it App's `openRunId` stays null and the next
      // save adds a second row for the same day instead of replacing this one.
      onOpen(saved.plan, id);
    } catch (err) {
      setError(err.message);
    } finally {
      setOpeningId(null);
    }
  };

  if (loading && runs.length === 0 && !error) return null;
  if (error && runs.length === 0) {
    return (
      <section className="panel">
        <h2>Saved runs</h2>
        <p className="muted small">{error}</p>
      </section>
    );
  }
  if (runs.length === 0) return null;

  return (
    <section className="panel">
      <h2>Saved runs</h2>
      <ul className="saved-runs">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className="saved-run"
              onClick={() => open(run.id)}
              disabled={openingId === run.id}
            >
              <span className="saved-run-date">{formatLongDate(run.run_date)}</span>
              <span className="muted small">
                {run.stop_count} stop{run.stop_count === 1 ? '' : 's'} ·{' '}
                {formatDistance(run.total_distance_m)} · {run.leave_base_clock}–
                {run.return_to_base_clock} · {formatDuration(run.day_length_seconds)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
