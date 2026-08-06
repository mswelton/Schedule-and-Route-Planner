-- Saved route-planner itineraries. One row per planned run.
--
-- Apply once, in the Supabase SQL editor for the hoof-tracker project. It is
-- additive: nothing else in the schema references this table, so dropping it
-- again touches no practice data.
--
-- Until it exists, "Save this run" returns an error naming this file.

create table if not exists public.route_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,

  run_date date not null,
  base_label text,
  base_address text,

  -- Totals are lifted out of the itinerary so a run can be listed and reported
  -- on without unpacking the JSON.
  stop_count integer not null,
  total_distance_m integer not null,
  total_driving_seconds integer not null,
  total_on_site_minutes integer not null,
  day_length_seconds integer not null,
  leave_base_clock text,
  return_to_base_clock text,

  -- The full itinerary exactly as /api/plan returned it, so a saved run can be
  -- reopened and rendered without recomputing — or re-paying for — anything.
  plan jsonb not null,

  created_at timestamptz not null default now()
);

comment on table public.route_plans is
  'Saved route-planner itineraries, one row per planned run. Owned by the THC Route Planner; no other table references it.';

create index if not exists route_plans_user_run_date_idx
  on public.route_plans (user_id, run_date desc, created_at desc);

alter table public.route_plans enable row level security;

-- Scoped to the owner. Note the contrast with the older
-- fuel_cost_calculations policies, which grant anon everything via
-- USING (true) — that is what "RLS enabled" should *not* look like.
drop policy if exists "Owners read their own route plans" on public.route_plans;
create policy "Owners read their own route plans"
  on public.route_plans for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Owners create their own route plans" on public.route_plans;
create policy "Owners create their own route plans"
  on public.route_plans for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Owners update their own route plans" on public.route_plans;
create policy "Owners update their own route plans"
  on public.route_plans for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Owners delete their own route plans" on public.route_plans;
create policy "Owners delete their own route plans"
  on public.route_plans for delete
  to authenticated
  using (auth.uid() = user_id);
