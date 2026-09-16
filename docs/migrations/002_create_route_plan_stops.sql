-- Flattened stops for a saved route plan. One row per stop on a saved run.
--
-- Apply once, in the Supabase SQL editor for the hoof-tracker project, after
-- 001_create_route_plans.sql. Additive and owned by this app, same as
-- route_plans - but note this is no longer the *only* table the app owns:
-- the Job Costing & Gross Profit module (in the HRM repo) reads this table
-- to apportion vehicle/fuel cost per stop and per job. See that repo's
-- planning notes for how it's used; this app only ever writes it.
--
-- Exists so gross-profit reporting can query/join stops directly (against
-- `appointments`, for cost splitting) instead of unpacking `route_plans.plan`
-- JSONB at query time.

create table if not exists public.route_plan_stops (
  id uuid primary key default gen_random_uuid(),
  route_plan_id uuid not null references public.route_plans(id) on delete cascade,

  sequence integer not null,
  service_location_id uuid not null references public.service_locations(id),

  -- The appointments this stop covered, as recorded when the run was saved -
  -- a snapshot, not a live join, so a booking edited or cancelled later does
  -- not silently change a historical trim run's numbers.
  appointment_ids uuid[] not null default '{}',

  -- This stop's share of the route's total distance/time, for the weighted
  -- vehicle/fuel cost split. Leaving-this-stop leg (`legToNext`), plus the
  -- leave-base leg (`legToFirstStop`) folded into sequence 0 - that is the
  -- one leg with no stop of its own to attach to, and folding it into the
  -- first stop is what makes these columns sum to route_plans.total_distance_m
  -- / total_driving_seconds exactly, across every stop on the run.
  leg_distance_m integer,
  leg_duration_s integer,

  on_site_minutes integer,
  arrival_at timestamptz,
  departure_at timestamptz,

  created_at timestamptz not null default now(),

  unique (route_plan_id, sequence)
);

comment on table public.route_plan_stops is
  'Flattened stops for a saved route plan, one row per stop. Written by the THC Route Planner; read by the Job Costing & Gross Profit module for cost apportionment.';

create index if not exists route_plan_stops_route_plan_id_idx
  on public.route_plan_stops (route_plan_id, sequence);

alter table public.route_plan_stops enable row level security;

-- A stop row is meaningless without its parent run, so ownership is checked
-- via route_plans.user_id rather than duplicating a user_id column here.
drop policy if exists "Owners read their own route plan stops" on public.route_plan_stops;
create policy "Owners read their own route plan stops"
  on public.route_plan_stops for select
  to authenticated
  using (exists (
    select 1 from public.route_plans rp
    where rp.id = route_plan_stops.route_plan_id
      and rp.user_id = auth.uid()
  ));

drop policy if exists "Owners create their own route plan stops" on public.route_plan_stops;
create policy "Owners create their own route plan stops"
  on public.route_plan_stops for insert
  to authenticated
  with check (exists (
    select 1 from public.route_plans rp
    where rp.id = route_plan_stops.route_plan_id
      and rp.user_id = auth.uid()
  ));

drop policy if exists "Owners delete their own route plan stops" on public.route_plan_stops;
create policy "Owners delete their own route plan stops"
  on public.route_plan_stops for delete
  to authenticated
  using (exists (
    select 1 from public.route_plans rp
    where rp.id = route_plan_stops.route_plan_id
      and rp.user_id = auth.uid()
  ));

-- No update policy: a re-plan replaces a run's stops wholesale (delete then
-- re-insert, same as api/plans.js does for the parent row), rather than
-- updating rows in place.
