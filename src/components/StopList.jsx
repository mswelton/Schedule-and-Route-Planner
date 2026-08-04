import { useState } from 'react';

/**
 * The ordered stop list: drag to reorder, with up/down buttons as the
 * keyboard- and touch-friendly equivalent.
 */
export default function StopList({ stops, locationsById, onReorder, onRemove, onMinutesChange }) {
  const [draggingIndex, setDraggingIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  if (stops.length === 0) {
    return <p className="muted empty-note">No stops yet — add them from the list above.</p>;
  }

  const move = (from, to) => {
    if (to < 0 || to >= stops.length || from === to) return;
    onReorder(from, to);
  };

  return (
    <ol className="stop-list">
      {stops.map((stop, index) => {
        const loc = locationsById.get(stop.locationId);
        return (
          <li
            key={stop.locationId}
            draggable
            onDragStart={() => setDraggingIndex(index)}
            onDragEnd={() => {
              setDraggingIndex(null);
              setOverIndex(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggingIndex !== null) move(draggingIndex, index);
              setDraggingIndex(null);
              setOverIndex(null);
            }}
            className={[
              'stop-row',
              draggingIndex === index ? 'dragging' : '',
              overIndex === index && draggingIndex !== index ? 'drop-target' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="stop-index" aria-hidden="true">
              {index + 1}
            </span>

            <div className="stop-body">
              <strong>{loc?.name || stop.locationId}</strong>
              <span className="muted small">
                {[loc?.clientName, loc?.address].filter(Boolean).join(' · ')}
              </span>
              {loc?.accessNotes && <span className="access-note">Access: {loc.accessNotes}</span>}
            </div>

            <label className="stop-minutes">
              <span className="muted small">On site</span>
              <input
                type="number"
                min="0"
                step="5"
                value={stop.onSiteMinutes}
                onChange={(e) => onMinutesChange(index, e.target.value)}
              />
              <span className="muted small">min</span>
            </label>

            <div className="stop-actions">
              <button type="button" aria-label="Move up" onClick={() => move(index, index - 1)}>
                ↑
              </button>
              <button type="button" aria-label="Move down" onClick={() => move(index, index + 1)}>
                ↓
              </button>
              <button
                type="button"
                aria-label="Remove stop"
                className="danger"
                onClick={() => onRemove(index)}
              >
                ×
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
