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
 *   leaveBase        = firstAppointment - drive(base -> stop 1)
 *   arrival[0]       = firstAppointment
 *   departure[i]     = arrival[i] + onSiteMinutes[i]
 *   arrival[i]       = departure[i-1] + drive(stop i-1 -> stop i)
 *   returnToBase     = departure[last] + drive(last stop -> base)
 *
 * The first leg is computed twice: once departing at the appointment time to
 * get a rough duration, then again departing at the implied leave time. Traffic
 * at 06:40 is not traffic at 08:00, and the leave time is the number Mark
 * actually acts on, so it is worth the extra call.
 *
 * @param {object}   opts
 * @param {object}   opts.base              { label, lat, lng, address }
 * @param {object[]} opts.stops             ordered, each { id, label, lat, lng, address, onSiteMinutes }
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

  // --- Leg 0: base -> first stop, refined for the actual departure time. ---
  const rough = await getLeg(base, stops[0], firstAppointment);
  const roughLeave = firstAppointment - rough.seconds * 1000;
  let firstLeg = rough;
  try {
    firstLeg = await getLeg(base, stops[0], roughLeave);
  } catch {
    // A refinement failure is not fatal — fall back to the first estimate.
    firstLeg = rough;
  }

  const leaveBase = firstAppointment - firstLeg.seconds * 1000;

  const legs = [{ from: base.label, to: stops[0].label, ...firstLeg }];
  const scheduled = [];

  let arrival = firstAppointment;
  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i];
    const onSiteMinutes = Number(stop.onSiteMinutes) || 0;
    const departure = arrival + onSiteMinutes * 60 * 1000;

    scheduled.push({
      id: stop.id,
      label: stop.label,
      address: stop.address,
      arrival,
      departure,
      onSiteMinutes,
      // Drive leg *leaving* this stop; filled in below.
      legToNext: null,
    });

    const next = i + 1 < stops.length ? stops[i + 1] : base;
    const leg = await getLeg(stop, next, departure);
    legs.push({ from: stop.label, to: next.label, ...leg });
    scheduled[i].legToNext = leg;

    arrival = departure + leg.seconds * 1000;
  }

  const returnToBase = arrival;
  const totalDrivingSeconds = legs.reduce((sum, leg) => sum + leg.seconds, 0);
  const totalOnSiteMinutes = scheduled.reduce((sum, s) => sum + s.onSiteMinutes, 0);
  const totalDistanceMeters = legs.reduce((sum, leg) => sum + (leg.meters || 0), 0);

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
      dayLengthSeconds: (returnToBase - leaveBase) / 1000,
    },
    warnings: legs.flatMap((leg, i) =>
      (leg.warnings || []).map((text) => ({ legIndex: i, from: leg.from, to: leg.to, text }))
    ),
  };
}
