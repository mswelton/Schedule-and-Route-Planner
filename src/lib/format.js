/** Human-readable duration, e.g. "1 h 12 min" / "45 min". */
export function formatDuration(seconds) {
  const total = Math.round((seconds || 0) / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours && minutes) return `${hours} h ${minutes} min`;
  if (hours) return `${hours} h`;
  return `${minutes} min`;
}

export function formatMinutes(minutes) {
  return formatDuration((minutes || 0) * 60);
}

/** Distances in km, matching how Mark reads them off Google Maps. */
export function formatDistance(meters) {
  const km = (meters || 0) / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function formatLongDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Today's date as YYYY-MM-DD in the browser's local zone. */
export function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
