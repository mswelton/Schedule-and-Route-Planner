import { useCallback, useEffect, useMemo, useState } from 'react';
import DaySettings from './components/DaySettings.jsx';
import LocationPicker from './components/LocationPicker.jsx';
import StopList from './components/StopList.jsx';
import Itinerary from './components/Itinerary.jsx';
import { fetchLocations, fetchAppointments, planRoute } from './lib/api.js';
import { todayIso } from './lib/format.js';

const DEFAULT_ON_SITE_MINUTES = 45;
const BASE_STORAGE_KEY = 'thc-route-planner:base';

/**
 * A base saved here is an explicit *override* of the Supabase home location.
 * We never write the Supabase default into storage, otherwise changing
 * `service_locations.is_home` would have no effect on a browser that had
 * already cached it.
 */
function loadBaseOverride() {
  try {
    const raw = localStorage.getItem(BASE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [locations, setLocations] = useState([]);
  const [defaultBase, setDefaultBase] = useState(null);
  const [timezone, setTimezone] = useState('');
  const [loadError, setLoadError] = useState(null);

  const [date, setDate] = useState(todayIso);
  const [firstAppointmentTime, setFirstAppointmentTime] = useState('09:00');
  const [base, setBase] = useState(
    () => loadBaseOverride() || { name: 'Base', address: '', lat: null, lng: null }
  );
  const [stops, setStops] = useState([]);

  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    fetchLocations()
      .then((data) => {
        setLocations(data.locations);
        setDefaultBase(data.defaultBase);
        setTimezone(data.timezone);
        // Only adopt the Supabase default when there is no local override.
        if (!loadBaseOverride() && data.defaultBase) setBase(data.defaultBase);
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  /**
   * Persist only genuine overrides; picking "reset to default" clears the
   * stored value so the Supabase home location takes over again.
   */
  const changeBase = useCallback(
    (next) => {
      setBase(next);
      const isDefault = defaultBase && next.address === defaultBase.address;
      if (isDefault || !next.address) localStorage.removeItem(BASE_STORAGE_KEY);
      else localStorage.setItem(BASE_STORAGE_KEY, JSON.stringify(next));
    },
    [defaultBase]
  );

  const locationsById = useMemo(() => new Map(locations.map((loc) => [loc.id, loc])), [locations]);
  const selectedIds = useMemo(() => stops.map((s) => s.locationId), [stops]);

  const addStop = useCallback((locationId) => {
    setStops((current) =>
      current.some((s) => s.locationId === locationId)
        ? current
        : [...current, { locationId, onSiteMinutes: DEFAULT_ON_SITE_MINUTES }]
    );
  }, []);

  const removeStop = useCallback((index) => {
    setStops((current) => current.filter((_, i) => i !== index));
  }, []);

  const reorderStops = useCallback((from, to) => {
    setStops((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const setStopMinutes = useCallback((index, value) => {
    setStops((current) =>
      current.map((stop, i) =>
        i === index ? { ...stop, onSiteMinutes: Math.max(0, Number(value) || 0) } : stop
      )
    );
  }, []);

  const loadFromAppointments = useCallback(async () => {
    setNotice(null);
    setPlanError(null);
    try {
      const data = await fetchAppointments(date);
      if (!data.stops.length) {
        setNotice(`No appointments booked for ${date}.`);
        return;
      }
      setStops(
        data.stops.map((s) => ({
          locationId: s.locationId,
          onSiteMinutes: s.onSiteMinutes || DEFAULT_ON_SITE_MINUTES,
        }))
      );
      const earliest = data.stops.find((s) => s.earliestTime)?.earliestTime;
      if (earliest) setFirstAppointmentTime(earliest.slice(0, 5));
      setNotice(
        `Loaded ${data.stops.length} location${data.stops.length === 1 ? '' : 's'} from the day's appointments — check the order.`
      );
    } catch (err) {
      setPlanError(err.message);
    }
  }, [date]);

  const handlePlan = useCallback(async () => {
    setPlanning(true);
    setPlanError(null);
    setNotice(null);
    try {
      const result = await planRoute({ date, firstAppointmentTime, base, stops });
      setPlan(result);
    } catch (err) {
      setPlanError(err.message);
      setPlan(null);
    } finally {
      setPlanning(false);
    }
  }, [date, firstAppointmentTime, base, stops]);

  const hasBase = Boolean(base.address) || (Number.isFinite(base.lat) && Number.isFinite(base.lng));
  const canPlan = stops.length > 0 && hasBase && !planning;

  return (
    <div className="app">
      <header className="app-header no-print">
        <img src="/thc-logo.svg" alt="The Hoof Clinic" className="logo" />
        <div>
          <h1>Route Planner</h1>
          <p className="muted small">Turn a day's stops into a timed itinerary.</p>
        </div>
      </header>

      {loadError && (
        <p className="error">
          Could not load locations: {loadError}
          <br />
          <span className="small">
            Check <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> are set on the
            server.
          </span>
        </p>
      )}

      <div className="layout no-print">
        <div className="column">
          <DaySettings
            date={date}
            onDateChange={setDate}
            firstAppointmentTime={firstAppointmentTime}
            onFirstAppointmentTimeChange={setFirstAppointmentTime}
            base={base}
            onBaseChange={changeBase}
            defaultBase={defaultBase}
            timezone={timezone}
          />

          <LocationPicker
            locations={locations}
            selectedIds={selectedIds}
            onAdd={addStop}
            onLoadAppointments={loadFromAppointments}
            busy={planning}
          />
        </div>

        <div className="column">
          <section className="panel">
            <div className="panel-head">
              <h2>3. Visit order</h2>
              {stops.length > 0 && (
                <button type="button" className="link" onClick={() => setStops([])}>
                  Clear all
                </button>
              )}
            </div>

            <StopList
              stops={stops}
              locationsById={locationsById}
              onReorder={reorderStops}
              onRemove={removeStop}
              onMinutesChange={setStopMinutes}
            />

            <button type="button" className="primary plan-button" onClick={handlePlan} disabled={!canPlan}>
              {planning ? 'Working out the run…' : 'Work out my day'}
            </button>

            {notice && <p className="notice">{notice}</p>}
            {planError && <p className="error">{planError}</p>}
          </section>
        </div>
      </div>

      <Itinerary plan={plan} />
    </div>
  );
}
