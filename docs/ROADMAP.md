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
| Average appointments per run day | 2.74 |
| Stops (distinct locations) per run day | 1 on 25 days, 2 on 13, 3 on 2 — **3 is the busiest ever** |
| Appointments with `actual_duration_minutes` | 11 of 137 |
| `fuel_cost_calculations` rows | 20, hand-entered |
| Routes API calls per plan | `stops + 2` |

Two of those change decisions later on: a typical run is 3 stops, not 15,
which makes exact stop-order optimisation trivial rather than a TSP problem;
and only 11 appointments carry an actual duration, which makes "learn on-site
times from history" premature.

---

## Tier 0 — done

Both items below are **built**. They are kept here with their original
reasoning because the reasoning is the record of why the app behaves as it now
does; the fixes are described at the end of each.

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

**Done.** The browser signs in with Supabase Auth and sends the access token
with every request; `lib/auth.js` verifies it and `scopeToUser()` throws
without a verified id, so no unscoped path remains. `THC_USER_ID` is gone.
`GET /api/config` is the one deliberately public endpoint — it serves the
project URL and anon key so sign-in can happen at all. `staticmap.js` now caps
its polylines and markers.

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

**Done.** `buildItinerary` takes an optional `scheduledTime` per stop, holds
the arrival back to it (reporting `waitSeconds`) and reports `lateSeconds` plus
a top-level `lateStops` when the run cannot make it. The first stop's booked
time now anchors the day ahead of the typed-in first appointment time. **Load
from appointments** fills the times in, and each stop has a clearable field.
Four new cases in `test/schedule.test.js` cover wait, late, anchoring and the
unchanged no-booking path.

---

## Tier 1 — highest value per line of code

All four are **built**. Tier 2 is next.

### 3. Navigation deep links

The itinerary tells you to leave at 06:40 and then leaves you to type the
address into your phone. Every stop already has `lat`/`lng` server-side.

**Done.** A **Navigate** link and an **Apple Maps** link per stop, plus **Open
the day in Google Maps** in the itinerary header (base → stops → base). Google's
URL API caps a route at nine waypoints, so a longer run reports which stops did
not fit rather than dropping them quietly. All hidden in print.

Building this turned up a latent bug worth knowing about: `Number(null)` is `0`
and `0` is a finite latitude, so the `Number.isFinite(Number(row.lat))` check in
`lib/google.js` would have routed a coordinate-less stop to 0°N 0°E — in the
Gulf of Guinea — instead of falling through to the documented address geocoding.
Dormant, since all 17 rows have coordinates, but it meant the fallback path
could never actually fire. Fixed in both places, with tests.

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

**Done.** `api/fuel-log.js` — `GET` returns the last run's litres/100 km and
$/litre as defaults, `POST` writes the row. The description and the appointment
ids are rebuilt server-side from the stop ids, so a logged run always describes
rows that exist; the distance is the exception, echoed back from a plan this
server just produced rather than paying for the whole run of Routes calls
again, and range-checked instead. The cost is shown whether or not it is saved.

**This is the first thing in the app that writes to the practice database.**
Worth keeping it the only one — see the note at the top of `CLAUDE.md`.

While building it: the `fuel_cost_calculations` policies grant `anon` and
`authenticated` SELECT/INSERT/UPDATE/DELETE with `USING (true)`. RLS is
enabled, but nothing is restricted — an earlier note in the README calling this
resolved was wrong and has been corrected. Tightening it may affect the main
hoof-tracker app, so it is flagged rather than changed. The planner writes
through the service-role key and is unaffected either way.

### 5. Optimise stop order — now a small problem, not a TSP

Listed as "not built" in the README on the grounds that it was not needed for
v1. The data says it is also cheap: at most **three** stops on any run day in
the history. (An earlier draft of this document said "2.74 stops on an average
day, 8 on the busiest" — that was appointments per day, not locations. The
mistake made the case weaker than it is.) That is not a travelling-salesman
problem, it is a handful
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

**Done**, with one honest limitation. `api/optimise.js` makes two
traffic-unaware calls — the current order and the optimised one — so both are
measured under the same conditions, and reports the difference. Nothing moves
until Mark presses **Use this order**, and the itinerary is still timed by
`api/plan.js` re-pricing every leg at the time it is actually driven.

