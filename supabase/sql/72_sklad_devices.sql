-- =====================================================================================================================
-- Update 72 — "Sklad v Cacaduu", phase F: Zariadenia (2026-11-02, design screen 15, approved by the owner: "ok")
--
-- A phone (a shop assistant's, the counter's spare phone) joins ONE shop's Sklad without the owner's password:
--   * Sklad → Nastavenia → Zariadenia → "Pripojiť telefón (QR kód)": a name ("Telefón 2 · Jana") and what it may do —
--     'sale' (Predaj), 'receive' (Príjem tovaru: pieces only, never a purchase price), 'counts' (counting in an open
--     Inventúra), 'terminal' (the QR terminal). A pairing code (skp_ + 64 hex) is shown once as a QR code: 10 minutes,
--     once, only its hash kept (owner_sklad_device_add / owner_sklad_device_code).
--   * The phone sends the code (sklad_device_claim) and gets its key (skt_ + 64 hex) once — the website keeps it in an
--     HttpOnly cookie; the database keeps only its hash. No account, no password.
--   * EVERY call of a phone goes through one door, sklad_device_call(key, function, args): the key (not disconnected,
--     used within 90 days) → a function on the list below and allowed by the phone's ticks → 120 calls a minute → acts
--     as the owner who paired it (still a member of the shop) so every owner_sklad_* rule runs as on the website → the
--     shop is ALWAYS the phone's own (p_shop_id forced), the device name is forced on sales, receipts and counts →
--     purchase prices, suppliers, margins and values are removed from every answer (sklad_device_strip).
--   * "Odpojiť" (owner_sklad_device_revoke) works at once; "Nový kód" pairs another phone and disconnects the old one.
-- ≤ 10 phones per shop. Tables: RLS, service role only. Needs updates 61 (mcp_random, mcp_act_as) and 67–71.
-- Safe to run twice.
-- =====================================================================================================================

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['sklad_device_saved', 'sklad_device_paired', 'sklad_device_revoked'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

create table if not exists public.sklad_devices (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  perms         text[] not null check (cardinality(perms) between 1 and 4
                                       and perms <@ array['sale', 'receive', 'counts', 'terminal']::text[]),
  pair_hash     text unique,
  pair_expires  timestamptz,
  token_hash    text unique,
  paired_at     timestamptz,
  last_seen_at  timestamptz,
  created_by    uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index if not exists sklad_devices_shop_idx on public.sklad_devices (shop_id, created_at);

create table if not exists public.sklad_device_hits (
  device_id  uuid not null references public.sklad_devices (id) on delete cascade,
  minute     timestamptz not null,
  n          integer not null default 0,
  primary key (device_id, minute)
);

do $$
declare t text;
begin
  foreach t in array array['sklad_devices', 'sklad_device_hits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ 1. helpers

create or replace function public.sklad_device_hash(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to('ppi-skd:' || coalesce(p_value, ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.sklad_device_hash(text) from public, anon, authenticated;

/** The ticks, cleaned: known ones only, each once, in a fixed order; none → 'perms'. */
create or replace function public.sklad_device_perms(p_perms text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text[] := array(select x from unnest(array['sale', 'receive', 'counts', 'terminal']) x where x = any (coalesce(p_perms, '{}')));
begin
  if cardinality(v) = 0 or exists (select 1 from unnest(coalesce(p_perms, '{}')) y where y <> all (array['sale', 'receive', 'counts', 'terminal'])) then
    raise exception 'perms' using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke execute on function public.sklad_device_perms(text[]) from public, anon, authenticated;

/** Which ticks allow a function (NULL = never for a phone). */
create or replace function public.sklad_device_need(p_fn text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_fn
    when 'owner_sklad_products' then array['sale', 'receive', 'counts']
    when 'owner_sklad_find' then array['sale', 'receive', 'counts']
    when 'owner_sklad_sale_info' then array['sale']
    when 'owner_sklad_sell' then array['sale']
    when 'owner_sklad_sale' then array['sale', 'terminal']
    when 'owner_sklad_sale_paid' then array['sale', 'terminal']
    when 'owner_sklad_sale_cancel' then array['sale', 'terminal']
    when 'owner_sklad_terminal' then array['terminal']
    when 'owner_sklad_move' then array['receive']
    when 'owner_sklad_counts' then array['counts']
    when 'owner_sklad_count' then array['counts']
    when 'owner_sklad_count_set' then array['counts']
    when 'owner_sklad_count_item' then array['counts']
  end
$$;
revoke execute on function public.sklad_device_need(text) from public, anon, authenticated;

/** Every purchase price, supplier, margin and value out of an answer, at every depth. */
create or replace function public.sklad_device_strip(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null then return null; end if;
  if jsonb_typeof(p) = 'object' then
    return coalesce((select jsonb_object_agg(k, public.sklad_device_strip(v)) from jsonb_each(p) e(k, v)
                     where k <> all (array['last_cost', 'last_cost_at', 'avg_cost', 'unit_cost', 'cost', 'margin',
                                           'margin_pct', 'supplier', 'suppliers', 'value', 'stock_value', 'purchase'])),
                    '{}'::jsonb);
  elsif jsonb_typeof(p) = 'array' then
    return coalesce((select jsonb_agg(public.sklad_device_strip(v) order by n) from jsonb_array_elements(p) with ordinality x(v, n)),
                    '[]'::jsonb);
  end if;
  return p;
end;
$$;
revoke execute on function public.sklad_device_strip(jsonb) from public, anon, authenticated;

/** The phone of a key, checked: not disconnected, used within 90 days, its owner still a member. Then acts as the owner. */
create or replace function public.sklad_device_open(p_token text)
returns public.sklad_devices
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.sklad_devices;
begin
  if p_token is null or p_token !~ '^skt_[0-9a-f]{64}$' then raise exception 'device' using errcode = '28000'; end if;
  select * into d from public.sklad_devices where token_hash = public.sklad_device_hash(p_token) and revoked_at is null;
  if d.id is null then raise exception 'device' using errcode = '28000'; end if;
  if coalesce(d.last_seen_at, d.paired_at, d.created_at) < now() - interval '90 days' then
    raise exception 'device_expired' using errcode = '28000';
  end if;
  perform public.mcp_act_as(d.created_by);
  if not public.is_shop_member(d.shop_id) then raise exception 'device' using errcode = '28000'; end if;
  if d.last_seen_at is null or d.last_seen_at < now() - interval '1 minute' then
    update public.sklad_devices set last_seen_at = now() where id = d.id;
  end if;
  return d;
end;
$$;
revoke execute on function public.sklad_device_open(text) from public, anon, authenticated;

-- ------------------------------------------------------------------ 2. the owner's side

create or replace function public.sklad_device_new_code(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := public.mcp_random('skp_');
  v_exp timestamptz := now() + interval '10 minutes';
begin
  update public.sklad_devices
  set pair_hash = public.sklad_device_hash(v_code), pair_expires = v_exp, token_hash = null, paired_at = null
  where id = p_id;
  return jsonb_build_object('id', p_id, 'code', v_code, 'expires', v_exp);
end;
$$;
revoke execute on function public.sklad_device_new_code(uuid) from public, anon, authenticated;

/** "Pripojiť telefón (QR kód)": a new phone (≤ 10 per shop) and its pairing code, shown once. */
create or replace function public.owner_sklad_device_add(p_shop_id uuid, p_name text, p_perms text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 60);
  v_perms text[];
  v_id uuid;
begin
  perform public.sklad_member(p_shop_id);
  if v_name = '' then raise exception 'name' using errcode = '22023'; end if;
  v_perms := public.sklad_device_perms(p_perms);
  perform pg_advisory_xact_lock(hashtextextended('sklad-devices:' || p_shop_id::text, 0));
  if (select count(*) from public.sklad_devices where shop_id = p_shop_id and revoked_at is null) >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.sklad_devices (shop_id, name, perms, created_by)
  values (p_shop_id, v_name, v_perms, auth.uid())
  returning id into v_id;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_device_saved', jsonb_build_object('device', v_id, 'perms', v_perms));
  return public.sklad_device_new_code(v_id);
end;
$$;
revoke execute on function public.owner_sklad_device_add(uuid, text, text[]) from public, anon;
grant execute on function public.owner_sklad_device_add(uuid, text, text[]) to authenticated;

/** "Nový kód": pairs another phone under this name; the phone paired before is disconnected. */
create or replace function public.owner_sklad_device_code(p_shop_id uuid, p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  if not exists (select 1 from public.sklad_devices where id = p_id and shop_id = p_shop_id and revoked_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.sklad_devices set created_by = auth.uid() where id = p_id;
  return public.sklad_device_new_code(p_id);
end;
$$;
revoke execute on function public.owner_sklad_device_code(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_device_code(uuid, uuid) to authenticated;

create or replace function public.owner_sklad_device_save(p_shop_id uuid, p_id uuid, p_name text, p_perms text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 60);
  v_perms text[];
begin
  perform public.sklad_member(p_shop_id);
  if v_name = '' then raise exception 'name' using errcode = '22023'; end if;
  v_perms := public.sklad_device_perms(p_perms);
  update public.sklad_devices set name = v_name, perms = v_perms
  where id = p_id and shop_id = p_shop_id and revoked_at is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_device_saved', jsonb_build_object('device', p_id, 'perms', v_perms));
end;
$$;
revoke execute on function public.owner_sklad_device_save(uuid, uuid, text, text[]) from public, anon;
grant execute on function public.owner_sklad_device_save(uuid, uuid, text, text[]) to authenticated;

/** "Odpojiť": the phone's key stops working at once (the row stays for the movements' history). */
create or replace function public.owner_sklad_device_revoke(p_shop_id uuid, p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  update public.sklad_devices set revoked_at = now(), token_hash = null, pair_hash = null, pair_expires = null
  where id = p_id and shop_id = p_shop_id and revoked_at is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_device_revoked', jsonb_build_object('device', p_id));
end;
$$;
revoke execute on function public.owner_sklad_device_revoke(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_device_revoke(uuid, uuid) to authenticated;

/** The shop's phones: name, ticks and state (waiting for its code · online · last seen · code expired · unused 90 days). */
create or replace function public.owner_sklad_devices(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'perms', to_jsonb(d.perms), 'paired_at', d.paired_at, 'last_seen_at', d.last_seen_at,
      'state', case
        when d.token_hash is null and d.pair_hash is not null and d.pair_expires > now() then 'waiting'
        when d.token_hash is null then 'no_phone'
        when coalesce(d.last_seen_at, d.paired_at) < now() - interval '90 days' then 'expired'
        when d.last_seen_at > now() - interval '5 minutes' then 'online'
        else 'idle' end) order by d.created_at)
    from public.sklad_devices d where d.shop_id = p_shop_id and d.revoked_at is null), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_sklad_devices(uuid) from public, anon;
grant execute on function public.owner_sklad_devices(uuid) to authenticated;

-- ------------------------------------------------------------------ 3. the phone's side (anon: the key is the login)

/** The phone sends its pairing code once: its key back (shown once, only its hash kept). */
create or replace function public.sklad_device_claim(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text := public.mcp_random('skt_');
  d public.sklad_devices;
begin
  if p_code is null or p_code !~ '^skp_[0-9a-f]{64}$' then raise exception 'code' using errcode = '22023'; end if;
  update public.sklad_devices
  set token_hash = public.sklad_device_hash(v_token), pair_hash = null, pair_expires = null, paired_at = now(),
      last_seen_at = now()
  where pair_hash = public.sklad_device_hash(p_code) and pair_expires > now() and revoked_at is null
  returning * into d;
  if d.id is null then raise exception 'code' using errcode = '22023'; end if;
  insert into public.shop_activity (shop_id, action, details)
  values (d.shop_id, 'sklad_device_paired', jsonb_build_object('device', d.id));
  return jsonb_build_object('token', v_token, 'name', d.name);
end;
$$;
revoke execute on function public.sklad_device_claim(text) from public;
grant execute on function public.sklad_device_claim(text) to anon, authenticated;

/** What the phone may show: its name, ticks, the shop and where its stock goes. */
create or replace function public.sklad_device_whoami(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.sklad_devices := public.sklad_device_open(p_token);
  s public.shops;
begin
  select * into s from public.shops where id = d.shop_id;
  return jsonb_build_object(
    'id', d.id, 'name', d.name, 'perms', to_jsonb(d.perms),
    'shop', jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'timezone', s.timezone),
    'source', public.stock_source_of(d.shop_id),
    'sale_source', coalesce((select sale_source from public.sklad_settings where shop_id = d.shop_id), 'predaj'),
    'receipt_location', (select name from public.sklad_locations where id = public.sklad_default_location(d.shop_id, true)));
end;
$$;
revoke execute on function public.sklad_device_whoami(text) from public;
grant execute on function public.sklad_device_whoami(text) to anon, authenticated;

/** "Odpojiť toto zariadenie" on the phone itself. */
create or replace function public.sklad_device_forget(p_token text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.sklad_devices;
begin
  if p_token is null or p_token !~ '^skt_[0-9a-f]{64}$' then return; end if;
  update public.sklad_devices set token_hash = null
  where token_hash = public.sklad_device_hash(p_token)
  returning * into d;
  if d.id is not null then
    insert into public.shop_activity (shop_id, action, details)
    values (d.shop_id, 'sklad_device_revoked', jsonb_build_object('device', d.id, 'by', 'device'));
  end if;
end;
$$;
revoke execute on function public.sklad_device_forget(text) from public;
grant execute on function public.sklad_device_forget(text) to anon, authenticated;

/**
 * The one door of a phone: a function from the list (sklad_device_need) allowed by its ticks, its own shop, its own
 * name, 120 calls a minute, as the owner who paired it; the answer without purchase prices, suppliers or values.
 * Named arguments only, each by the function's own argument names and types.
 */
create or replace function public.sklad_device_call(p_token text, p_fn text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.sklad_devices := public.sklad_device_open(p_token);
  v_need text[] := public.sklad_device_need(p_fn);
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_n integer;
  v_proc record;
  v_parts text[] := '{}';
  v_type text;
  v_name text;
  v_out jsonb;
  i integer;
begin
  if v_need is null or not (d.perms && v_need) then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(v_args) <> 'object' then raise exception 'bad_argument' using errcode = '22023'; end if;

  insert into public.sklad_device_hits (device_id, minute, n) values (d.id, date_trunc('minute', now()), 1)
  on conflict (device_id, minute) do update set n = public.sklad_device_hits.n + 1
  returning n into v_n;
  if v_n > 120 then raise exception 'too_many' using errcode = '54000'; end if;
  delete from public.sklad_device_hits where device_id = d.id and minute < now() - interval '10 minutes';

  -- the phone's own shop and name, always
  v_args := v_args || jsonb_build_object('p_shop_id', d.shop_id);
  if p_fn in ('owner_sklad_sell', 'owner_sklad_move') then v_args := v_args || jsonb_build_object('p_device', d.name); end if;
  if p_fn in ('owner_sklad_count', 'owner_sklad_count_set') then v_args := v_args || jsonb_build_object('p_counter', d.name); end if;
  -- "Príjem tovaru": pieces only — no purchase price, no other kind of movement
  if p_fn = 'owner_sklad_move' then
    if v_args ->> 'p_kind' is distinct from 'receipt' then raise exception 'forbidden' using errcode = '42501'; end if;
    v_args := v_args - 'p_unit_cost' - 'p_to_location_id';
  end if;

  select p.proname, p.proargnames, array(select t from unnest(p.proargtypes::oid[]) with ordinality u(t, n) order by n) as types,
         p.prorettype into v_proc
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = p_fn
  order by p.pronargs desc
  limit 1;
  if v_proc.proname is null then raise exception 'forbidden' using errcode = '42501'; end if;
  for i in 1 .. coalesce(array_length(v_proc.proargnames, 1), 0) loop
    v_name := v_proc.proargnames[i];
    continue when not (v_args ? v_name);
    v_type := format_type(v_proc.types[i], null);
    if v_type = 'jsonb' then
      v_parts := v_parts || format('%I => ($1 -> %L)', v_name, v_name);
    else
      v_parts := v_parts || format('%I => ($1 ->> %L)::%s', v_name, v_name, v_type);
    end if;
  end loop;
  if v_proc.prorettype = 'void'::regtype then
    execute format('select public.%I(%s)', p_fn, array_to_string(v_parts, ', ')) using v_args;
    v_out := 'null'::jsonb;
  else
    execute format('select to_jsonb(public.%I(%s))', p_fn, array_to_string(v_parts, ', ')) into v_out using v_args;
  end if;
  return public.sklad_device_strip(v_out);
end;
$$;
revoke execute on function public.sklad_device_call(text, text, jsonb) from public;
grant execute on function public.sklad_device_call(text, text, jsonb) to anon, authenticated;
