import { formatDistance, formatDuration, formatMinutes, formatLongDate } from '../lib/format.js';
import RouteMap from './RouteMap.jsx';

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

export default function Itinerary({ plan }) {
  if (!plan) return null;

  const { totals } = plan;

  return (
    <section className="panel itinerary">
      <div className="panel-head">
        <div>
          <h2>Itinerary</h2>
          <p className="muted small">{formatLongDate(plan.date)}</p>
        </div>
        <button type="button" className="secondary no-print" onClick={() => window.print()}>
          Print
        </button>
      </div>

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
        <div>
          <span className="summary-label">Full day</span>
          <strong className="summary-value">{formatDuration(totals.dayLengthSeconds)}</strong>
        </div>
      </div>

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
              <span className="on-site">On site {formatMinutes(stop.onSiteMinutes)}</span>
              {stop.accessNotes && <span className="access-note">Access: {stop.accessNotes}</span>}
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
    </section>
  );
}