The limitation is the pinning constraint above: Google's `optimizeWaypointOrder`
reorders *all* the intermediates or none, so there is no way to hold a booked
stop in place while shuffling the rest. Rather than pretend, the feature is
**refused outright when any stop has a booked time**, saying which. That turns
out to fit the workflow — the useful moment for reordering is before the day is
booked, when Mark is deciding what order to offer. Doing better would mean
solving a constrained scheduling problem rather than asking Google for a
route.

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

**Done — the caching half.** `lib/legcache.js` keys legs on where the two
places are plus a 15-minute departure bucket, with a ten-minute life so no run
is planned on a stale traffic estimate. Measured on a three-stop day: four
plans cost **8 Routes calls instead of 21**, and re-planning an unchanged day
costs none. The first leg is still fetched twice; the cache sits underneath
`buildItinerary`, which is unaware of it.

The key is built from coordinates and address rather than ids, because the base
is always id `base` even when Mark types a different address over it — keying
on the id would serve him the previous base's drive times. There is a test for
exactly that.

It is in-memory rather than a table: no schema in a database this app does not
own, and the case it exists for happens inside one warm serverless instance. A
cold start pays full price, which is the behaviour we had before.

**Not done: concurrent leg fetching.** On reflection it is the wrong trade.
Arrival times chain, so fetching legs in parallel means a first pass at
estimated departure times and a second to correct them — which *adds* calls in
exchange for latency, against a plan that now mostly hits cache anyway. The
sequential loop also keeps "every leg is priced at the departure time it is
actually driven at" obviously true by construction, which is worth more than a
second of wall clock.

---

## Tier 2 — the planner stops being a throwaway page

Persistence is **built**. The other two items were examined against the data
and **dropped** — the reasoning is under each, and is worth re-reading before
anyone rebuilds them.

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

**Half done, and the other half declined.**

`route_plans` is built: one row per run, totals lifted out as columns for
listing, the whole `/api/plan` response kept as `jsonb`. Reopening renders the
stored itinerary with no Routes API calls and puts the day back in the editor,
so a past run can be adjusted and re-planned rather than only read. The table
is created by `docs/migrations/001_create_route_plans.sql`, applied by hand;
`api/plans.js` detects `42P01` and names that file rather than returning an
opaque 500.

**Write-back to `appointments` was declined by Mark**, and that is the settled
position rather than a pending item. The planner suggests times; changing a
time a client has already been given stays a decision made in the main app.
The columns are all there (`scheduled_time`, `scheduled_end_time`, the calendar
sync ids) if that is ever revisited — but revisit it with him, not on the
grounds that it is easy.

### 8. Day-shape guards

The planner will happily produce a 13-hour day with a 05:10 start and say
nothing. It has all the information needed to object.

**Dropped, on the evidence.** Across all 50 run days in the history the longest
span between first and last appointment is 7.75 hours, no day reaches 8, and
exactly one starts before 08:00. Guards calibrated to that would fire on
nothing; guards loose enough to be safe would be noise. Worth revisiting only
if the shape of the work changes — a second operator, or days that routinely
run past dark.

The **end somewhere other than base** option is the part of this item still
worth having, and it is independent of the guards. Small, and unbuilt.

### 9. Plan versus actual

`appointments.actual_duration_minutes` is populated on 11 of 137 rows — too
thin to learn per-location on-site times from today. But that is a reason to
start recording the comparison, not to skip it.

**Dropped — there is no signal to learn from.** Checking properly rather than
counting rows: on all 11 appointments carrying an `actual_duration_minutes`,
the actual equals the estimate **exactly** — minimum difference 0, maximum
difference 0. It is being copied from the estimate, not measured. Defaulting
`onSiteMinutes` from that history would do nothing but relearn the 45-minute
constant while looking like it had learned something, which is worse than not
doing it.

The prerequisite is real durations being captured, and that belongs to the
main hoof-tracker app rather than the planner. Once actuals genuinely differ
from estimates, this item becomes worth building — and `route_plans` already
stores what the plan predicted, so the comparison has one side of it waiting.

---

## Tier 3 — infrastructure and polish

