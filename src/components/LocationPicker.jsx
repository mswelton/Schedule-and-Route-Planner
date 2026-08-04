import { useMemo, useState } from 'react';

/**
 * Search and click locations to add them to the day. Clicking adds to the end
 * of the list, so clicking in visit order is enough — reordering afterwards is
 * available in the stop list.
 */
export default function LocationPicker({ locations, selectedIds, onAdd, onLoadAppointments, busy }) {
  const [term, setTerm] = useState('');

  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return locations.filter((loc) => {
      if (selectedIds.includes(loc.id)) return false;
      if (!needle) return true;
      return [loc.name, loc.yard, loc.clientName, loc.townCity, loc.address]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [locations, selectedIds, term]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>2. Stops</h2>
        {onLoadAppointments && (
          <button type="button" className="secondary" onClick={onLoadAppointments} disabled={busy}>
            Load from appointments
          </button>
        )}
      </div>

      <input
        type="search"
        className="search"
        placeholder="Search locations, clients or towns…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />

      <ul className="picker-list">
        {matches.length === 0 && (
          <li className="muted small picker-empty">
            {locations.length === 0 ? 'No locations loaded.' : 'Nothing else matches.'}
          </li>
        )}
        {matches.map((loc) => (
          <li key={loc.id}>
            <button type="button" className="picker-item" onClick={() => onAdd(loc.id)}>
              <span className="picker-name">
                {loc.name}
                {!loc.hasCoords && (
                  <span className="chip chip-warn" title="No stored coordinates — will be geocoded">
                    no lat/lng
                  </span>
                )}
              </span>
              <span className="muted small">
                {[loc.clientName, loc.townCity].filter(Boolean).join(' · ') || loc.address}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
