/**
 * Itinerary construction.
 *
 * Kept free of network and env access so the scheduling rules can be tested
 * against a stubbed `getLeg`. The only thing this module knows about the maps
 * provider is the shape it returns: { seconds, meters, warnings, polyline }.
 */

/**
 * Build a full day's itinerary.
 *
 * The schedule is anchored on the *first appointment time*, not a leave time:
 *   leaveBase        = anchor - drive(base -> stop 1)
 *   arrival[0]       = anchor
 *   departure[i]     = arrival[i] + onSiteMinutes[i]
 *   arrival[i]       = max(departure[i-1] + drive(i-1 -> i), scheduledTime[i])
 *   returnToBase     = departure[last] + drive(last stop -> base)
 *
 * A stop may carry the time the client was actually booked for
 * (`scheduledTime`). Arriving before it means waiting, not knocking on the
 * door early, so the arrival is held back to the booked time and the gap is
 * reported as `waitSeconds`. Arriving after it means running late, which the
 * schedule cannot fix — it is reported as `lateSeconds` and left visible.
 * Without a booked time a stop simply chains off the one before, as before.
 *
 * The anchor is stop 1's booked time when it has one, falling back to the
 * `firstAppointment` the caller passes. Both exist because the day can be
 * planned from the appointment book *or* from a time typed into the UI.
 *
 * The first leg is computed twice: once departing at the appointment time to
 * get a rough duration, then again departing at the implied leave time. Traffic
 * at 06:40 is not traffic at 08:00, and the leave time is the number Mark
 * actually acts on, so it is worth the extra call.
 *
 * @param {object}   opts
 * @param {object}   opts.base              { label, lat, lng, address }
 * @param {object[]} opts.stops             ordered, each { id, label, lat, lng, address,
 *                                          onSiteMinutes, scheduledTime? (epoch ms) }
 * @param {number}   opts.firstAppointment  epoch ms
 * @param {Function} opts.getLeg            async (origin, destination, departureMs) => leg
 * @returns {Promise<object>} itinerary
 */
export async function buildItinerary({ base, stops, firstAppointment, getLeg }) {
  if (!base) throw new Error('A base location is required.');
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new Error('At least one stop is required.');
  }
  if (!Number.isFinite(firstAppointment)) {
    throw new Error('A first appointment time is required.');
  }

  // A booked time on the first stop is the real anchor; `firstAppointment` is
  // the fallback for a day assembled by hand rather than from the book.
  const anchor = Number.isFinite(stops[0].scheduledTime)
    ? stops[0].scheduledTime
    : firstAppointment;

  // --- Leg 0: base -> first stop, refined for the actual departure time. ---
  const rough = await getLeg(base, stops[0], anchor);
  const roughLeave = anchor - rough.seconds * 1000;
  let firstLeg = rough;
  try {
    firstLeg = await getLeg(base, stops[0], roughLeave);
  } catch {
    // A refinement failure is not fatal — fall back to the first estimate.
    firstLeg = rough;
  }

  const leaveBase = anchor - firstLeg.seconds * 1000;

  const legs = [{ from: base.label, to: stops[0].label, ...firstLeg }];
  const scheduled = [];

  let chainedArrival = anchor;
  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i];
    const onSiteMinutes = Number(stop.onSiteMinutes) || 0;
    const bookedFor = Number.isFinite(stop.scheduledTime) ? stop.scheduledTime : null;

    // Turning up early means sitting in the ute until the booked time; turning
    // up late is not something the schedule can absorb, so it is reported.
    let arrival = chainedArrival;
    let waitSeconds = 0;
    let lateSeconds = 0;
    if (bookedFor !== null) {
      if (chainedArrival < bookedFor) {
        waitSeconds = (bookedFor - chainedArrival) / 1000;
        arrival = bookedFor;
      } else if (chainedArrival > bookedFor) {
        lateSeconds = (chainedArrival - bookedFor) / 1000;
      }
    }

    const departure = arrival + onSiteMinutes * 60 * 1000;

    scheduled.push({
      id: stop.id,
      label: stop.label,
      address: stop.address,
      arrival,
      departure,
      onSiteMinutes,
      bookedFor,
      waitSeconds,
      lateSeconds,
      // Drive leg *leaving* this stop; filled in below.
      legToNext: null,
    });

    const next = i + 1 < stops.length ? stops[i + 1] : base;
    const leg = await getLeg(stop, next, departure);
    legs.push({ from: stop.label, to: next.label, ...leg });
    scheduled[i].legToNext = leg;

    chainedArrival = departure + leg.seconds * 1000;
  }

  const returnToBase = chainedArrival;
  const totalDrivingSeconds = legs.reduce((sum, leg) => sum + leg.seconds, 0);
  const totalOnSiteMinutes = scheduled.reduce((sum, s) => sum + s.onSiteMinutes, 0);
  const totalDistanceMeters = legs.reduce((sum, leg) => sum + (leg.meters || 0), 0);
  const totalWaitingSeconds = scheduled.reduce((sum, s) => sum + s.waitSeconds, 0);

  return {
    base: { label: base.label, address: base.address },
    leaveBase,
    legToFirstStop: firstLeg,
    stops: scheduled,
    returnToBase,
    totals: {
      drivingSeconds: totalDrivingSeconds,
      onSiteMinutes: totalOnSiteMinutes,
      distanceMeters: totalDistanceMeters,
      waitingSeconds: totalWaitingSeconds,
      // Waiting is already inside this, being wall-clock leave-to-return.
      dayLengthSeconds: (returnToBase - leaveBase) / 1000,
    },
    // Stops the chain reaches after the time the client was given. Surfaced at
    // the top level because one late stop usually means every stop after it.
    lateStops: scheduled
      .filter((s) => s.lateSeconds > 0)
      .map((s) => ({ id: s.id, label: s.label, lateSeconds: s.lateSeconds })),
    warnings: legs.flatMap((leg, i) =>
      (leg.warnings || []).map((text) => ({ legIndex: i, from: leg.from, to: leg.to, text }))
    ),
  };
}