CI is **done**. Offline support and the smaller fixes are what remain.

### 10. No CI

There was no `.github/workflows`. `npm test` passed and nothing ran it on a
push.

**Done.** `.github/workflows/ci.yml` runs `npm test` and `npm run build` on
every push and pull request, on Node 20 and 22 — 20 stays in the matrix so a
Node-22-only API used by accident shows up in CI rather than on an older
machine.

Coverage went from 36 tests to 53, aimed at the two areas that had none:

- **`test/endpoints.test.js`** walks the `api/` directory rather than naming
  handlers, and asserts every endpoint except `config` answers 401 without a
  token — so an endpoint added later that forgets `authenticate()` fails here
  instead of shipping open. Verified by removing the guard from
  `api/locations.js` and watching it fail.
- **`test/fetchleg.test.js`** stubs `globalThis.fetch` and asserts the request
  body sent to Google: the traffic-aware switch and its one-minute margin, the
  `departureTime`, duration and distance parsing, warnings including the toll
  and ignored-restriction advisories, and the key-restriction hint on a
  rejected key.

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

## Tier 4 — reviewing and correcting what has been recorded

Everything so far writes records and never looks back at them. Two things are
now accumulating — saved runs and fuel entries — and neither can be reviewed
properly or corrected when it is wrong.

There is already a concrete case: `fuel_cost_calculations` holds **two
identical rows** for 2026-07-25 ("The Ridge (Mars)", 148 km), created eight
seconds apart. A double-submit, predating the planner, that nothing in either
app can currently clean up.

State as of 2026-08-07: 21 fuel rows spanning March to August, 15 of them
hand-entered before the planner existed. `route_plans` exists but is empty —
the table was migrated, and nothing has been saved to it yet.

### 13. A History view

**Decided with Mark:** a separate screen, reached from the header, holding both
histories. The planning page is already five panels deep on one column; the
tables need room to be readable on a phone, and reviewing is a different job
from planning.

The existing **Saved runs** panel stays where it is for quick reopening. The
History screen is where the fuller reviewing and correcting happens.

Navigation is two views, so this does not justify a router dependency. Hash
routing (`#/history`) in about fifteen lines gets the back button and a
linkable URL for free.

### 14. Fuel history — review and edit

**Decided with Mark: all rows, fully editable.** The table is shared with the
main hoof-tracker app and **cannot be scoped** — `fuel_cost_calculations` has
no `user_id` column, so there is no way to show only the planner's rows without
adding one, and adding one would hide every row the main app writes. It is one
operator and one vehicle, so the honest thing is to show all 21 rows and let
any of them be corrected.

The consequence to design around: **deleting here deletes shared data.** A
confirm naming the row (date and description) is not optional.

- **List** — date, description, km, L/100 km, $/L, litres, cost, $/km, and
  whether the row is linked to appointments. Newest first.
- **Monthly totals** — distance and cost per month. This is the number that
  matters at tax time, and it is a `sum()` away.
- **Edit** — an inline row that becomes fields. Distance, consumption, price,
  date and description are editable.
- **Delete** — with the confirm above.

**The derived figures are recomputed server-side on every edit**, never taken
from the request: `litres = km × consumption ÷ 100`, `trip_cost = litres ×
price`, `cost_per_km = trip_cost ÷ km`. `api/fuel-log.js` already does this on
insert; the arithmetic moves into a shared helper so insert and update cannot
drift apart. That helper is pure, so it gets the unit tests.

A side benefit: the older rows carry values like `46.777499999999996`. Editing
one rounds it to the 2 dp the insert path already applies, so the data tidies
itself as it is touched.

### 15. Route history — review, update in place, delete

**Decided with Mark: delete plus update in place.** Reopening a saved run,
adjusting it and re-planning should update *that* row rather than adding a
second one. Without this, `route_plans` fills with near-duplicates — which is
exactly what the fuel table already demonstrates can happen.

- The planner remembers which saved run is open. After re-planning, the save
  action reads **Update saved run**, with **Save as a new run** alongside it
  for the case where a variant is genuinely wanted.
- **Delete**, with a confirm.
- Listing already exists; the History screen adds the totals and the actions.

### What this needs building

