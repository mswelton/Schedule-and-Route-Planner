# THC Route Planner

Turns a day's list of stops into a timed itinerary for The Hoof Clinic: what time
to leave home, when you arrive at and leave each property, and what time you're
back — with per-leg drive time, distance, and any routing warnings Google
returns.

React + Vite front end, Vercel serverless functions for everything that touches a
key.

![Itinerary output](docs/itinerary.png)

## How the schedule is worked out

The day is anchored on the **first appointment time**, not a leave time:

```
leaveBase      = firstAppointment − drive(base → stop 1)
arrival[0]     = firstAppointment
departure[i]   = arrival[i] + timeOnSite[i]
arrival[i]     = departure[i−1] + drive(stop i−1 → stop i)
returnToBase   = departure[last] + drive(last stop → base)
```

Each leg is priced with the `departureTime` it is actually driven at, so the
traffic estimate for the 07:00 run out is not the estimate for the 16:00 run
home. Because the leave time depends on the first leg's duration and that
duration depends on the leave time, the first leg is computed twice: once
departing at the appointment time for a rough figure, then again at the implied
leave time. That's the number you act on, so it's worth the extra call.

Planning a run in the past (or within the next minute) silently falls back to
traffic-unaware routing, which the itinerary labels.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in the two keys
npm run dev                  # http://localhost:5173
npm test                     # scheduling + timezone tests
```

`npm run dev` runs the `api/` functions inside the Vite dev server (see the
`vercelApiDev` plugin in `vite.config.js`), so the local app behaves like the
deployed one without needing the Vercel CLI. That plugin also loads
`.env.local` into `process.env` for those handlers — Vite on its own exposes
only `VITE_`-prefixed variables, and only on `import.meta.env`, so the
server-side keys would otherwise be invisible in dev. A variable already set in
your shell wins over the file.

### Environment variables

`.env.local` is for local development only — it is gitignored and never
deployed. **On Vercel, set the same variables in the project settings instead.**

All of them are server-side; see `.env.example`. None is `VITE_`-prefixed, so
none reaches the browser bundle.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-side reads of `service_locations` / `appointments` |
| `GOOGLE_MAPS_API_KEY` | yes | Routes API (legs) and Maps Static API (map preview) |
| `THC_USER_ID` | no | Scope all queries to one operator's `user_id` |
| `BASE_ADDRESS` / `BASE_ADDRESS_LABEL` | no | Fallback base if no `is_home` location exists |
| `PLANNER_TIMEZONE` | no | Defaults to `Australia/Melbourne` |

#### Restricting the Google Maps key

Enable **Routes API** and **Maps Static API** on the key, then set its
restrictions in the Cloud Console as:

- **Application restrictions: None**
- **API restrictions: Restrict key** → Routes API, Maps Static API

This is the one bit of key setup that is easy to get wrong. Every Maps call in
this app is made from a Vercel function, never from the browser, and a
server-side request sends no `Referer` header — so an **HTTP referrer**
restriction rejects all of them:

```
Routes API failed for <origin> → <destination>:
Requests from referer <empty> are blocked.
```

An IP restriction is no better: Vercel's serverless egress addresses are not
fixed. That leaves the API restriction as the meaningful one, which is fine
here — the key exists only in the server environment and is never exposed to a
client. If you also keep a referrer-restricted key for browser use elsewhere,
make this a separate key rather than loosening that one.

### Deploying

Vercel auto-detects the Vite build and serves `api/*.js` as Node functions — no
`vercel.json` needed. Set the environment variables in the project settings and
push.

Note that Vercel scopes environment variables per environment — Production,
Preview and Development each hold their own values. A key set for Production
does not apply to a PR preview deployment, and changing a value requires a
redeploy before it takes effect. If a key looks correct in the Console but the
app still rejects it, the deployment you are testing is usually reading a
different one.

## Decisions worth knowing about

**Base address — it already exists in the schema.** `profiles` has no address
column, but `service_locations` has an `is_home` flag, and the row carrying it is
Sondela Farm (205 Bass Rd, Bass VIC 3991) with coordinates already on it. That is
the default base. It is not hardcoded: the UI lets you type a different one,
which is stored as a local override in `localStorage`, and "reset to default"
clears the override so a change to `is_home` in Supabase takes effect again.

**Data access — direct, not via `db-proxy`.** Both were on the table. Direct
querying with the service-role key inside the Vercel function won: a real query
builder rather than hand-assembled PostgREST strings, one fewer hop, and no
dependency on an endpoint this app doesn't own. See the security note below for
the other reason.

**Coordinates over geocoding.** All 17 active `service_locations` rows have
`latitude`/`longitude`, so legs are computed from stored coordinates. Rows
without them fall back to the composed address string, which the Routes API
geocodes itself; the picker tags those rows `no lat/lng` and the itinerary lists
which stops were geocoded.

**Routes API over the legacy Directions API.** It is the current product, takes a
future `departureTime` for predictive traffic, and returns per-route `warnings`
— including the "restricted usage or private roads" advisories, which are shown
against the leg that produced them and collected at the foot of the itinerary.

**Schema note.** The brief described the columns as `address`, `lat`, `lng`. They
are actually `address_line1` / `address_line2` / `town_city` / `county` /
`postcode`, and `latitude` / `longitude`. Also, `service_locations` has *two*
foreign keys to `clients` (`client_id` and `created_by_client_id`), so the client
name embed has to name the constraint explicitly or PostgREST rejects it as
ambiguous.

## Layout

```
api/            Vercel serverless functions — the only code that sees a key
  locations.js    GET  service locations + the default base
  appointments.js GET  a date's appointments, grouped by location
  plan.js         POST the itinerary
  staticmap.js    POST route map image bytes (keeps the key off the client)
lib/            Server-side modules
  schedule.js     Itinerary construction — no I/O, fully unit-tested
  google.js       Routes API client
  time.js         Australia/Melbourne wall-clock ↔ instant conversion
  supabase.js     Service-role client
src/            React app
test/            node:test suites for the scheduling and timezone logic
```

`lib/schedule.js` takes the leg fetcher as an argument, so the scheduling rules
are tested against stubbed legs with no network involved.

## What's next

[`docs/ROADMAP.md`](docs/ROADMAP.md) is the prioritised enhancement plan —
what to build next, in what order, and why. The two items at the top are
authenticating the API (it is currently open) and honouring each stop's booked
appointment time rather than only the first one's.

## Not built (from the brief's nice-to-haves)

- **Saving a planned route back to Supabase.** Needs a new table in the
  production database; worth agreeing on the shape first.
- **"Optimise stop order" (TSP).** Off-by-default reordering was explicitly not
  needed for v1.

The map preview and a print view *are* included.

## Security note

Two things worth acting on:

1. **This app's own `api/*` endpoints are unauthenticated.** `GET
   /api/locations` returns every client's name, address and access notes, and
   `/api/plan` and `/api/staticmap` spend the Google Maps key — none of the
   handlers checks a session. `THC_USER_ID` scopes rows to one operator; it
   does not authenticate anyone. This is the first item in
   [`docs/ROADMAP.md`](docs/ROADMAP.md); until it is fixed, Vercel Deployment
   Protection is the ten-minute mitigation.
2. **`db-proxy` is an unauthenticated service-role SQL endpoint.** It is
   deployed with `verify_jwt: false` and `Access-Control-Allow-Origin: *`, and it
   forwards an arbitrary `sql` parameter to an `execute_sql` RPC using the
   service-role key. Anyone who knows the URL can read or write any table,
   bypassing RLS. Worth putting behind a shared secret or JWT verification, or
   removing if nothing depends on it. (Pre-existing, not introduced here — and
   still deployed as of August 2026.)

`fuel_cost_calculations` used to be listed here as having RLS disabled. It is
now enabled, so that item is resolved.
