import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchFuelHistory, updateFuelEntry, deleteFuelEntry } from '../lib/api.js';
import { formatDistance, formatLongDate } from '../lib/format.js';

/**
 * Every logged run, with monthly totals, editable in place.
 *
 * `fuel_cost_calculations` has no `user_id` column, so this is the practice's
 * history rather than one operator's, and it includes the rows entered by hand
 * in the main app before the planner existed. Editing or deleting here changes
 * data that app also writes — which is why deleting asks by naming the row.
 *
 * The derived figures (litres, cost, cost per km) are recomputed by the server
 * from distance, consumption and price. Nothing here does that arithmetic.
 */

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

/** '2026-08' -> 'August 2026' */
function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(year, month - 1, 15))
  );
}

function EditRow({ entry, onCancel, onSaved, onError }) {
  const [date, setDate] = useState(entry.trim_run_date);
  const [description, setDescription] = useState(entry.description || '');
  const [distance, setDistance] = useState(String(entry.distance_traveled ?? ''));
  const [consumption, setConsumption] = useState(String(entry.fuel_consumption ?? ''));
  const [price, setPrice] = useState(String(entry.fuel_cost ?? ''));
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    onError(null);
    try {
      const updated = await updateFuelEntry(entry.id, {
        date,
        description,
        distanceKm: Number(distance),
        fuelConsumption: Number(consumption),
        fuelPrice: Number(price),
      });
      onSaved(updated);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="fuel-row editing">
      <form onSubmit={submit}>
        <div className="field-row">
          <label className="field">
            <span>Run date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Distance (km)</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
              required
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Ute uses (L/100 km)</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={consumption}
              onChange={(e) => setConsumption(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Fuel price ($/L)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </label>
        </div>

        <label className="field">
          <span>Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Where the run went"
          />
        </label>

        <div className="row-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <p className="muted small">
          Litres, cost and cost per km are worked out from these three figures when you save.
        </p>
      </form>
    </li>
  );
}

export default function FuelHistory() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchFuelHistory()
      .then((data) => {
        setEntries(data.entries);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const months = useMemo(() => {
    const grouped = new Map();
    for (const entry of entries) {
      const key = (entry.trim_run_date || '').slice(0, 7);
      const bucket = grouped.get(key) || { key, entries: [], km: 0, cost: 0 };
      bucket.entries.push(entry);
      bucket.km += Number(entry.distance_traveled) || 0;
      bucket.cost += Number(entry.trip_cost) || 0;
      grouped.set(key, bucket);
    }
    return [...grouped.values()];
  }, [entries]);

  const total = useMemo(
    () =>
      entries.reduce(
        (sum, entry) => ({
          km: sum.km + (Number(entry.distance_traveled) || 0),
          cost: sum.cost + (Number(entry.trip_cost) || 0),
        }),
        { km: 0, cost: 0 }
      ),
    [entries]
  );

  const remove = async (entry) => {
    const confirmed = window.confirm(
      `Delete the fuel entry for ${entry.trim_run_date} — ${entry.description || 'no description'}?\n\n` +
        'This removes it from the practice database, which the main Hoof Clinic app also reads.'
    );
    if (!confirmed) return;

    setBusyId(entry.id);
    setError(null);
    try {
      await deleteFuelEntry(entry.id);
      setEntries((current) => current.filter((row) => row.id !== entry.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const replace = (updated) => {
    setEntries((current) => current.map((row) => (row.id === updated.id ? updated : row)));
    setEditingId(null);
  };

  if (loading && entries.length === 0) return <p className="muted">Loading fuel history…</p>;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Fuel</h2>
          <p className="muted small">
            {entries.length} logged run{entries.length === 1 ? '' : 's'} ·{' '}
            {formatDistance(total.km * 1000)} · {money(total.cost)} all up
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {entries.length === 0 && <p className="muted">Nothing logged yet.</p>}

      {months.map((month) => (
        <div key={month.key} className="history-month">
          <h3>
            {monthLabel(month.key)}
            <span className="muted small">
              {formatDistance(month.km * 1000)} · {money(month.cost)}
            </span>
          </h3>

          <ul className="fuel-rows">
            {month.entries.map((entry) =>
              editingId === entry.id ? (
                <EditRow
                  key={entry.id}
                  entry={entry}
                  onCancel={() => setEditingId(null)}
                  onSaved={replace}
                  onError={setError}
                />
              ) : (
                <li key={entry.id} className="fuel-row">
                  <div className="fuel-row-main">
                    <strong>{formatLongDate(entry.trim_run_date)}</strong>
                    <span className="muted small">{entry.description || 'No description'}</span>
                    <span className="muted small">
                      {formatDistance((Number(entry.distance_traveled) || 0) * 1000)} ·{' '}
                      {entry.fuel_consumption} L/100 km · ${entry.fuel_cost}/L ·{' '}
                      {Number(entry.litres_consumption).toFixed(2)} L
                      {entry.appointment_ids?.length
                        ? ` · ${entry.appointment_ids.length} appointment${entry.appointment_ids.length === 1 ? '' : 's'}`
                        : ''}
                    </span>
                  </div>

                  <div className="fuel-row-cost">
                    <strong>{money(entry.trip_cost)}</strong>
                    <span className="muted small">
                      ${Number(entry.cost_per_km || 0).toFixed(2)}/km
                    </span>
                  </div>

                  <div className="row-actions">
                    <button type="button" className="link" onClick={() => setEditingId(entry.id)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="link danger-link"
                      onClick={() => remove(entry)}
                      disabled={busyId === entry.id}
                    >
                      {busyId === entry.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </li>
              )
            )}
          </ul>
        </div>
      ))}
    </section>
  );
}
