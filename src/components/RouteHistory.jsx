import { useCallback, useEffect, useState } from 'react';
import { fetchSavedRuns, fetchSavedRun, deleteSavedRun } from '../lib/api.js';
import { formatDistance, formatDuration, formatLongDate } from '../lib/format.js';

/**
 * Saved runs, with the totals and the actions the planning page's compact
 * list has no room for. Opening one hands it back to the planner, which shows
 * the stored itinerary and puts the day back in the editor.
 */
export default function RouteHistory({ onOpen }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

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

  useEffect(load, [load]);

  const open = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      const saved = await fetchSavedRun(id);
      onOpen(saved.plan, id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (run) => {
    const confirmed = window.confirm(
      `Delete the saved run for ${formatLongDate(run.run_date)}?\n\n` +
        `${run.stop_count} stop${run.stop_count === 1 ? '' : 's'}, ${formatDistance(run.total_distance_m)}.`
    );
    if (!confirmed) return;

    setBusyId(run.id);
    setError(null);
    try {
      await deleteSavedRun(run.id);
      setRuns((current) => current.filter((row) => row.id !== run.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading && runs.length === 0 && !error) return <p className="muted">Loading saved runs…</p>;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Saved runs</h2>
          <p className="muted small">
            {runs.length} saved. Opening one shows it as it was worked out — no fresh routing
            calls.
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {runs.length === 0 && !error && (
        <p className="muted">
          Nothing saved yet. Work out a day and press <strong>Save this run</strong>.
        </p>
      )}

      <ul className="fuel-rows">
        {runs.map((run) => (
          <li key={run.id} className="fuel-row">
            <div className="fuel-row-main">
              <strong>{formatLongDate(run.run_date)}</strong>
              <span className="muted small">
                {run.stop_count} stop{run.stop_count === 1 ? '' : 's'} from {run.base_label || 'base'}
              </span>
              <span className="muted small">
                {run.leave_base_clock}–{run.return_to_base_clock} ·{' '}
                {formatDuration(run.day_length_seconds)} day ·{' '}
                {formatDuration(run.total_driving_seconds)} driving
              </span>
            </div>

            <div className="fuel-row-cost">
              <strong>{formatDistance(run.total_distance_m)}</strong>
              <span className="muted small">{run.total_on_site_minutes} min on site</span>
            </div>

            <div className="row-actions">
              <button
                type="button"
                className="link"
                onClick={() => open(run.id)}
                disabled={busyId === run.id}
              >
                {busyId === run.id ? 'Opening…' : 'Open'}
              </button>
              <button
                type="button"
                className="link danger-link"
                onClick={() => remove(run)}
                disabled={busyId === run.id}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
