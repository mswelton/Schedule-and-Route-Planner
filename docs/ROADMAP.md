# Enhancement plan

Where the route planner goes next, in the order it is worth doing. Each item
says what is wrong or missing today, what to build, and roughly what it costs.

Everything below is measured against the app as it stands (`main` @ `13eb691`)
and against the live `hoof-tracker` Supabase project, not against guesswork.

## What the current app actually is

One screen: pick a date and a first appointment time, pick stops in visit
order, press **Work out my day**. `api/plan.js` resolves the stops from
`service_locations`, chains them through `lib/schedule.js`, prices every leg
against the Routes API at the time it is actually driven, and renders a timed
itinerary with a static map and a print view.

It does that one job well. The gaps below are all about the things around it:
who can see it, whether the times it produces agree with what clients were
told, and the fact that the run it plans is thrown away the moment the tab
closes.

### Numbers this plan leans on

Pulled from the live project on 2026-08-06:

| | |
| --- | --- |
| Active service locations | 17, **all** with `latitude`/`longitude` |
| Appointments | 137 across 50 distinct run days |
| Average appointments per run day | 2.74 (the busiest recent day is 8) |
| Appointments with `actual_duration_minutes` | 11 of 137 |
| `fuel_cost_calculations` rows | 20, hand-entered |
| Routes API calls per plan | `stops + 2` |

Two of those change decisions later on: a typical run is 3 stops, not 15,
which makes exact stop-order optimisation trivial rather than a TSP problem;
and only 11 appointments carry an actual duration, which makes "learn on-site
times from history" premature.

---

## Tier 0 — do these before anything else

### 1. The deployed API has no authentication at all

`GET /api/locations` returns every client's name, property address and access
notes. `POST /api/plan` and `POST /api/staticmap` spend the Google Maps key.
None of the four handlers checks a session, a token, or anything else — the
service-role key is used unconditionally. Anyone who has the Vercel URL has all
of it. `THC_USER_ID` scopes rows to one operator; it does not authenticate
anybody.

`api/staticmap.js` is the sharpest edge: it takes arbitrary `polylines` from
the request body and proxies them to the Static Maps API on Mark's key, with no
cap on how many. That is a billable open proxy.

**Build:** the rest of the THC stack already runs on Supabase Auth (RLS is on
across all 29 tables, `profiles` is 1:1 with `auth.users`). Match it:

- Sign in with Supabase Auth on the client, send the access token as a bearer
  header from `src/lib/api.js`.
- A single `lib/auth.js` guard that verifies the JWT and returns the user id;
  every handler starts with it.
- Keep the service-role client, but derive the row scope from the verified
  user id instead of `THC_USER_ID`, so scoping is enforced rather than
  configured.
- While in there: cap `polylines` and `markers` length in `staticmap.js`.

**Effort:** ~1 day. **Do this first** — every other item adds more surface to
an endpoint that currently has none.

An interim mitigation, if a full auth pass has to wait: turn on Vercel
Deployment Protection (password or SSO) for the project. Ten minutes, and it
closes the exposure until the real fix lands.

### 2. Booked appointment times are silently discarded for every stop but the first

`api/appointments.js` returns `earliestTime` per location. `App.jsx` uses it
for exactly one thing — setting `firstAppointmentTime` from the first stop —
and then drops it:

```js
setStops(data.stops.map((s) => ({ locationId: s.locationId, onSiteMinutes: … })))
```

Every later arrival is derived purely from drive time plus on-site time. So if
a client is booked for 13:00 and the chain puts you there at 11:20, the
itinerary prints 11:20 with no indication that it disagrees with what the
client was told. The opposite case — the chain arriving at 13:40 for a 13:00
booking — is worse and equally silent.

**Build:** carry `scheduledTime` through to `buildItinerary` as an optional
per-stop constraint.

- `arrival[i] = max(chained arrival, scheduled time)` when a booking exists,
  with the difference shown as **Wait 40 min** on the timeline.
- When the chain lands *after* the booking, flag the stop: **35 min late** —
  and mark every downstream stop as knocked on.
- Show the total slack for the day in the summary strip.

This is the one change that makes the itinerary trustworthy against the
appointment book rather than a parallel version of it. `lib/schedule.js` is
pure and fully unit-tested, so it is a well-covered change: new tests for
wait-inserted, late-arrival, and no-booking-set cases.

**Effort:** ~1 day including tests.

---

## Tier 1 — highest value per line of code

### 3. Navigation deep links