| | |
| --- | --- |
| `api/fuel-log.js` | `GET ?history=1` to list; `PUT ?id=` to update; `DELETE ?id=` to remove. Shared `computeFuelRow()` used by insert and update. |
| `api/plans.js` | `PUT ?id=` to update in place; `DELETE ?id=` to remove. |
| `src/components/History.jsx` | The view, with `FuelHistory` and `RouteHistory` inside it. |
| `src/App.jsx` | Hash routing between planner and history; remember the open run id. |
| `vite.config.js` | **The dev-server shim only parses a body for `POST` and `PUT`.** `PATCH` and `DELETE` bodies are dropped, so either stick to `PUT` or extend the shim. Worth extending it regardless — the silent-drop is a trap for the next endpoint. |
| `test/` | The fuel arithmetic helper. Extend `test/endpoints.test.js` to check `PUT` and `DELETE` require a session too — it currently only tries `GET` and `POST`, so the new verbs would not be covered by the guard that exists to catch exactly this. |
| Migration 002 | Optional: `updated_at` on `route_plans`, so an edited run can be told from an untouched one. Additive and low risk. Adding the same to `fuel_cost_calculations` is also additive, but it is not our table — worth asking first. |

### Two things to keep in view

**No audit trail.** An edit overwrites. For a single operator correcting their
own typos that is proportionate, but it does mean a wrong edit cannot be undone
from the app.

**The weak RLS on `fuel_cost_calculations` matters more now.** Its policies
grant `anon` full `SELECT/INSERT/UPDATE/DELETE` with `USING (true)`. This work
does not change that, and the planner reaches the table through the
service-role key either way — but putting a delete button in front of a table
anyone with the anon key can already empty is a good moment to fix the policies
in the hoof-tracker project.

---

## Suggested order

| | Item | Why here | Status |
| --- | --- | --- | --- |
| 1 | Auth on the API (Tier 0.1) | Client PII and a billable key were open | **done** |
| 2 | Honour booked times (Tier 0.2) | The itinerary could contradict the appointment book | **done** |
| 3 | Navigation links (1.3) | An hour's work, used on every stop of every run | **done** |
| 4 | Fuel cost logging (1.4) | Replaces manual entry with a number already computed | **done** |
| 5 | Optimise order (1.5) | Cheap at 3 stops, and the last unbuilt brief item | **done** |
| 6 | Call reduction + cache (1.6) | Makes 5 sensible to iterate on | **done** (cache) |
| 7 | Persist plans (2.7) | Needed a table, hence the wait | **done** |
| — | Write-back to `appointments` | Declined — the planner suggests, it does not rebook | closed |
| — | Day-shape guards (2.8) | Would have fired on none of 50 run days | dropped |
| — | Plan-versus-actual (2.9) | `actual_duration` is a copy of the estimate, not a measurement | dropped |
| 8 | CI (3.10) | `npm test` is the whole gate and nothing ran it | **done** |
| 9 | History view (4.13–15) | Two records accumulating, neither reviewable or correctable | **planned, next** |
| 10 | Offline / PWA (3.11) | It is a field tool in patchy coverage | next |
| 11 | Finish somewhere other than base | Survived the day-shape cull; small | next |

## Open questions for Mark

1. ~~**Auth model.**~~ Answered: full Supabase Auth sign-in, same account as
   the main hoof-tracker app.
2. ~~**`route_plans` schema.**~~ Answered: one row per run, totals as columns
   for listing, the itinerary as `jsonb`. A per-stop child table can be added
   later if per-stop history ever needs querying in SQL.
3. ~~**Write-back to `appointments`.**~~ Answered: no. The planner stays
   read-only against bookings.
4. **Fuel defaults** — carrying L/100 km and $/L forward from the last logged
   run is what got built. Still worth knowing if you would rather they were
   settings.
5. **`updated_at` on `fuel_cost_calculations`** — adding it would let an edited
   row be told from an original. Additive and safe, but that table belongs to
   the main app, so it is a question rather than an assumption.
6. **Manual fuel entries** — should the History screen let a run be added by
   hand, for a day that was driven but never planned? Not in the plan above;
   easy to add if the 15 hand-entered rows represent an ongoing habit rather
   than history.
