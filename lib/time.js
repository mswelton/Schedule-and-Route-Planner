/**
 * Timezone helpers.
 *
 * All scheduling arithmetic happens on absolute instants (epoch ms) so that the
 * `departureTime` we hand to Google is unambiguous. The user, however, types
 * wall-clock times for a Victorian working day, so we need to convert between
 * "10:00 on 2026-08-06 in Australia/Melbourne" and a real instant, across the
 * AEST/AEDT boundary.
 */

export const DEFAULT_TIMEZONE = process.env.PLANNER_TIMEZONE || 'Australia/Melbourne';

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function offsetAt(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(instantMs))) {
    parts[type] = value;
  }
  // `hour` comes back as 24 for midnight under hour12:false in some ICU builds.
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instantMs;
}

/**
 * Convert a local wall-clock date + time in `timeZone` to an epoch-ms instant.
 *
 * @param {string} dateStr  'YYYY-MM-DD'
 * @param {string} timeStr  'HH:MM' (24h)
 */
export function zonedToInstant(dateStr, timeStr, timeZone = DEFAULT_TIMEZONE) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid date/time: ${dateStr} ${timeStr}`);
  }
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // First guess using the offset in effect at the naive instant, then re-check:
  // on a DST boundary the first guess can land in the wrong offset.
  const guess = naive - offsetAt(naive, timeZone);
  const corrected = naive - offsetAt(guess, timeZone);
  return corrected;
}

/** Format an instant as 'HH:MM' wall-clock in `timeZone`. */
export function instantToClock(instantMs, timeZone = DEFAULT_TIMEZONE) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return dtf.format(new Date(instantMs));
}

/** True when the instant falls on a different local date than `baseInstantMs`. */
export function isNextDay(instantMs, baseInstantMs, timeZone = DEFAULT_TIMEZONE) {
  const day = (ms) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(ms));
  return day(instantMs) !== day(baseInstantMs);
}

/** Round seconds to whole minutes for display. */
export function secondsToMinutes(seconds) {
  return Math.round(seconds / 60);
}
