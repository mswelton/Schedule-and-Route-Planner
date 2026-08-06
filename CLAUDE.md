# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

The THC Route Planner. Mark Welton runs The Hoof Clinic, an equine podiotherapy
practice in South Gippsland, Victoria. He drives to properties. This app turns a
day's list of stops into a timed itinerary: what time to leave home, when he
arrives at and leaves each property, when he is back, with per-leg drive time,
distance and any routing warnings Google returns.

It reads the practice database (`hoof-tracker` on Supabase, shared with Mark's
main app) and owns no tables in it. It writes in exactly one place:
`api/fuel-log.js` inserts a row into `fuel_cost_calculations` when Mark logs a
run. Everything else is read-only, and it should stay that way — if you are
adding a second write, that is a decision worth raising rather than a pattern
to follow.

## Commands

```bash
npm run dev      # http://localhost:5173 — serves the api/ functions too, see below
npm run build    # Vite production build
npm test         # node:test, all suites (13 tests)
node --test test/schedule.test.js                          # one file
node --test --test-name-pattern="warnings" test/*.test.js  # one test by name
```

The name filter has to go *before* the file list. `npm test -- --test-name-pattern=…`
appends it after the glob, where `node --test` ignores it and silently runs
everything.

There is no linter and no CI workflow. `npm test` is the whole gate.

## Architecture

Three layers, and the boundary between them is a security boundary:

- **`api/*.js`** — Vercel serverless functions. The *only* code that sees a key.
  Seven endpoints: `locations` (GET), `appointments` (GET), `plan` (POST),
  `staticmap` (POST), `config` (GET), `fuel-log` (GET/POST), `optimise` (POST).
- **`lib/*.js`** — server-side modules. **Never import these from `src/`.**
  `google.js` holds the Maps key, `supabase.js` holds the service-role key.
- **`src/`** — the React app. Talks to `/api/*` through `src/lib/api.js` and
  holds no credentials. No variable in this project is `VITE_`-prefixed, so
  nothing reaches the browser bundle.

`src/lib/` (client) and `lib/` (server) are different directories with similar
names. Check which one you are editing. `lib/auth.js` (verifies tokens) and
`src/lib/auth.js` (runs the sign-in) are the pair most easily confused.

### Authentication

Every endpoint that reads practice data or spends the Maps key is behind a
verified Supabase session. A handler's first two lines are:

```js
const user = await authenticate(req, res);
if (!user) return undefined;   // authenticate() has already sent the 401
```

and `user.id` is then passed to `scopeToUser(query, userId)`. That scoping is
mandatory — `scopeToUser` throws without an id, so there is no unscoped path to
fall into. The old `THC_USER_ID` env var is gone: scoping is enforced by the
server, not configured by a deployment.

**`GET /api/config` is the one deliberately public endpoint.** It serves the
Supabase URL and anon key so the browser can sign in at all. That pair is
publishable by design — RLS protects the data — but nothing else may be added
to that response. It exists instead of a `VITE_SUPABASE_ANON_KEY` build
variable so every value in this project is set in one server-side place; if you
are tempted to "simplify" it into a `VITE_` variable, that is the reason not to.

Tokens are verified by calling Supabase rather than decoding the JWT locally,
which costs a round trip but survives a JWT secret rotation.

### The scheduling model

`lib/schedule.js` is the core, and it is pure — no network, no env, no clock
beyond what it is handed. It takes `getLeg` as an argument, which is why the
scheduling rules are fully unit-tested against stubbed legs.

The day is anchored on the **first appointment time**, not a leave time:

```
anchor         = stops[0].scheduledTime ?? firstAppointment
leaveBase      = anchor − drive(base → stop 1)
arrival[0]     = anchor
departure[i]   = arrival[i] + timeOnSite[i]
arrival[i]     = max(departure[i−1] + drive(i−1 → i), scheduledTime[i])
returnToBase   = departure[last] + drive(last stop → base)
```

A stop carries `scheduledTime` when the client was booked for a particular
time. Reaching it early means waiting (`waitSeconds`), so the arrival is held
back rather than printed early; reaching it late is not something the schedule
can absorb, so it is reported (`lateSeconds`, and collected into `lateStops`)
and left visible. A stop without one just chains off the stop before it.

Two consequences worth knowing before you change anything here:

1. **Every leg is priced at the departure time it is actually driven at.** The
   07:00 run out is not the 16:00 run home, and Google's traffic estimate
   differs accordingly.
2. **The first leg is fetched twice, deliberately.** The leave time depends on
   the first leg's duration, and that duration depends on the leave time. So:
   fetch once departing at the appointment time for a rough figure, then again
   at the implied leave time. That second number is the one Mark acts on. A
   failure on the refinement falls back to the rough estimate rather than
   failing the plan. `test/schedule.test.js` asserts this call sequence — if you
   "optimise away" the extra call, that test is telling you not to.

Planning a run in the past (or within the next minute) falls back to
traffic-unaware routing, since the Routes API rejects past departure times. The
itinerary labels those legs.

### Two ways of talking to the Routes API, and why

- **`fetchLeg()`** prices one leg at one departure time. This is what builds the
  itinerary, via `buildItinerary`.
- **`fetchRunOverview()`** prices a whole run in one call and can let Google
  reorder the stops (`optimizeWaypointOrder`). It backs `api/optimise.js` and
  exists **only to compare orderings**. Never build an itinerary from it: a
  multi-waypoint route assumes you drive straight through, so it knows nothing
  about the 45 minutes at each property and prices every leg at the wrong time
  of day. Once an order is chosen, the legs are re-priced with `fetchLeg`.

