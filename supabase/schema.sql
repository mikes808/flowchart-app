-- Flowchart app database
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- It is safe to run again; it replaces the rules without deleting any charts.

create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists public.charts (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  owner_email text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  title       text not null default 'Untitled flowchart',
  data        jsonb not null default '{}'::jsonb,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists charts_owner_idx on public.charts (owner);

-- People a chart is shared with, by email (they can be invited before they sign up).
create table if not exists public.chart_shares (
  chart_id   uuid not null references public.charts (id) on delete cascade,
  email      text not null check (email = lower(email) and position('@' in email) > 1),
  role       text not null default 'viewer' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (chart_id, email)
);
create index if not exists chart_shares_email_idx on public.chart_shares (email);

-- ---------- Helpers ----------
-- The signed-in person's email, lowercased.
create or replace function public.my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

-- Lookups used by the access rules. security definer so the two tables' rules
-- can check each other without looping.
create or replace function public.shared_role(cid uuid) returns text
language sql stable security definer set search_path = public as $$
  select s.role from chart_shares s where s.chart_id = cid and s.email = public.my_email()
$$;
create or replace function public.is_chart_owner(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from charts c where c.id = cid and c.owner = auth.uid())
$$;
revoke all on function public.shared_role(uuid) from public;
revoke all on function public.is_chart_owner(uuid) from public;
grant execute on function public.shared_role(uuid) to authenticated;
grant execute on function public.is_chart_owner(uuid) to authenticated;
drop function if exists public.chart_role(uuid);

-- Keep owner fixed, bump timestamps on every save.
create or replace function public.charts_before_update() returns trigger
language plpgsql as $$
begin
  new.owner := old.owner;
  new.owner_email := old.owner_email;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists charts_before_update on public.charts;
create trigger charts_before_update before update on public.charts
  for each row execute function public.charts_before_update();

-- New charts always belong to whoever creates them.
create or replace function public.charts_before_insert() returns trigger
language plpgsql as $$
begin
  new.owner := auth.uid();
  new.owner_email := public.my_email();
  new.version := 1;
  return new;
end $$;
drop trigger if exists charts_before_insert on public.charts;
create trigger charts_before_insert before insert on public.charts
  for each row execute function public.charts_before_insert();

-- Store share emails lowercased.
create or replace function public.shares_normalize() returns trigger
language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;
drop trigger if exists shares_normalize on public.chart_shares;
create trigger shares_normalize before insert or update on public.chart_shares
  for each row execute function public.shares_normalize();

-- ---------- Access rules ----------
alter table public.charts enable row level security;
alter table public.chart_shares enable row level security;

drop policy if exists "read own or shared charts" on public.charts;
create policy "read own or shared charts" on public.charts
  for select to authenticated using (owner = auth.uid() or public.shared_role(id) is not null);

drop policy if exists "create own charts" on public.charts;
create policy "create own charts" on public.charts
  for insert to authenticated with check (auth.uid() is not null);

drop policy if exists "owners and editors save" on public.charts;
create policy "owners and editors save" on public.charts
  for update to authenticated
  using (owner = auth.uid() or public.shared_role(id) = 'editor')
  with check (owner = auth.uid() or public.shared_role(id) = 'editor');

drop policy if exists "owners delete" on public.charts;
create policy "owners delete" on public.charts
  for delete to authenticated using (owner = auth.uid());

drop policy if exists "see shares on my charts or my own invites" on public.chart_shares;
create policy "see shares on my charts or my own invites" on public.chart_shares
  for select to authenticated
  using (public.is_chart_owner(chart_id) or email = public.my_email());

drop policy if exists "owners add shares" on public.chart_shares;
create policy "owners add shares" on public.chart_shares
  for insert to authenticated with check (public.is_chart_owner(chart_id));

drop policy if exists "owners change shares" on public.chart_shares;
create policy "owners change shares" on public.chart_shares
  for update to authenticated
  using (public.is_chart_owner(chart_id))
  with check (public.is_chart_owner(chart_id));

drop policy if exists "owners remove shares, people leave" on public.chart_shares;
create policy "owners remove shares, people leave" on public.chart_shares
  for delete to authenticated
  using (public.is_chart_owner(chart_id) or email = public.my_email());

grant select, insert, update, delete on public.charts, public.chart_shares to authenticated;
revoke all on public.charts, public.chart_shares from anon;
