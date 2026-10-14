-- PPI · 34 · The main chat's product search in layers (Prompt 11, phase A): Cacadoo first, then shops nearby
--  (OpenStreetMap; optionally Google Places), then the web (Claude's web search on the allowed shop websites).
--  Paste the whole file into the Supabase SQL Editor and Run. Safe to run again.
--  - search_layers: a switch per outside layer (osm, google_places, web) and its estimated price per call (and per
--    million tokens for the web search), set by the admin. A layer runs only when the admin switch AND the function's
--    environment switch (WEB_SEARCH_ENABLED, GOOGLE_PLACES_ENABLED) are on.
--  - web_search_domains: the shop websites the web search may use (allowed_domains) with an optional search address
--    ("https://www.<shop>/search?q={query}") for the deep links. Admin only.
--  - external_search_usage: every outside call per day, layer and service with its estimated cost; the daily limit
--    (EXTERNAL_SEARCH_DAILY_LIMIT) is counted here by external_search_claim().
--  - town_geocodes (kept for good: towns do not move) and osm_shop_cache (24 hours per town and category): the
--    answers of Nominatim and Overpass, so OpenStreetMap is asked as rarely as possible; external_slot() keeps
--    Nominatim at one request per second for the whole site.
--  - Nothing from Google is stored (not even place ids) and no web result is stored: they live only in the chat in
--    the shopper's browser. No visitor data anywhere: only the question's town and product went out.
--  Every new table has RLS on and no grant for visitors or owners; the product-sources Edge Function (service role)
--  reads and writes them, the admin reads and changes them only through the admin_* functions below (is_admin()).

-- ------------------------------------------------------------------ 1. Layers and their switches

create table if not exists public.search_layers (
  layer               text primary key,
  enabled             boolean not null default true,
  cost_per_call_usd   numeric(10, 5) not null default 0,
  input_usd_per_mtok  numeric(10, 4) not null default 0,
  output_usd_per_mtok numeric(10, 4) not null default 0,
  updated_at          timestamptz not null default now(),
  constraint search_layers_layer check (layer in ('osm', 'google_places', 'web')),
  constraint search_layers_costs check (
    cost_per_call_usd between 0 and 10 and input_usd_per_mtok between 0 and 1000 and output_usd_per_mtok between 0 and 1000)
);
-- Estimates the admin can change: OpenStreetMap is free; Google Nearby Search (Pro fields) per Google's price list;
-- the web search $10 per 1,000 searches plus the model's tokens (Claude Haiku: $0.10 / $0.50 per million).
insert into public.search_layers (layer, enabled, cost_per_call_usd, input_usd_per_mtok, output_usd_per_mtok) values
  ('osm', true, 0, 0, 0),
  ('google_places', true, 0.032, 0, 0),
  ('web', true, 0.01, 0.10, 0.50)
on conflict (layer) do nothing;

alter table public.search_layers enable row level security;
revoke all on public.search_layers from public, anon, authenticated;
grant all on public.search_layers to service_role;

-- ------------------------------------------------------------------ 2. Allowed web domains and deep links

-- "decathlon.sk" or "example.com/shop": lower-case ASCII only (no look-alike letters), no scheme, no wildcard.
create or replace function public.valid_web_domain(p_domain text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_domain is not null and char_length(p_domain) <= 200
    and p_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}(/[a-z0-9._~%-]+)*$'
$$;

-- A deep link template: https on the shop's own host (or a subdomain of it) with {query} exactly once.
create or replace function public.valid_search_url(p_url text, p_domain text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url is not null and char_length(p_url) <= 500
    and p_url ~ '^https://[a-z0-9.-]+(:[0-9]{2,5})?(/[^[:space:]<>"''\\]*)?$'
    and (char_length(p_url) - char_length(replace(p_url, '{query}', ''))) = 7
    and (
      substring(p_url from '^https://([a-z0-9.-]+)') = split_part(p_domain, '/', 1)
      or substring(p_url from '^https://([a-z0-9.-]+)') like '%.' || split_part(p_domain, '/', 1)
    )
$$;

create table if not exists public.web_search_domains (
  domain     text primary key,
  label      text not null,
  search_url text,
  enabled    boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint web_search_domains_domain check (public.valid_web_domain(domain)),
  constraint web_search_domains_label check (char_length(label) between 1 and 60),
  constraint web_search_domains_search_url check (search_url is null or public.valid_search_url(search_url, domain)),
  constraint web_search_domains_sort check (sort_order between 0 and 10000)
);
-- The larger retailers from the brief. Their search addresses are left for the admin to add (Predplatné a domény →
-- "Webové domény"): copy a search result's address from the shop's own website and put {query} where the word was.
insert into public.web_search_domains (domain, label, sort_order) values
  ('decathlon.sk', 'Decathlon', 10),
  ('dm.sk', 'dm', 20),
  ('exisport.sk', 'Exisport', 30),
  ('intersport.sk', 'Intersport', 40),
  ('action.com', 'Action', 50)
on conflict (domain) do nothing;

alter table public.web_search_domains enable row level security;
revoke all on public.web_search_domains from public, anon, authenticated;
grant all on public.web_search_domains to service_role;

-- ------------------------------------------------------------------ 3. Outside calls per day (the daily limit)

create table if not exists public.external_search_usage (
  day      date not null,
  layer    text not null,
  service  text not null,
  calls    integer not null default 0,
  cost_usd numeric(12, 5) not null default 0,
  primary key (day, layer, service),
  constraint external_search_usage_layer check (layer in ('geocode', 'osm', 'google_places', 'web')),
  constraint external_search_usage_service check (service in ('nominatim', 'overpass', 'google_places', 'web_search')),
  constraint external_search_usage_counts check (calls >= 0 and cost_usd >= 0)
);
alter table public.external_search_usage enable row level security;
revoke all on public.external_search_usage from public, anon, authenticated;
grant all on public.external_search_usage to service_role;

-- One outside call, if today's calls of all layers together are under the limit (UTC day). Counted before the call,
-- so a limit holds even when calls fail. Service role only (the product-sources function).
create or replace function public.external_search_claim(p_layer text, p_service text, p_daily_limit integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_total bigint;
begin
  if p_daily_limit is null or p_daily_limit <= 0 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext('ppi_external_search_claim'));
  select coalesce(sum(calls), 0) into v_total from public.external_search_usage where day = v_today;
  if v_total >= p_daily_limit then
    return false;
  end if;
  insert into public.external_search_usage (day, layer, service, calls) values (v_today, p_layer, p_service, 1)
  on conflict (day, layer, service) do update set calls = public.external_search_usage.calls + 1;
  return true;
end;
$$;
revoke execute on function public.external_search_claim(text, text, integer) from public, anon, authenticated;
grant execute on function public.external_search_claim(text, text, integer) to service_role;

-- The estimated cost of a call, added once its usage is known (the web search: searches + tokens).
create or replace function public.external_search_cost(p_layer text, p_service text, p_cost_usd numeric)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.external_search_usage (day, layer, service, calls, cost_usd)
  values ((now() at time zone 'utc')::date, p_layer, p_service, 0, greatest(coalesce(p_cost_usd, 0), 0))
  on conflict (day, layer, service) do update
  set cost_usd = public.external_search_usage.cost_usd + greatest(coalesce(p_cost_usd, 0), 0)
$$;
revoke execute on function public.external_search_cost(text, text, numeric) from public, anon, authenticated;
grant execute on function public.external_search_cost(text, text, numeric) to service_role;

-- ------------------------------------------------------------------ 4. OpenStreetMap answers and the 1-per-second rule

create table if not exists public.town_geocodes (
  key          text primary key,
  query        text not null,
  name         text,
  lat          double precision,
  lng          double precision,
  country_code text,
  found        boolean not null,
  fetched_at   timestamptz not null default now(),
  constraint town_geocodes_country check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint town_geocodes_point check (
    (not found) or (lat between -90 and 90 and lng between -180 and 180))
);
alter table public.town_geocodes enable row level security;
revoke all on public.town_geocodes from public, anon, authenticated;
grant all on public.town_geocodes to service_role;

create table if not exists public.osm_shop_cache (
  town_key   text not null,
  category   text not null,
  radius_m   integer not null,
  results    jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (town_key, category, radius_m),
  constraint osm_shop_cache_results check (jsonb_typeof(results) = 'array')
);
alter table public.osm_shop_cache enable row level security;
revoke all on public.osm_shop_cache from public, anon, authenticated;
grant all on public.osm_shop_cache to service_role;

-- One town and category's shops from Overpass; answers older than 7 days are cleared on the way (24 hours count).
create or replace function public.osm_cache_put(p_town_key text, p_category text, p_radius_m integer, p_results jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.osm_shop_cache (town_key, category, radius_m, results, fetched_at)
  values (p_town_key, p_category, p_radius_m, p_results, now())
  on conflict (town_key, category, radius_m) do update set results = excluded.results, fetched_at = excluded.fetched_at;
  delete from public.osm_shop_cache where fetched_at < now() - interval '7 days';
end;
$$;
revoke execute on function public.osm_cache_put(text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.osm_cache_put(text, text, integer, jsonb) to service_role;

create table if not exists public.external_throttle (
  service text primary key,
  next_at timestamptz not null
);
alter table public.external_throttle enable row level security;
revoke all on public.external_throttle from public, anon, authenticated;
grant all on public.external_throttle to service_role;

-- Reserves the next request slot of a service (Nominatim: one per second for the whole site) and returns how many
-- milliseconds to wait for it; -1 (nothing reserved) when that would be longer than p_max_wait_ms.
create or replace function public.external_slot(p_service text, p_interval_ms integer, p_max_wait_ms integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_slot timestamptz;
begin
  insert into public.external_throttle (service, next_at) values (p_service, v_now) on conflict (service) do nothing;
  select greatest(next_at, v_now) into v_slot from public.external_throttle where service = p_service for update;
  if v_slot - v_now > make_interval(secs => greatest(p_max_wait_ms, 0) / 1000.0) then
    return -1;
  end if;
  update public.external_throttle set next_at = v_slot + make_interval(secs => greatest(p_interval_ms, 0) / 1000.0)
  where service = p_service;
  return ceil(extract(epoch from (v_slot - v_now)) * 1000)::integer;
end;
$$;
revoke execute on function public.external_slot(text, integer, integer) from public, anon, authenticated;
grant execute on function public.external_slot(text, integer, integer) to service_role;

-- The Cacadoo shops near a point: the nearby list never repeats a shop that is already in Cacadoo.
create or replace function public.cacadoo_shops_near(p_lat double precision, p_lng double precision, p_km double precision)
returns table (id uuid, slug text, name text, lat double precision, lng double precision)
language sql
stable
security definer
set search_path = ''
as $$
  select sh.id, sh.slug, sh.name,
    extensions.st_y(sh.location::extensions.geometry), extensions.st_x(sh.location::extensions.geometry)
  from public.shops sh
  where sh.is_active and sh.location is not null
    and extensions.st_dwithin(
      sh.location,
      extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
      least(greatest(coalesce(p_km, 10), 0.1), 100) * 1000)
  limit 500
$$;
revoke execute on function public.cacadoo_shops_near(double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.cacadoo_shops_near(double precision, double precision, double precision) to service_role;

-- ------------------------------------------------------------------ 5. The admin's sections (is_admin only)

create or replace function public.admin_search_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'layers', (select coalesce(jsonb_agg(to_jsonb(l) order by array_position(array['osm', 'google_places', 'web'], l.layer)), '[]'::jsonb)
               from public.search_layers l),
    'domains', (select coalesce(jsonb_agg(to_jsonb(d) order by d.sort_order, d.domain), '[]'::jsonb)
                from public.web_search_domains d),
    'usage', (select coalesce(jsonb_agg(to_jsonb(u) order by u.day desc, u.layer, u.service), '[]'::jsonb)
              from public.external_search_usage u where u.day > v_today - 14),
    'today_calls', (select coalesce(sum(calls), 0) from public.external_search_usage where day = v_today),
    'today_cost_usd', (select coalesce(sum(cost_usd), 0) from public.external_search_usage where day = v_today));
end;
$$;
revoke execute on function public.admin_search_settings() from public, anon;
grant execute on function public.admin_search_settings() to authenticated;

create or replace function public.admin_save_search_layer(
  p_layer text, p_enabled boolean, p_cost_per_call_usd numeric, p_input_usd_per_mtok numeric, p_output_usd_per_mtok numeric)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if coalesce(p_layer, '') not in ('osm', 'google_places', 'web') or p_enabled is null
     or p_cost_per_call_usd is null or p_cost_per_call_usd not between 0 and 10
     or p_input_usd_per_mtok is null or p_input_usd_per_mtok not between 0 and 1000
     or p_output_usd_per_mtok is null or p_output_usd_per_mtok not between 0 and 1000 then
    raise exception 'layer' using errcode = 'P0001';
  end if;
  insert into public.search_layers (layer, enabled, cost_per_call_usd, input_usd_per_mtok, output_usd_per_mtok, updated_at)
  values (p_layer, p_enabled, p_cost_per_call_usd, p_input_usd_per_mtok, p_output_usd_per_mtok, now())
  on conflict (layer) do update
  set enabled = excluded.enabled, cost_per_call_usd = excluded.cost_per_call_usd,
      input_usd_per_mtok = excluded.input_usd_per_mtok, output_usd_per_mtok = excluded.output_usd_per_mtok, updated_at = now();
end;
$$;
revoke execute on function public.admin_save_search_layer(text, boolean, numeric, numeric, numeric) from public, anon;
grant execute on function public.admin_save_search_layer(text, boolean, numeric, numeric, numeric) to authenticated;

-- Adds or changes one allowed domain: "https://www.Decathlon.sk/" is kept as "www.decathlon.sk"; an empty search
-- address removes the deep link. At most 50 domains.
create or replace function public.admin_save_web_domain(
  p_domain text, p_label text, p_search_url text, p_enabled boolean, p_sort integer)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_domain text := regexp_replace(regexp_replace(lower(trim(coalesce(p_domain, ''))), '^https?://', ''), '/+$', '');
  v_label text := public.plain_text(p_label, 60);
  v_url text := nullif(trim(coalesce(p_search_url, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if not public.valid_web_domain(v_domain) then
    raise exception 'domain' using errcode = 'P0001';
  end if;
  if v_label is null or char_length(v_label) < 1 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  if v_url is not null and not public.valid_search_url(v_url, v_domain) then
    raise exception 'search_url' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.web_search_domains where domain = v_domain)
     and (select count(*) from public.web_search_domains) >= 50 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  insert into public.web_search_domains (domain, label, search_url, enabled, sort_order, updated_at)
  values (v_domain, v_label, v_url, coalesce(p_enabled, true), least(greatest(coalesce(p_sort, 100), 0), 10000), now())
  on conflict (domain) do update
  set label = excluded.label, search_url = excluded.search_url, enabled = excluded.enabled,
      sort_order = excluded.sort_order, updated_at = now();
  return v_domain;
end;
$$;
revoke execute on function public.admin_save_web_domain(text, text, text, boolean, integer) from public, anon;
grant execute on function public.admin_save_web_domain(text, text, text, boolean, integer) to authenticated;

create or replace function public.admin_delete_web_domain(p_domain text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  delete from public.web_search_domains where domain = lower(trim(coalesce(p_domain, '')));
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;
revoke execute on function public.admin_delete_web_domain(text) from public, anon;
grant execute on function public.admin_delete_web_domain(text) to authenticated;