`api/optimise.js` suggests an order and changes nothing; applying it is a
separate click. It is refused when any stop has a booked time — reordering
those would break times clients have already been given.

### Leg caching

`lib/legcache.js` wraps `fetchLeg` in `api/plan.js`. Legs are keyed on where
the two places are (**not** their ids — the base is always id `base` even when
the address is typed over) plus a 15-minute departure bucket, and expire after
ten minutes so no run is planned on a stale traffic estimate.

It is in-memory on purpose: no schema in a database this app does not own, and
the case it exists for — pressing the button again after nudging a stop's time
on site — happens inside one warm instance. A cold start pays full price, which
is what happened before it existed. Measured on a three-stop day: four plans
cost 8 Routes calls instead of 21, and re-planning an unchanged day costs none.

`buildItinerary` is unaware of any of this and still asks for every leg,
including the first one twice.

### Time handling

All arithmetic happens on absolute instants (epoch ms) so the `departureTime`
handed to Google is unambiguous. `lib/time.js` converts between Melbourne
wall-clock and instants, handling the AEST/AEDT boundary by computing the offset
twice.

**`api/plan.js` ships display-ready `*Clock` strings to the browser.** The
client never reasons about Melbourne's UTC offset itself. Keep it that way —
when adding a time to the response, format it server-side.

### Dev server

`npm run dev` does not need the Vercel CLI. The `vercelApiDev` plugin in
`vite.config.js` runs `api/*.js` inside the Vite dev server, reproducing just
enough of Vercel's `req.query` / `req.body` / `res.status().json()` shape. Any
new `api/<name>.js` file is routed at `/api/<name>` automatically.

That plugin also loads `.env.local` into `process.env`, because Vite exposes
only `VITE_`-prefixed variables and only on `import.meta.env` — the handlers are
ordinary Node code reading `process.env` and would otherwise see nothing in dev.
A real shell variable wins over the file.

## Things that will bite you

**Google Maps key restrictions.** Every Maps call is server-side and therefore
sends no `Referer` header, so an HTTP referrer restriction rejects all of them
(`Requests from referer <empty> are blocked`). IP restriction fails too — Vercel's
egress addresses are not fixed. The key must be **Application restrictions:
None** + **API restrictions:** Routes API, Maps Static API. `keyRestrictionHint()`
in `lib/google.js` turns these failures into actionable messages; keep it
current if you add another Google API.

**Vercel scopes env vars per environment.** Production, Preview and Development
hold separate values, and a change needs a redeploy. If a key looks right in the
Console but the app rejects it, you are usually testing a different one.

**The schema is not what you would guess.** `service_locations` uses
`address_line1` / `address_line2` / `town_city` / `county` / `postcode` and
`latitude` / `longitude` — not `address` / `lat` / `lng`. It also has *two*
foreign keys to `clients` (`client_id` and `created_by_client_id`), so any
embed must name the constraint explicitly
(`clients!service_locations_client_id_fkey`) or PostgREST rejects it as
ambiguous.

**Coordinates over geocoding.** All 17 active `service_locations` rows carry
lat/lng, so legs are computed from stored coordinates. The address-string
fallback in `toWaypoint()` still exists for rows without them, but as of
August 2026 nothing exercises it.

**`Number(null)` is `0`, and `0` is a finite latitude.** Checking a coordinate
with `Number.isFinite(Number(row.lat))` therefore turns a *missing* latitude
into a real place in the Gulf of Guinea rather than falling through to the
address. `lib/google.js` and `src/lib/navigation.js` each have a `coordinate()`
helper that rejects `null`/`undefined`/`''` first. Use it for any new
coordinate check.

**The horse embed names an unobvious constraint.** `appointments.horse_id` is a
*text* column whose foreign key points at `horses.horse_id`, not at the bigint
`horses.id`. A PostgREST embed has to say
`horses!appointments_horse_id_fkey ( name )`, and a SQL join on `horses.id`
fails outright on the type mismatch.

**Stop coordinates are re-resolved server-side in `api/plan.js`** from the IDs
the client sends, never trusted from the request body. Keep that property.

**The base address is an override, not a setting.** It defaults to the
`service_locations` row flagged `is_home` (Sondela Farm), falling back to a
`BASE_ADDRESS` env var. A typed base is stored in `localStorage` as an explicit
*override*; the Supabase default is deliberately never written there, so
changing `is_home` in the database takes effect on browsers that haven't
overridden it. "Reset to default" clears the key.

## Known gaps

`docs/ROADMAP.md` is the prioritised plan and tracks what is built. Tier 0 (the
two things the app got *wrong*) and all of Tier 1 are done. What is left is
Tier 2 and 3: persisting plans and writing times back to `appointments` (needs
a schema agreed first), day-shape guards, plan-versus-actual, CI, and offline
support.

One thing outside this repository, flagged there and in the README: the
`fuel_cost_calculations` policies grant `anon` full read/write/delete
(`USING (true)`), so RLS is on but not restricting anything. This app writes to
that table through the service-role key and is unaffected either way.

## Conventions

Comments here explain *why*, particularly where the code looks wrong at a
glance — the double-fetched first leg, the empty env prefix in `vite.config.js`,
the named FK in the PostgREST embed. Match that: if a future reader would
reasonably try to simplify something, say why they shouldn't.

Prose in the UI and the docs is written for one specific working farrier, not a
generic user. Keep it plain and concrete.
