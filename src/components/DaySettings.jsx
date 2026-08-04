import { formatLongDate } from '../lib/format.js';

/**
 * Run date, first appointment time and the base address.
 *
 * The base defaults to the `service_locations` row flagged `is_home`; editing it
 * here overrides that for this browser only (kept in localStorage), so nothing
 * about the run is hardcoded and nothing writes back to the practice data.
 */
export default function DaySettings({
  date,
  onDateChange,
  firstAppointmentTime,
  onFirstAppointmentTimeChange,
  base,
  onBaseChange,
  defaultBase,
  timezone,
}) {
  const overridden = defaultBase && base.address !== defaultBase.address;

  return (
    <section className="panel">
      <h2>1. The day</h2>

      <div className="field-row">
        <label className="field">
          <span>Run date</span>
          <input type="date" value={date} onChange={(e) => onDateChange(e.target.value)} />
        </label>

        <label className="field">
          <span>First appointment</span>
          <input
            type="time"
            value={firstAppointmentTime}
            onChange={(e) => onFirstAppointmentTimeChange(e.target.value)}
          />
        </label>
      </div>

      {date && <p className="muted">{formatLongDate(date)}</p>}

      <label className="field">
        <span>Base — start and finish</span>
        <input
          type="text"
          value={base.address}
          placeholder="e.g. 205 Bass Rd, Bass, VIC 3991"
          onChange={(e) =>
            // A typed address loses the stored coordinates, so clear them and
            // let the Routes API geocode the string instead.
            onBaseChange({ name: base.name || 'Base', address: e.target.value, lat: null, lng: null })
          }
        />
      </label>

      <p className="muted small">
        {defaultBase ? (
          <>
            Default base: <strong>{defaultBase.name}</strong> — from{' '}
            <code>{defaultBase.source}</code>.
            {overridden && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => onBaseChange(defaultBase)}>
                  Reset to default
                </button>
              </>
            )}
          </>
        ) : (
          <>
            No home location found in Supabase (no <code>service_locations.is_home</code> row and no{' '}
            <code>BASE_ADDRESS</code> set) — type one above.
          </>
        )}
      </p>

      <p className="muted small">Times are {timezone || 'local'}.</p>
    </section>
  );
}
