# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

The THC Route Planner. Mark Welton runs The Hoof Clinic, an equine podiotherapy
practice in South Gippsland, Victoria. He drives to properties. This app turns a
day's list of stops into a timed itinerary: what time to leave home, when he
arrives at and leaves each property, when he is back, with per-leg drive time,
distance and any routing warnings Google returns.

It reads the practice database (`hoof-tracker` on Supabase, shared with Mark's
main app) but owns no tables in it. Nothing here writes to practice data.

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
  Four endpoints: `locations` (GET), `appointments` (GET), `plan` (POST),
  `staticmap` (POST).
- **`lib/*.js`** — server-side modules. **Never import these from `src/`.**
  `google.js` holds the Maps key, `supabase.js` holds the service-role key.
- **`src/`** — the React app. Talks to `/api/*` through `src/lib/api.js` and
  holds no credentials. No variable in this project is `VITE_`-prefixed, so
  nothing reaches the browser bundle.

`src/lib/` (client) and `lib/` (server) are different directories with similar
names. Check which one you are editing.

### The scheduling model

`lib/schedule.js` is the core, and it is pure — no network, no env, no clock
beyond what it is handed. It takes `getLeg` as an argument, which is why the
scheduling rules are fully unit-tested against stubbed legs.

The day is anchored on the **first appointment time**, not a leave time:

```
leaveBase      = firstAppointment − drive(base → stop 1)
arrival[0]     = firstAppointment
departure[i]   = arrival[i] + timeOnSite[i]
arrival[i]     = departure[i−1] + drive(stop i−1 → stop i)
returnToBase   = departure[last] + drive(last stop → base)
```

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

**Stop coordinates are re-resolved server-side in `api/plan.js`** from the IDs
the client sends, never trusted from the request body. Keep that property.

**The base address is an override, not a setting.** It defaults to the
`service_locations` row flagged `is_home` (Sondela Farm), falling back to a
`BASE_ADDRESS` env var. A typed base is stored in `localStorage` as an explicit
*override*; the Supabase default is deliberately never written there, so
changing `is_home` in the database takes effect on browsers that haven't
overridden it. "Reset to default" clears the key.

## Known gaps

`docs/ROADMAP.md` is the prioritised plan. Two items in it are things the app
gets wrong today, not features:

1. **The `api/*` endpoints have no authentication.** `/api/locations` returns
   every client's name, address and access notes; `/api/plan` and
   `/api/staticmap` spend the Maps key. `THC_USER_ID` scopes rows to one
   operator — it does not authenticate anyone.
2. **Booked appointment times are discarded for every stop but the first.**
   `api/appointments.js` returns `earliestTime` per location; `App.jsx` uses it
   only to set the anchor and then drops it. The itinerary can therefore print
   an arrival that contradicts what the client was told, with nothing flagging
   it.

## Conventions

Comments here explain *why*, particularly where the code looks wrong at a
glance — the double-fetched first leg, the empty env prefix in `vite.config.js`,
the named FK in the PostgREST embed. Match that: if a future reader would
reasonably try to simplify something, say why they shouldn't.

Prose in the UI and the docs is written for one specific working farrier, not a
generic user. Keep it plain and concrete.
