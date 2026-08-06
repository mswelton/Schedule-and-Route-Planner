import { formatDistance, formatDuration, formatMinutes, formatLongDate } from '../lib/format.js';
import { googleMapsStopUrl, appleMapsStopUrl, googleMapsDayUrl } from '../lib/navigation.js';
import RouteMap from './RouteMap.jsx';
import FuelLog from './FuelLog.jsx';

function Leg({ leg }) {
  if (!leg) return null;
  const congestion = leg.staticSeconds ? leg.seconds - leg.staticSeconds : 0;
  return (
    <div className="leg">
      <span className="leg-arrow" aria-hidden="true">
        ↓
      </span>
      <span className="leg-detail">
        Drive {formatDuration(leg.seconds)} · {formatDistance(leg.meters)}
        {leg.trafficAware && congestion >= 120 && (
          <span className="muted"> (incl. ~{formatDuration(congestion)} traffic)</span>
        )}
        {!leg.trafficAware && <span className="muted"> (no traffic estimate)</span>}
      </span>
      {(leg.warnings || []).map((warning) => (
        <span key={warning} className="warning">
          ⚠ {warning}
        </span>
      ))}
    </div>
  );
}

/** Map links for one stop. Hidden in print — paper cannot be tapped. */
function Navigate({ stop }) {
  const google = googleMapsStopUrl(stop);
  const apple = appleMapsStopUrl(stop);
  if (!google) return null;

  return (
    <span className="navigate no-print">
      <a href={google} target="_blank" rel="noreferrer">
        Navigate
      </a>
      <a href={apple} target="_blank" rel="noreferrer" className="muted">
        Apple Maps
      </a>
    </span>
  );
}

export default function Itinerary({ plan, onSave, saving, savedAt, updating }) {
  if (!plan) return null;

  const { totals } = plan;
  const day = googleMapsDayUrl(plan.base, plan.stops);

  return (
    <section className="panel itinerary">
      <div className="panel-head">
        <div>
          <h2>Itinerary</h2>
          <p className="muted small">{formatLongDate(plan.date)}</p>
        </div>
        <div className="itinerary-actions no-print">
          {day && (
            <a className="button secondary" href={day.url} target="_blank" rel="noreferrer">
              Open the day in Google Maps
            </a>
          )}
          {onSave && (
            <button
              type="button"
              className="secondary"
              onClick={() => onSave(false)}
              disabled={saving || Boolean(savedAt)}
            >
              {saving
                ? 'Saving…'
                : savedAt
                  ? 'Saved'
                  : updating
                    ? 'Update saved run'
                    : 'Save this run'}
            </button>
          )}
          {/* Only offered when replacing would otherwise be the default, for
              the day where a second version is genuinely wanted. */}
          {onSave && updating && !savedAt && (
            <button type="button" className="secondary" onClick={() => onSave(true)} disabled={saving}>
              Save as a new run
            </button>
          )}
          <button type="button" className="secondary" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>

      {day?.dropped > 0 && (
        <p className="notice no-print">
          Google Maps takes nine stops in one route, so the last {day.dropped} on this run{' '}
          {day.dropped === 1 ? 'is' : 'are'} not in that link — use the per-stop links below for
          {day.dropped === 1 ? ' it' : ' them'}.
        </p>
      )}

      <div className="summary">
        <div>
          <span className="summary-label">Leave base</span>
          <strong className="summary-value accent">{plan.leaveBase.clock}</strong>
        </div>
        <div>
          <span className="summary-label">Back at base</span>
          <strong className="summary-value">
            {plan.returnToBase.clock}
            {plan.returnToBase.nextDay && <span className="chip chip-warn">next day</span>}
          </strong>
        </div>
        <div>
          <span className="summary-label">Driving</span>
          <strong className="summary-value">{formatDuration(totals.drivingSeconds)}</strong>
          <span className="muted small">{formatDistance(totals.distanceMeters)}</span>
        </div>
        <div>
          <span className="summary-label">On site</span>
          <strong className="summary-value">{formatMinutes(totals.onSiteMinutes)}</strong>
        </div>
        {totals.waitingSeconds > 0 && (
          <div>
            <span className="summary-label">Waiting</span>
            <strong className="summary-value">{formatDuration(totals.waitingSeconds)}</strong>
            <span className="muted small">early for booked times</span>
          </div>
        )}
        <div>
          <span className="summary-label">Full day</span>
          <strong className="summary-value">{formatDuration(totals.dayLengthSeconds)}</strong>
        </div>
      </div>

      {plan.lateStops?.length > 0 && (
        <p className="error">
          This run does not make {plan.lateStops.length === 1 ? 'a booked time' : 'its booked times'}:{' '}
          {plan.lateStops
            .map((s) => `${s.label} is ${formatDuration(s.lateSeconds)} late`)
            .join(', ')}
          . Move a stop, trim time on site, or start earlier.
        </p>
      )}

      {plan.geocodedFallbacks?.length > 0 && (
        <p className="notice">
          Geocoded from the address (no stored coordinates):{' '}
          {plan.geocodedFallbacks.join(', ')}.
        </p>
      )}

      <ol className="timeline">
        <li className="timeline-node base">
          <div className="node-time">{plan.leaveBase.clock}</div>
          <div className="node-body">
            <strong>Leave {plan.base.label}</strong>
            <span className="muted small">{plan.base.address}</span>
            <Leg leg={plan.legToFirstStop} />
          </div>
        </li>

        {plan.stops.map((stop, index) => (
          <li className="timeline-node" key={`${stop.id}-${index}`}>
            <div className="node-time">
              {stop.arrivalClock}
              <span className="node-time-sub">→ {stop.departureClock}</span>
            </div>
            <div className="node-body">
              <strong>
                <span className="stop-index small-index">{index + 1}</span> {stop.label}
              </strong>
              <span className="muted small">{stop.address}</span>
              {stop.bookedForClock && (
                <span className={stop.lateSeconds > 0 ? 'booked-late' : 'booked-for'}>
                  Booked {stop.bookedForClock}
                  {stop.lateSeconds > 0 && ` — arriving ${formatDuration(stop.lateSeconds)} late`}
                  {stop.waitSeconds > 0 && ` — ${formatDuration(stop.waitSeconds)} wait on arrival`}
                </span>
              )}
              <span className="on-site">On site {formatMinutes(stop.onSiteMinutes)}</span>
              {stop.accessNotes && <span className="access-note">Access: {stop.accessNotes}</span>}
              <Navigate stop={stop} />
              <Leg leg={stop.legToNext} />
            </div>
          </li>
        ))}

        <li className="timeline-node base">
          <div className="node-time">{plan.returnToBase.clock}</div>
          <div className="node-body">
            <strong>Back at {plan.base.label}</strong>
            <span className="muted small">{plan.base.address}</span>
          </div>
        </li>
      </ol>

      {plan.warnings.length > 0 && (
        <div className="warning-block">
          <h3>Routing warnings</h3>
          <ul>
            {plan.warnings.map((warning, i) => (
              <li key={i}>
                <strong>
                  {warning.from} → {warning.to}:
                </strong>{' '}
                {warning.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <RouteMap plan={plan} />
      <FuelLog plan={plan} />
    </section>
  );
}
