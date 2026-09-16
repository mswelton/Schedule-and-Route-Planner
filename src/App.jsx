import { useCallback, useEffect, useMemo, useState } from 'react';
import DaySettings from './components/DaySettings.jsx';
import LocationPicker from './components/LocationPicker.jsx';
import StopList from './components/StopList.jsx';
import OptimiseOrder from './components/OptimiseOrder.jsx';
import SavedRuns from './components/SavedRuns.jsx';
import Itinerary from './components/Itinerary.jsx';
import SignIn from './components/SignIn.jsx';
import History from './components/History.jsx';
import {
  fetchLocations,
  fetchAppointments,
  planRoute,
  saveRun,
  updateSavedRun,
} from './lib/api.js';
import { supabaseClient, signOut } from './lib/auth.js';
import { todayIso } from './lib/format.js';

const DEFAULT_ON_SITE_MINUTES = 45;
const BASE_STORAGE_KEY = 'thc-route-planner:base';

/**
 * Two screens is not a router's worth of problem. The hash gives us the back
 * button and a linkable URL for nothing.
 */
function useHashView() {
  const [view, setView] = useState(() =>
    window.location.hash === '#/history' ? 'history' : 'planner'
  );

  useEffect(() => {
    const onChange = () =>
      setView(window.location.hash === '#/history' ? 'history' : 'planner');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const go = useCallback((next) => {
    window.location.hash = next === 'history' ? '#/history' : '';
  }, []);

  return [view, go];
}

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
  // `undefined` while we are still working out whether there is a session;
  // `null` once we know there isn't one. The three states are distinct so the
  // sign-in form doesn't flash up on every reload before the session loads.
  const [session, setSession] = useState(undefined);
  const [configError, setConfigError] = useState(null);

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

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  // Bumped after a save so the saved-runs list reloads.
  const [savedRunsToken, setSavedRunsToken] = useState(0);
  // The saved run currently open, if any. Re-planning updates *that* row
  // rather than adding a near-duplicate of the same day.
  const [openRunId, setOpenRunId] = useState(null);

  const [view, goToView] = useHashView();

  useEffect(() => {
    let subscription = null;
    let cancelled = false;

    supabaseClient()
      .then(async (supabase) => {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        setSession(data.session ?? null);
        subscription = supabase.auth.onAuthStateChange((_event, next) => {
          setSession(next ?? null);
        }).data.subscription;
      })
      .catch((err) => {
        if (cancelled) return;
        setConfigError(err.message);
        setSession(null);
      });

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, []);

  // Locations are practice data, so this waits for a session rather than
  // firing on mount and failing with a 401.
  useEffect(() => {
    if (!session) return;
    fetchLocations()
      .then((data) => {
        setLocations(data.locations);
        setDefaultBase(data.defaultBase);
        setTimezone(data.timezone);
        // Only adopt the Supabase default when there is no local override.
        if (!loadBaseOverride() && data.defaultBase) setBase(data.defaultBase);
      })
      .catch((err) => setLoadError(err.message));
  }, [session]);

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
        : [
            ...current,
            {
              locationId,
              onSiteMinutes: DEFAULT_ON_SITE_MINUTES,
              scheduledTime: null,
              // Added by hand, not from the day's appointments - nothing to tie
              // a job-costing job to.
              appointmentIds: [],
            },
          ]
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

  /**
   * Reorder the list to match a suggested order, keeping each stop's own
   * settings. Anything the suggestion doesn't mention stays on the end rather
   * than being dropped.
   */
  const applyOrder = useCallback((locationIds) => {
    setStops((current) => {
      const byId = new Map(current.map((stop) => [stop.locationId, stop]));
      const reordered = locationIds.map((id) => byId.get(id)).filter(Boolean);
      const untouched = current.filter((stop) => !locationIds.includes(stop.locationId));
      return [...reordered, ...untouched];
    });
  }, []);

  const setStopScheduledTime = useCallback((index, value) => {
    setStops((current) =>
      current.map((stop, i) => (i === index ? { ...stop, scheduledTime: value || null } : stop))
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
      // Each location's booked time is carried through, not just the first
      // one's — that is what stops the itinerary printing an arrival the
      // client was never told about.
      setStops(
        data.stops.map((s) => ({
          locationId: s.locationId,
          onSiteMinutes: s.onSiteMinutes || DEFAULT_ON_SITE_MINUTES,
          scheduledTime: s.earliestTime ? s.earliestTime.slice(0, 5) : null,
          appointmentIds: s.appointmentIds || [],
        }))
      );
      const earliest = data.stops.find((s) => s.earliestTime)?.earliestTime;
      if (earliest) setFirstAppointmentTime(earliest.slice(0, 5));
      const booked = data.stops.filter((s) => s.earliestTime).length;
      setNotice(
        `Loaded ${data.stops.length} location${data.stops.length === 1 ? '' : 's'} from the day's appointments` +
          `${booked ? `, ${booked} with a booked time` : ''} — check the order.`
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
      // A freshly worked-out run has not been saved, even if the previous one
      // was. `openRunId` deliberately survives, so this becomes an update of
      // the run being adjusted rather than a second row for the same day.
      setSavedAt(null);
    } catch (err) {
      setPlanError(err.message);
      setPlan(null);
    } finally {
      setPlanning(false);
    }
  }, [date, firstAppointmentTime, base, stops]);

  /**
   * Save the current plan. When a saved run is open this replaces it, so
   * adjusting and re-planning a day does not leave two rows for it.
   * `asNew` forces a fresh row for the case where a variant is wanted.
   */
  const handleSave = useCallback(
    async (asNew = false) => {
      if (!plan) return;
      setSaving(true);
      setPlanError(null);
      try {
        if (openRunId && !asNew) {
          await updateSavedRun(openRunId, plan);
        } else {
          const created = await saveRun(plan);
          setOpenRunId(created.id);
        }
        setSavedAt(Date.now());
        setSavedRunsToken((n) => n + 1);
      } catch (err) {
        setPlanError(err.message);
      } finally {
        setSaving(false);
      }
    },
    [plan, openRunId]
  );

  /**
   * Reopen a saved run: show the stored itinerary, and put the day that
   * produced it back in the editor so it can be adjusted and re-planned.
   */
  const openSavedRun = useCallback(
    (saved, savedId = null) => {
      setPlan(saved);
      setOpenRunId(savedId);
      setSavedAt(Date.now()); // it is, by definition, already saved
      setNotice(null);
      setPlanError(null);
      setDate(saved.date);
      if (saved.stops[0]?.arrivalClock) setFirstAppointmentTime(saved.stops[0].arrivalClock);
      setStops(
        saved.stops.map((stop) => ({
          locationId: stop.id,
          onSiteMinutes: stop.onSiteMinutes,
          scheduledTime: stop.bookedForClock || null,
          appointmentIds: stop.appointmentIds || [],
        }))
      );
      if (saved.base?.address) {
        changeBase({
          name: saved.base.label || 'Base',
          address: saved.base.address,
          lat: saved.base.lat ?? null,
          lng: saved.base.lng ?? null,
        });
      }
    },
    [changeBase]
  );

  const hasBase = Boolean(base.address) || (Number.isFinite(base.lat) && Number.isFinite(base.lng));
  const canPlan = stops.length > 0 && hasBase && !planning;

  if (session === undefined) return <p className="app muted">Loading…</p>;
  if (!session) return <SignIn configError={configError} />;

  if (view === 'history') {
    return (
      <History
        onBack={() => goToView('planner')}
        onOpenRun={(saved, id) => {
          openSavedRun(saved, id);
          goToView('planner');
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header no-print">
        <img src="/thc-logo.svg" alt="The Hoof Clinic" className="logo" />
        <div>
          <h1>Route Planner</h1>
          <p className="muted small">Turn a day's stops into a timed itinerary.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="link" onClick={() => goToView('history')}>
            History
          </button>
          <button type="button" className="link" onClick={signOut}>
            Sign out
          </button>
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

          <SavedRuns refreshToken={savedRunsToken} onOpen={openSavedRun} />
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
              onScheduledTimeChange={setStopScheduledTime}
            />

            <OptimiseOrder
              base={base}
              stops={stops}
              onApply={applyOrder}
              disabled={planning || !hasBase}
            />

            <button type="button" className="primary plan-button" onClick={handlePlan} disabled={!canPlan}>
              {planning ? 'Working out the run…' : 'Work out my day'}
            </button>

            {notice && <p className="notice">{notice}</p>}
            {planError && <p className="error">{planError}</p>}
          </section>
        </div>
      </div>

      <Itinerary
        plan={plan}
        onSave={handleSave}
        saving={saving}
        savedAt={savedAt}
        updating={Boolean(openRunId)}
        // Only the run actually saved under this id, not one mid-edit: after a
        // re-plan `openRunId` survives (so Save updates the same row) but
        // `savedAt` resets to null, meaning the on-screen itinerary no longer
        // matches what route_plan_stops holds for that id until it is saved
        // again. Logging fuel against a stale id would link it to stops that
        // are no longer this run.
        routePlanId={savedAt ? openRunId : null}
      />
    </div>
  );
}