The itinerary tells you to leave at 06:40 and then leaves you to type the
address into your phone. Every stop already has `lat`/`lng` server-side.

**Build:** a **Navigate** link per stop (`https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`,
plus an Apple Maps variant), and one **Open whole day in Google Maps** link
built from base → stops → base as waypoints. Hidden in print.

**Effort:** under an hour. Probably the largest day-to-day improvement in this
document per unit of work.

### 4. Log the run's fuel cost — the table already exists and is filled in by hand

`fuel_cost_calculations` has 20 rows and exactly the columns a plan produces:

```
trim_run_date, description, distance_traveled, fuel_consumption,
fuel_cost, litres_consumption, trip_cost, cost_per_km, appointment_ids
```

Today's row records 231 km at 9.0 L/100 km and $2.25/L → $46.78 for the run,
and the distance was typed in. The planner computes that exact number
(`totals.distanceMeters`) as a side effect of doing its actual job.

**Build:** a **Log fuel cost** button on the itinerary that POSTs to a new
`api/fuel-log.js`:

- `distance_traveled` from the plan totals, `trim_run_date` from the run date.
- `description` composed from the stop labels — matching the existing
  hand-written style (`"Eichhorn - Wonga (Lyric, Charlie); Best Family Farm …"`).
- `appointment_ids` populated when the stops came from **Load from
  appointments** (5 of the 20 existing rows have it; the planner can make that
  every row).
- L/100 km and $/L default to the last row's values and stay editable — those
  are the two numbers only Mark knows.
- Show the estimated run cost on the itinerary *before* saving, so it is useful
  even when he doesn't save it.

Worth noting once the numbers are visible: the pricelist carries a flat $10
**Fuel Levy Surcharge**, and a 231 km run costs $46.78 in fuel alone. Whether
that is a pricing question is Mark's call, but the planner is what makes it
answerable per run.

**Effort:** ~half a day.

### 5. Optimise stop order — now a small problem, not a TSP

Listed as "not built" in the README on the grounds that it was not needed for
v1. The data says it is also cheap: 2.74 stops on an average run day, 8 on the
busiest recent one. That is not a travelling-salesman problem, it is a handful
of permutations.

**Build:** an **Optimise order** button (off by default, as the brief wanted).
One `computeRoutes` call with the stops as `intermediates` and
`optimizeWaypointOrder: true` returns Google's ordering directly. Show the
saving — *"reordering saves 22 km / 35 min"* — and let Mark apply or ignore it.

Two things to get right:

- **Do not price the day from that call.** Multi-waypoint routing assumes you
  drive straight through; it knows nothing about 45 minutes on site, so its leg
  times are wrong for this app's purpose. Use it for the *ordering only*, then
  re-run the existing per-leg pricing on the new order.
- Stops with a booked time (item 2) are pinned and must not be reordered.

**Effort:** ~1 day.

### 6. Cut Routes API calls, and cache them

A plan costs `stops + 2` Routes calls, every press, with no caching — pressing
the button three times while nudging on-site minutes costs 15 calls and
produces identical legs.

**Build:**

- Cache legs by `(origin id, destination id, departure time rounded to 15 min)`.
  With 17 locations there are at most a few hundred distinct pairs; a small
  `route_legs_cache` table (or Vercel KV) covers a whole season of runs.
- Fetch the independent legs concurrently rather than in the `for` loop —
  arrival times chain, but each leg's *duration* only depends on its own
  departure estimate, so two passes (estimate, then refine) parallelise cleanly.
- Keep the deliberate double-call on the first leg. It is documented, it is
  correct, and it is the number Mark acts on.

**Effort:** ~1 day. Pays for itself in Maps billing and makes the button feel
instant.

---

## Tier 2 — the planner stops being a throwaway page

### 7. Save the plan, and write the times back to `appointments`

Currently a plan lives until the tab closes. The README defers this as needing
a new table, which is right — but half of it needs no new table at all:
`appointments` already has `scheduled_time`, `scheduled_end_time`, and both
`google_calendar_event_id` and `zoho_calendar_event_id` with their sync
timestamps. The planner is computing exactly those two times and throwing them
away.

**Build, in two independently shippable halves:**

- **`route_plans` + `route_plan_stops`** — one row per planned run, ordered
  stops with arrival/departure/leg distance, so a run can be reopened, compared
  against what actually happened, and reported on. Needs a shape agreed first;
  suggest `user_id`, `run_date`, `base_address`, `total_distance_m`,
  `total_driving_s`, `plan_json`, and a stop child table.
