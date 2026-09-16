import { useEffect, useMemo, useState } from 'react';
import { fetchFuelDefaults, logFuelCost } from '../lib/api.js';
import { formatDistance } from '../lib/format.js';

/**
 * What the run cost in fuel, and a button to record it.
 *
 * The distance is the one the planner just worked out, so the only numbers
 * needing a human are the ute's consumption and what fuel cost that week —
 * both prefilled from the last run logged.
 *
 * The cost is shown whether or not it is saved: knowing a 231 km day burns
 * $47 is useful on its own.
 */
export default function FuelLog({ plan, routePlanId }) {
  const [consumption, setConsumption] = useState('');
  const [price, setPrice] = useState('');
  const [defaultsFrom, setDefaultsFrom] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchFuelDefaults()
      .then((data) => {
        if (cancelled) return;
        if (data.fuelConsumption) setConsumption(String(data.fuelConsumption));
        if (data.fuelPrice) setPrice(String(data.fuelPrice));
        setDefaultsFrom(data.fromRunDate);
      })
      .catch(() => {
        // Not being able to prefill is not worth an error on the page — the
        // two fields are still typeable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A re-planned day is a different run, so it has not been logged yet.
  useEffect(() => {
    setSaved(null);
    setError(null);
  }, [plan]);

  const distanceKm = (plan.totals.distanceMeters || 0) / 1000;

  const estimate = useMemo(() => {
    const c = Number(consumption);
    const p = Number(price);
    if (!Number.isFinite(c) || !Number.isFinite(p) || c <= 0 || p <= 0) return null;
    const litres = (distanceKm * c) / 100;
    return { litres, cost: litres * p, perKm: (litres * p) / distanceKm };
  }, [consumption, price, distanceKm]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await logFuelCost({
        date: plan.date,
        distanceKm,
        fuelConsumption: Number(consumption),
        fuelPrice: Number(price),
        locationIds: plan.stops.map((stop) => stop.id),
        routePlanId: routePlanId || null,
      });
      setSaved(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="fuel-log no-print">
      <h3>Fuel for this run</h3>

      <div className="field-row">
        <label className="field">
          <span>Ute uses</span>
          <div className="suffixed">
            <input
              type="number"
              min="0"
              step="0.1"
              value={consumption}
              onChange={(e) => setConsumption(e.target.value)}
            />
            <span className="muted small">L/100 km</span>
          </div>
        </label>

        <label className="field">
          <span>Fuel price</span>
          <div className="suffixed">
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <span className="muted small">$/L</span>
          </div>
        </label>
      </div>

      {defaultsFrom && (
        <p className="muted small">Prefilled from the run logged on {defaultsFrom}.</p>
      )}

      {!routePlanId && (
        <p className="muted small">Save this run first to link its fuel cost to it for job costing.</p>
      )}

      {estimate ? (
        <p className="fuel-estimate">
          <strong>${estimate.cost.toFixed(2)}</strong> over {formatDistance(plan.totals.distanceMeters)} —{' '}
          {estimate.litres.toFixed(2)} L at ${estimate.perKm.toFixed(2)}/km
        </p>
      ) : (
        <p className="muted small">Fill both figures in to see what the run costs.</p>
      )}

      {saved ? (
        <p className="notice">
          Logged: {saved.description}
          {saved.appointment_ids?.length
            ? ` — linked to ${saved.appointment_ids.length} appointment${saved.appointment_ids.length === 1 ? '' : 's'}.`
            : '.'}
        </p>
      ) : (
        <button type="button" className="secondary" onClick={save} disabled={!estimate || saving}>
          {saving ? 'Saving…' : 'Log this run'}
        </button>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}
