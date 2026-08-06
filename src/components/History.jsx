import RouteHistory from './RouteHistory.jsx';
import FuelHistory from './FuelHistory.jsx';

/**
 * The reviewing screen: what has been planned, and what it cost.
 *
 * Kept off the planning page deliberately — that page is already five panels
 * deep on one column, and reviewing is a different job from planning.
 */
export default function History({ onOpenRun, onBack }) {
  return (
    <div className="app">
      <header className="app-header no-print">
        <img src="/thc-logo.svg" alt="The Hoof Clinic" className="logo" />
        <div>
          <h1>History</h1>
          <p className="muted small">Runs you have planned, and what they cost in fuel.</p>
        </div>
        <button type="button" className="link sign-out" onClick={onBack}>
          Back to planning
        </button>
      </header>

      <div className="history-layout">
        <RouteHistory onOpen={onOpenRun} />
        <FuelHistory />
      </div>
    </div>
  );
}