- **Write-back** — a **Push times to appointments** action that updates
  `scheduled_time` / `scheduled_end_time` for the day's appointments from the
  plan. Explicit, previewed as a diff, never automatic. The existing calendar
  sync then carries the change to Google/Zoho on its own.

**Effort:** ~2 days, plus a schema conversation before writing any of it.

### 8. Day-shape guards

The planner will happily produce a 13-hour day with a 05:10 start and say
nothing. It has all the information needed to object.

**Build:** configurable working-day bounds and a lunch break; warnings when the
day exceeds them, when the leave time is before an earliest-start setting, or
when `returnToBase.nextDay` is true (already computed — currently just a
chip). Also: an **end somewhere other than base** option for the days that
finish at a different property.

**Effort:** ~half a day.

### 9. Plan versus actual

`appointments.actual_duration_minutes` is populated on 11 of 137 rows — too
thin to learn per-location on-site times from today. But that is a reason to
start recording the comparison, not to skip it.

**Build:** store planned vs actual per stop (falls out of item 7 for free), and
show a simple accuracy view. Once the sample is real, default `onSiteMinutes`
per location from its own history instead of the flat 45-minute constant, and
the estimate improves without anyone tuning it.

**Effort:** small now, useful later. Sequence it after item 7.

---

## Tier 3 — infrastructure and polish

### 10. No CI

There is no `.github/workflows`. `npm test` passes (13 tests) and nothing runs
it on a push.

**Build:** a workflow running `npm test` and `npm run build` on push and PR.
Extend coverage while in there — `lib/google.js` response parsing and the
`api/*` handlers have none; `lib/schedule.js` and `lib/time.js` are well
covered.

**Effort:** an hour.

### 11. Offline / PWA

This is a tool used between properties in Gippsland, where coverage is patchy,
and it is a network-dependent SPA. Losing signal loses the itinerary.

**Build:** a service worker caching the app shell and the last rendered
itinerary (plus its map image), so the day survives a dead zone. Read-only
offline is enough — no offline planning.

**Effort:** ~half a day.

### 12. Smaller fixes

- **`todayIso()` uses the browser's local date** (`src/lib/format.js`) while
  every plan is computed in `Australia/Melbourne`. Harmless at home, wrong for
  a browser on UTC. Derive the default date in the planner timezone.
- **The README's stated data is out of date in two places.** It says 15
  service locations have coordinates; there are now 17 active rows and *all*
  of them do — the `no lat/lng` chip and the `geocodedFallbacks` path are
  currently dead code paths (worth keeping, but they describe nothing today).
- **The README security note is half stale.** `fuel_cost_calculations` now has
  RLS enabled — item 2 is resolved and should be struck. Item 1 still stands:
  `db-proxy` is still deployed with `verify_jwt: false`.
- **New, related:** the database linter flags
  `public.get_trip_appointments(p_date date)` as a `SECURITY DEFINER` function
  executable by the `anon` role via `/rest/v1/rpc/`. Given the name, it is
  probably trip logic belonging to the main hoof-tracker app — but it is
  callable without signing in, and it should not be.

---

## Suggested order

| | Item | Why here |
| --- | --- | --- |
| 1 | Auth on the API (Tier 0.1) | Client PII and a billable key are open right now |
| 2 | Honour booked times (Tier 0.2) | The itinerary can currently contradict the appointment book |
| 3 | Navigation links (1.3) | An hour's work, used on every stop of every run |
| 4 | Fuel cost logging (1.4) | Replaces manual entry with a number already computed |
| 5 | Optimise order (1.5) | Cheap at 3 stops, and the last unbuilt brief item |
| 6 | Call reduction + cache (1.6) | Makes 3–5 sensible to iterate on |
| 7 | Persist plans + write-back (2.7) | Needs the schema conversation started early |

Items 3 and 4 are small enough to land in the same PR as 1 if that is more
convenient than three round trips.

## Open questions for Mark

1. **Auth model** — full Supabase Auth sign-in on this app, or is Vercel
   password protection enough given it is single-operator? The first is right;
   the second is ten minutes.
2. **`route_plans` schema** — worth agreeing the shape before it is written,
   as the README already notes.
3. **Write-back to `appointments`** — is the planner allowed to change
   `scheduled_time` on real bookings (with a preview and a confirm), or should
   it stay strictly read-only against the practice data?
4. **Fuel defaults** — carry L/100 km and $/L forward from the last logged
   run, or keep them as settings?
