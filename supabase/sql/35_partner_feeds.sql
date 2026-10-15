-- PPI · 35 · Partner feeds (Prompt 11, phase B): layer 2 of the main chat's search — the product feeds of partner
--  shops (Google Merchant XML/CSV with its local inventory feed, Heureka XML, a plain CSV), between Cacadoo and the
--  shops nearby. Paste the whole file into the Supabase SQL Editor and Run. Safe to run again.
--  - partners: name, logo, the feed (an https address or a file the admin uploaded), its format, an optional local
--    inventory feed (stock per store, Google's format), how often it is read (daily by default), whether the links are
--    affiliate links, the time zone its times are shown in. Admin only (admin_* functions, is_admin()).
--  - partner_stores: the partner's store list with addresses, when the partner gives one (typed in by the admin).
--  - partner_products and partner_store_stock: the feeds' rows exactly as the partner sent them, each with the time
--    of its data (updated_at). Their own tables: never mixed with the shops' stock (shop_items, inventory), never in
--    public_stock, search_stock, the public API or the MCP server.
--  - partner_imports: one row per import, its state between the Edge Function's steps (a big feed is read in parts,
--    one part per call) and its result; the last 10 per partner and kind are kept.
--  - search_partner_products(): the same accent-insensitive search as the shops' items (search_text,
--    matches_all_words, a trigram index). Data older than 48 hours: no availability, only its time. The order never
--    depends on the affiliate flag (or on any payment).
--  - Every new table has RLS on and no grant for visitors or owners; the partner-feeds Edge Function (service role)
--    writes them, visitors read only through search_partner_products().
--  - The job ppi-partner-feeds-tick (every 5 minutes) starts the imports that are due; it uses the Vault secrets
--    ppi_project_url and ppi_assistant_cron (update 22).

-- ------------------------------------------------------------------ 1. Helpers

/** An https address of a real host name (no IP address, no local names), at most 2000 characters. */
create or replace function public.valid_feed_url(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url is not null
    and length(p_url) <= 2000
    and p_url ~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:[0-9]{1,5})?([/?#][^[:space:]<>"]*)?$'
    and lower(substring(p_url from '^https://([^/:?#]+)')) !~ '\.(local|localhost|internal|intranet|lan|home|corp|arpa|test|invalid)$'
$$;
revoke execute on function public.valid_feed_url(text) from public;
grant execute on function public.valid_feed_url(text) to authenticated, service_role;

/** How long until a partner's feed is read again. */
create or replace function public.partner_schedule_interval(p_schedule text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case p_schedule
    when 'hourly' then interval '1 hour'
    when '6h' then interval '6 hours'
    when 'weekly' then interval '7 days'
    else interval '1 day'
  end
$$;
revoke execute on function public.partner_schedule_interval(text) from public;
grant execute on function public.partner_schedule_interval(text) to authenticated, service_role;

-- ------------------------------------------------------------------ 2. Partners and their stores

create table if not exists public.partners (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  logo_path           text,
  feed_url            text,
  feed_file_path      text,
  feed_file_at        timestamptz,
  feed_format         text not null,
  inventory_url       text,
  inventory_file_path text,
  inventory_file_at   timestamptz,
  inventory_format    text,
  currency            text,
  timezone            text not null,
  schedule            text not null default 'daily',
  affiliate           boolean not null default false,
  enabled             boolean not null default true,
  next_run_at         timestamptz not null default now(),
  force_next          boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint partners_name check (char_length(btrim(name)) between 1 and 80 and name !~ '[\x01-\x1f<>]'),
  constraint partners_feed_format check (feed_format in ('google_xml', 'google_csv', 'heureka_xml', 'csv')),
  constraint partners_inventory_format check (inventory_format is null or inventory_format in ('google_local_xml', 'google_local_csv')),
  constraint partners_feed_url check (feed_url is null or public.valid_feed_url(feed_url)),
  constraint partners_inventory_url check (inventory_url is null or public.valid_feed_url(inventory_url)),
  constraint partners_one_feed check (feed_url is null or feed_file_path is null),
  constraint partners_one_inventory check (inventory_url is null or inventory_file_path is null),
  constraint partners_inventory_needs_format check (
    (inventory_url is null and inventory_file_path is null) or inventory_format is not null),
  constraint partners_currency check (currency is null or currency ~ '^[A-Z]{3}$'),
  -- A Heureka feed has no currency of its own: the partner's currency is required.
  constraint partners_heureka_currency check (feed_format <> 'heureka_xml' or currency is not null),
  constraint partners_schedule check (schedule in ('hourly', '6h', 'daily', 'weekly')),
  constraint partners_logo_path check (logo_path is null or logo_path ~ ('^' || id::text || '/logo-[0-9]{13}\.(webp|png|jpg)$')),
  constraint partners_feed_file check (
    feed_file_path is null or feed_file_path ~ ('^' || id::text || '/feed-[0-9]{13}\.(xml|csv|tsv|txt|gz)$')),
  constraint partners_inventory_file check (
    inventory_file_path is null or inventory_file_path ~ ('^' || id::text || '/inventory-[0-9]{13}\.(xml|csv|tsv|txt|gz)$'))
);
alter table public.partners enable row level security;
revoke all on public.partners from public, anon, authenticated;
grant all on public.partners to service_role;

-- The same check as the shops' time zone (update 3): only names Postgres knows.
drop trigger if exists partners_guard_timezone on public.partners;
create trigger partners_guard_timezone
  before insert or update of timezone on public.partners
  for each row execute function public.guard_shop_timezone();

create table if not exists public.partner_stores (
  partner_id  uuid not null references public.partners (id) on delete cascade,
  store_code  text not null,
  name        text not null,
  address     text,
  city        text,
  postal_code text,
  country     text,
  lat         double precision,
  lng         double precision,
  primary key (partner_id, store_code),
  constraint partner_stores_code check (char_length(store_code) between 1 and 64 and store_code !~ '[\x01-\x1f]'),
  constraint partner_stores_name check (char_length(btrim(name)) between 1 and 120 and name !~ '[\x01-\x1f<>]'),
  constraint partner_stores_texts check (
    coalesce(char_length(address), 0) <= 200 and coalesce(char_length(city), 0) <= 100
    and coalesce(char_length(postal_code), 0) <= 20
    and coalesce(address, '') || coalesce(city, '') || coalesce(postal_code, '') !~ '[\x01-\x1f<>]'),
  constraint partner_stores_country check (country is null or country ~ '^[A-Z]{2}$'),
  constraint partner_stores_point check (
    (lat is null and lng is null) or (lat between -90 and 90 and lng between -180 and 180))
);
alter table public.partner_stores enable row level security;
revoke all on public.partner_stores from public, anon, authenticated;
grant all on public.partner_stores to service_role;

-- ------------------------------------------------------------------ 3. The feeds' rows, as the partner sent them

create table if not exists public.partner_products (
  partner_id         uuid not null references public.partners (id) on delete cascade,
  item_id            text not null,
  title              text not null,
  brand              text,
  gtin               text,
  mpn                text,
  category           text,
  price              numeric(14, 4),
  sale_price         numeric(14, 4),
  sale_from          timestamptz,
  sale_to            timestamptz,
  currency           text,
  -- The availability as the feed wrote it ("in_stock", "in stock", "0", "2026-10-20"), and what it means.
  availability       text,
  availability_state text not null default 'unknown',
  availability_days  integer,
  link               text,
  image_link         text,
  search_blob        text generated always as (
    public.search_text(title || ' ' || coalesce(brand, '') || ' ' || coalesce(gtin, '') || ' ' || coalesce(mpn, ''))) stored,
  import_id          uuid not null,
  -- The time of the data: when the partner's server says the feed was made (Last-Modified), else when it was
  -- read; for an uploaded file, when it was uploaded.
  updated_at         timestamptz not null,
  -- When one of its values last changed.
  changed_at         timestamptz not null default now(),
  primary key (partner_id, item_id),
  constraint partner_products_item check (char_length(item_id) between 1 and 200),
  constraint partner_products_title check (char_length(title) between 1 and 500),
  constraint partner_products_texts check (
    coalesce(char_length(brand), 0) <= 200 and coalesce(char_length(gtin), 0) <= 50
    and coalesce(char_length(mpn), 0) <= 100 and coalesce(char_length(category), 0) <= 500
    and coalesce(char_length(availability), 0) <= 100),
  constraint partner_products_price check ((price is null or price >= 0) and (sale_price is null or sale_price >= 0)),
  constraint partner_products_currency check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint partner_products_state check (
    availability_state in ('in_stock', 'out_of_stock', 'preorder', 'backorder', 'in_days', 'unknown')),
  constraint partner_products_days check (availability_days is null or availability_days between 0 and 3650),
  constraint partner_products_links check (
    (link is null or (length(link) <= 2000 and link ~* '^https?://[^[:space:]<>"]+$'))
    and (image_link is null or (length(image_link) <= 2000 and image_link ~* '^https://[^[:space:]<>"]+$')))
);
alter table public.partner_products enable row level security;
revoke all on public.partner_products from public, anon, authenticated;
grant all on public.partner_products to service_role;
create index if not exists partner_products_search_idx
  on public.partner_products using gin (search_blob extensions.gin_trgm_ops);
create index if not exists partner_products_gtin_idx on public.partner_products (gtin) where gtin is not null;
create index if not exists partner_products_import_idx on public.partner_products (partner_id, import_id);

-- Stock per store: only from the partner's local inventory feed, never guessed.
create table if not exists public.partner_store_stock (
  partner_id         uuid not null references public.partners (id) on delete cascade,
  item_id            text not null,
  store_code         text not null,
  availability       text,
  availability_state text not null default 'unknown',
  quantity           numeric(14, 3),
  import_id          uuid not null,
  updated_at         timestamptz not null,
  primary key (partner_id, item_id, store_code),
  constraint partner_store_stock_ids check (char_length(item_id) between 1 and 200 and char_length(store_code) between 1 and 64),
  constraint partner_store_stock_text check (coalesce(char_length(availability), 0) <= 100),
  constraint partner_store_stock_state check (
    availability_state in ('in_stock', 'limited', 'out_of_stock', 'on_display', 'preorder', 'backorder', 'unknown'))
);
alter table public.partner_store_stock enable row level security;
revoke all on public.partner_store_stock from public, anon, authenticated;
grant all on public.partner_store_stock to service_role;
create index if not exists partner_store_stock_import_idx on public.partner_store_stock (partner_id, import_id);

-- ------------------------------------------------------------------ 4. Imports

create table if not exists public.partner_imports (
  id              uuid primary key default gen_random_uuid(),
  partner_id      uuid not null references public.partners (id) on delete cascade,
  kind            text not null,
  source          text not null,
  -- The address or file and format this import read: a conditional request (If-Modified-Since) only for the same.
  source_key      text not null,
  force           boolean not null default false,
  status          text not null default 'download',
  error           text,
  error_detail    text,
  feed_time       timestamptz,
  source_modified text,
  etag            text,
  bytes           bigint not null default 0,
  parts           integer not null default 0,
  part_index      integer not null default 0,
  carry           text not null default '',
  encoding        text,
  header          jsonb,
  rows_read       integer not null default 0,
  rows_bad        integer not null default 0,
  rows_kept       integer,
  locked_until    timestamptz,
  attempts        integer not null default 0,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint partner_imports_kind check (kind in ('products', 'inventory')),
  constraint partner_imports_source check (source in ('url', 'file')),
  constraint partner_imports_status check (status in ('download', 'parse', 'done', 'unchanged', 'error')),
  constraint partner_imports_error check (error is null or error ~ '^[a-z_]{1,40}$'),
  constraint partner_imports_detail check (coalesce(char_length(error_detail), 0) <= 300),
  constraint partner_imports_carry check (char_length(carry) <= 2000000),
  constraint partner_imports_encoding check (encoding is null or encoding in ('utf-8', 'windows-1250', 'iso-8859-2', 'windows-1252', 'iso-8859-1'))
);
alter table public.partner_imports enable row level security;
revoke all on public.partner_imports from public, anon, authenticated;
grant all on public.partner_imports to service_role;
-- One running import per partner and kind.
create unique index if not exists partner_imports_running
  on public.partner_imports (partner_id, kind) where status in ('download', 'parse');
create index if not exists partner_imports_partner on public.partner_imports (partner_id, kind, started_at desc);

-- ------------------------------------------------------------------ 5. The import steps (service role only)
-- The partner-feeds function copies a feed into parts of a few MB (private bucket partner-feeds,
-- "imports/<import>/"), then reads one part per call: an Edge Function has 2 seconds of CPU per call, so a big
-- feed is many short calls, each one chaining the next. The rows of an item cut by a part's end wait in carry.

/** The partners that are due: one products import (and one inventory import, when there is one) each. */
create or replace function public.partner_start_due()
returns setof uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p record;
  v_id uuid;
begin
  for p in
    select * from public.partners
    where enabled and next_run_at <= now()
    order by next_run_at
    limit 20
    for update skip locked
  loop
    if p.feed_url is not null or p.feed_file_path is not null then
      insert into public.partner_imports (partner_id, kind, source, source_key, force)
      values (p.id, 'products', case when p.feed_url is not null then 'url' else 'file' end,
              md5(coalesce(p.feed_url, p.feed_file_path) || '|' || p.feed_format), p.force_next)
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then
        return next v_id;
      end if;
      v_id := null;
    end if;
    if p.inventory_url is not null or p.inventory_file_path is not null then
      insert into public.partner_imports (partner_id, kind, source, source_key, force)
      values (p.id, 'inventory', case when p.inventory_url is not null then 'url' else 'file' end,
              md5(coalesce(p.inventory_url, p.inventory_file_path) || '|' || p.inventory_format), p.force_next)
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then
        return next v_id;
      end if;
      v_id := null;
    end if;
    update public.partners
    set next_run_at = now() + public.partner_schedule_interval(p.schedule), force_next = false
    where id = p.id;
  end loop;
end;
$$;
revoke execute on function public.partner_start_due() from public, anon, authenticated;
grant execute on function public.partner_start_due() to service_role;

/**
 * One step of an import for one caller at a time: takes the given import (or the oldest one waiting) for
 * p_lease_seconds and returns what the step needs — the source, the format, where it stopped, and the last
 * finished import of the same source (for If-Modified-Since). Null when there is nothing to do. An import that
 * was taken 30 times without finishing is given up ("stuck").
 */
create or replace function public.partner_import_claim(p_import uuid, p_lease_seconds integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i public.partner_imports;
  p public.partners;
  v_prev public.partner_imports;
begin
  select * into i from public.partner_imports
  where status in ('download', 'parse')
    and (locked_until is null or locked_until < now())
    and (p_import is null or id = p_import)
  order by started_at
  limit 1
  for update skip locked;
  if not found then
    return null;
  end if;
  if i.attempts >= 30 then
    update public.partner_imports
    set status = 'error', error = 'stuck', error_detail = 'The import did not finish after 30 tries.',
        finished_at = now(), locked_until = null
    where id = i.id;
    return jsonb_build_object('id', i.id, 'status', 'error', 'error', 'stuck', 'parts', i.parts);
  end if;
  update public.partner_imports
  set locked_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 600)),
      attempts = attempts + 1
  where id = i.id
  returning * into i;
  select * into p from public.partners where id = i.partner_id;
  if not i.force then
    select * into v_prev from public.partner_imports
    where partner_id = i.partner_id and kind = i.kind and source_key = i.source_key
      and status in ('done', 'unchanged') and id <> i.id
    order by started_at desc
    limit 1;
  end if;
  return jsonb_build_object(
    'id', i.id,
    'partner_id', i.partner_id,
    'kind', i.kind,
    'source', i.source,
    'status', i.status,
    'url', case when i.kind = 'products' then p.feed_url else p.inventory_url end,
    'file_path', case when i.kind = 'products' then p.feed_file_path else p.inventory_file_path end,
    'file_at', case when i.kind = 'products' then p.feed_file_at else p.inventory_file_at end,
    'format', case when i.kind = 'products' then p.feed_format else p.inventory_format end,
    'currency', p.currency,
    'parts', i.parts,
    'part_index', i.part_index,
    'carry', i.carry,
    'encoding', i.encoding,
    'header', i.header,
    'feed_time', i.feed_time,
    'attempts', i.attempts,
    'previous', case when v_prev.id is null then null else jsonb_build_object(
      'modified', v_prev.source_modified, 'etag', v_prev.etag, 'feed_time', v_prev.feed_time) end
  );
end;
$$;
revoke execute on function public.partner_import_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.partner_import_claim(uuid, integer) to service_role;

/** Lets the next step of an import run (after a step that did not finish it). */
create or replace function public.partner_import_release(p_import uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.partner_imports set locked_until = null where id = p_import and status in ('download', 'parse')
$$;
revoke execute on function public.partner_import_release(uuid) from public, anon, authenticated;
grant execute on function public.partner_import_release(uuid) to service_role;

/** Imports whose next step can run now (the job hands each one to its own call of the function). */
create or replace function public.partner_imports_waiting()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.partner_imports
  where status in ('download', 'parse') and (locked_until is null or locked_until < now())
  order by started_at
  limit 10
$$;
revoke execute on function public.partner_imports_waiting() from public, anon, authenticated;
grant execute on function public.partner_imports_waiting() to service_role;

/** The feed was copied into parts: reading starts. The time of the data is never in the future. */
create or replace function public.partner_import_downloaded(
  p_import uuid, p_parts integer, p_bytes bigint, p_feed_time timestamptz, p_modified text, p_etag text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.partner_imports
  set status = 'parse',
      parts = greatest(coalesce(p_parts, 0), 0),
      bytes = greatest(coalesce(p_bytes, 0), 0),
      feed_time = least(coalesce(p_feed_time, now()), now()),
      source_modified = left(p_modified, 100),
      etag = left(p_etag, 200),
      part_index = 0,
      carry = '',
      attempts = 0,
      locked_until = null
  where id = p_import and status = 'download';
  if not found then
    raise exception 'The import is not downloading' using errcode = '55000';
  end if;
end;
$$;
revoke execute on function public.partner_import_downloaded(uuid, integer, bigint, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.partner_import_downloaded(uuid, integer, bigint, timestamptz, text, text) to service_role;

/** The partner's server says the feed did not change since the last import (304): its data keeps its time. */
create or replace function public.partner_import_unchanged(p_import uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.partner_imports
  set status = 'unchanged', finished_at = now(), locked_until = null,
      (feed_time, source_modified, etag) = (
        select prev.feed_time, prev.source_modified, prev.etag
        from public.partner_imports prev
        where prev.partner_id = partner_imports.partner_id and prev.kind = partner_imports.kind
          and prev.source_key = partner_imports.source_key and prev.status in ('done', 'unchanged')
          and prev.id <> partner_imports.id
        order by prev.started_at desc
        limit 1)
  where id = p_import and status = 'download'
$$;
revoke execute on function public.partner_import_unchanged(uuid) from public, anon, authenticated;
grant execute on function public.partner_import_unchanged(uuid) to service_role;

/**
 * Rows of one part, written as the partner sent them (the function only reads the feed; nothing is corrected).
 * p_last: the part's last batch — the import moves to the next part, keeps p_carry (the start of an item that
 * goes on in the next part) and counts the part's rows. A part read again after a failed step writes the same
 * rows again: nothing is doubled.
 */
create or replace function public.partner_import_rows(
  p_import uuid, p_part integer, p_rows jsonb, p_last boolean, p_carry text,
  p_read integer, p_bad integer, p_header jsonb, p_encoding text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i public.partner_imports;
  v_count integer := 0;
begin
  select * into i from public.partner_imports where id = p_import for update;
  if not found or i.status <> 'parse' or i.part_index <> p_part then
    raise exception 'The import is not at this part' using errcode = '55000';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'rows must be a list' using errcode = '22023';
  end if;

  if i.kind = 'products' then
    insert into public.partner_products as pp (
      partner_id, item_id, title, brand, gtin, mpn, category, price, sale_price, sale_from, sale_to, currency,
      availability, availability_state, availability_days, link, image_link, import_id, updated_at, changed_at)
    select distinct on (r.value ->> 'id')
      i.partner_id, r.value ->> 'id', r.value ->> 'title', r.value ->> 'brand', r.value ->> 'gtin', r.value ->> 'mpn',
      r.value ->> 'category', (r.value ->> 'price')::numeric, (r.value ->> 'sale_price')::numeric,
      (r.value ->> 'sale_from')::timestamptz, (r.value ->> 'sale_to')::timestamptz, r.value ->> 'currency',
      r.value ->> 'availability', coalesce(r.value ->> 'state', 'unknown'), (r.value ->> 'days')::integer,
      r.value ->> 'link', r.value ->> 'image', i.id, i.feed_time, now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as r(value, n)
    where r.value ->> 'id' is not null and r.value ->> 'title' is not null
    order by r.value ->> 'id', r.n desc
    on conflict (partner_id, item_id) do update set
      title = excluded.title, brand = excluded.brand, gtin = excluded.gtin, mpn = excluded.mpn,
      category = excluded.category, price = excluded.price, sale_price = excluded.sale_price,
      sale_from = excluded.sale_from, sale_to = excluded.sale_to, currency = excluded.currency,
      availability = excluded.availability, availability_state = excluded.availability_state,
      availability_days = excluded.availability_days, link = excluded.link, image_link = excluded.image_link,
      import_id = excluded.import_id, updated_at = excluded.updated_at,
      changed_at = case
        when (pp.title, pp.brand, pp.gtin, pp.mpn, pp.category, pp.price, pp.sale_price, pp.sale_from, pp.sale_to,
              pp.currency, pp.availability, pp.availability_state, pp.availability_days, pp.link, pp.image_link)
             is distinct from
             (excluded.title, excluded.brand, excluded.gtin, excluded.mpn, excluded.category, excluded.price,
              excluded.sale_price, excluded.sale_from, excluded.sale_to, excluded.currency, excluded.availability,
              excluded.availability_state, excluded.availability_days, excluded.link, excluded.image_link)
        then now() else pp.changed_at end;
    get diagnostics v_count = row_count;
  else
    insert into public.partner_store_stock as ss (
      partner_id, item_id, store_code, availability, availability_state, quantity, import_id, updated_at)
    select distinct on (r.value ->> 'id', r.value ->> 'store')
      i.partner_id, r.value ->> 'id', r.value ->> 'store', r.value ->> 'availability',
      coalesce(r.value ->> 'state', 'unknown'), (r.value ->> 'quantity')::numeric, i.id, i.feed_time
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as r(value, n)
    where r.value ->> 'id' is not null and r.value ->> 'store' is not null
    order by r.value ->> 'id', r.value ->> 'store', r.n desc
    on conflict (partner_id, item_id, store_code) do update set
      availability = excluded.availability, availability_state = excluded.availability_state,
      quantity = excluded.quantity, import_id = excluded.import_id, updated_at = excluded.updated_at;
    get diagnostics v_count = row_count;
  end if;

  if p_last then
    update public.partner_imports
    set part_index = part_index + 1,
        carry = coalesce(p_carry, ''),
        rows_read = rows_read + greatest(coalesce(p_read, 0), 0),
        rows_bad = rows_bad + greatest(coalesce(p_bad, 0), 0),
        header = coalesce(header, p_header),
        encoding = coalesce(encoding, p_encoding),
        -- progress: the next step may run at once, and the count of tries without progress starts again
        attempts = 0,
        locked_until = null
    where id = p_import;
  end if;
  return v_count;
end;
$$;
revoke execute on function public.partner_import_rows(uuid, integer, jsonb, boolean, text, integer, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.partner_import_rows(uuid, integer, jsonb, boolean, text, integer, integer, jsonb, text) to service_role;

/**
 * Every part was read. A readable feed replaces the partner's rows of this kind: rows it no longer contains are
 * removed. A feed without readable rows, or with more unreadable rows than readable ones, changes nothing more.
 */
create or replace function public.partner_import_finish(p_import uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i public.partner_imports;
  v_kept integer;
begin
  select * into i from public.partner_imports where id = p_import for update;
  if not found or i.status <> 'parse' or i.part_index < i.parts then
    raise exception 'The import is not read to the end' using errcode = '55000';
  end if;
  if i.rows_read = 0 or i.rows_bad * 2 > i.rows_read then
    update public.partner_imports
    set status = 'error', error = case when i.rows_read = 0 then 'empty' else 'unreadable' end,
        error_detail = format('%s rows, %s unreadable: the earlier data stays.', i.rows_read, i.rows_bad),
        finished_at = now(), locked_until = null
    where id = p_import;
    perform public.partner_retry_soon(i.partner_id);
    return jsonb_build_object('status', 'error', 'error', case when i.rows_read = 0 then 'empty' else 'unreadable' end);
  end if;
  if i.kind = 'products' then
    delete from public.partner_products where partner_id = i.partner_id and import_id <> i.id;
    select count(*) into v_kept from public.partner_products where partner_id = i.partner_id;
  else
    delete from public.partner_store_stock where partner_id = i.partner_id and import_id <> i.id;
    select count(*) into v_kept from public.partner_store_stock where partner_id = i.partner_id;
  end if;
  update public.partner_imports
  set status = 'done', rows_kept = v_kept, carry = '', finished_at = now(), locked_until = null
  where id = p_import;
  delete from public.partner_imports
  where partner_id = i.partner_id and kind = i.kind and status in ('done', 'unchanged', 'error')
    and id not in (
      select id from public.partner_imports
      where partner_id = i.partner_id and kind = i.kind
      order by started_at desc
      limit 10);
  return jsonb_build_object('status', 'done', 'rows', v_kept);
end;
$$;
revoke execute on function public.partner_import_finish(uuid) from public, anon, authenticated;
grant execute on function public.partner_import_finish(uuid) to service_role;

/** After a failure: try again within the hour (never later than the partner's own schedule). */
create or replace function public.partner_retry_soon(p_partner uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.partners set next_run_at = least(next_run_at, now() + interval '1 hour') where id = p_partner
$$;
revoke execute on function public.partner_retry_soon(uuid) from public, anon, authenticated;
grant execute on function public.partner_retry_soon(uuid) to service_role;

/**
 * The import stops with a reason for the admin; the earlier data stays as it was. A feed over the size limit
 * (too_big) waits for the partner's next turn: it would only be too big again in an hour.
 */
create or replace function public.partner_import_fail(p_import uuid, p_error text, p_detail text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_partner uuid;
  v_error text := case when coalesce(p_error, '') ~ '^[a-z_]{1,40}$' then p_error else 'failed' end;
begin
  update public.partner_imports
  set status = 'error', error = v_error,
      error_detail = left(regexp_replace(coalesce(p_detail, ''), '[\x01-\x1f]', ' ', 'g'), 300),
      finished_at = now(), locked_until = null, carry = ''
  where id = p_import and status in ('download', 'parse')
  returning partner_id into v_partner;
  if v_partner is not null and v_error <> 'too_big' then
    perform public.partner_retry_soon(v_partner);
  end if;
end;
$$;
revoke execute on function public.partner_import_fail(uuid, text, text) from public, anon, authenticated;
grant execute on function public.partner_import_fail(uuid, text, text) to service_role;

-- ------------------------------------------------------------------ 6. The search (layer 2 of the chat)

/** Data older than this shows no availability, only its time (Prompt 11: 48 hours). */
create or replace function public.partner_data_fresh(p_updated_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_updated_at is not null and p_updated_at >= now() - interval '48 hours'
$$;
grant execute on function public.partner_data_fresh(timestamptz) to anon, authenticated, service_role;

/** Whether the chat's partner layer has anything to search (no partner with rows → the layer is skipped). */
create or replace function public.partner_layer_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.partners pa
    where pa.enabled and exists (select 1 from public.partner_products pp where pp.partner_id = pa.id))
$$;
revoke execute on function public.partner_layer_ready() from public;
grant execute on function public.partner_layer_ready() to anon, authenticated, service_role;

/**
 * The partners' products for a search term, with the same accent-insensitive search as the shops' items: every
 * word must appear in the title, brand, EAN/GTIN, MPN or the partner's name (or the term is the exact GTIN). With
 * a town the shopper wrote: the partner's stores in that town (by the store list's town, or within 20 km of the
 * town's centre when it is known) and their stock from the partner's local inventory feed. Data older than 48
 * hours: online availability and store stock are null / left out, only the time is returned. Order: fresh data,
 * in stock in a store in the town, in stock online, how well the title fits, price — never the affiliate flag.
 */
create or replace function public.search_partner_products(p_q text, p_town text default null, p_limit integer default 10)
returns table (
  partner_id    uuid,
  partner_name  text,
  partner_logo  text,
  partner_timezone text,
  affiliate     boolean,
  item_id       text,
  title         text,
  brand         text,
  gtin          text,
  price         numeric,
  regular_price numeric,
  currency      text,
  link          text,
  image_link    text,
  availability  text,
  availability_state text,
  availability_days  integer,
  updated_at    timestamptz,
  stale         boolean,
  stores        jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with term as (
    select nullif(btrim(left(coalesce(p_q, ''), 200)), '') as raw_q,
           nullif(btrim(left(coalesce(p_town, ''), 100)), '') as town
  ),
  word as (
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
    from term t, unnest(regexp_split_to_array(public.search_text(t.raw_q), '\s+')) as w
    where w <> ''
    order by length(w) desc
    limit 1
  ),
  centre as (
    select c.lat, c.lng from term t, public.town_center(t.town) c where t.town is not null and c.lat is not null
    union all
    select g.lat, g.lng from term t, public.town_geocodes g
    where t.town is not null and g.found
      and g.key = btrim(regexp_replace(public.search_text(t.town), '[^a-z0-9]+', ' ', 'g'))
    limit 1
  ),
  town_stores as (
    select s.partner_id, s.store_code, s.name, s.address, s.city
    from public.partner_stores s, term t
    where t.town is not null
      and (
        public.search_text(btrim(s.city)) = public.search_text(t.town)
        or (s.lat is not null and exists (
          select 1 from centre c
          where extensions.st_dwithin(
            extensions.st_setsrid(extensions.st_makepoint(s.lng, s.lat), 4326)::extensions.geography,
            extensions.st_setsrid(extensions.st_makepoint(c.lng, c.lat), 4326)::extensions.geography,
            20000)))
      )
  ),
  matched as (
    select pp.*, pa.name as p_name, pa.logo_path, pa.timezone as p_timezone, pa.affiliate as p_affiliate,
           not public.partner_data_fresh(pp.updated_at) as is_stale,
           extensions.similarity(pp.search_blob, public.search_text(t.raw_q)) as fit
    from public.partner_products pp
    join public.partners pa on pa.id = pp.partner_id and pa.enabled
    cross join term t
    cross join word w
    where t.raw_q is not null
      and (pp.search_blob like w.pattern or public.search_text(pa.name) like w.pattern or pp.gtin = t.raw_q)
      and (pp.gtin = t.raw_q or public.matches_all_words(pp.search_blob || ' ' || public.search_text(pa.name), t.raw_q))
    order by is_stale, (pp.availability_state = 'in_stock') desc, fit desc
    limit 200
  ),
  with_stores as (
    select m.*,
      case when m.is_stale then '[]'::jsonb else coalesce((
        select jsonb_agg(x.store order by x.has desc, x.name)
        from (
          select ts.name,
                 ss.availability_state in ('in_stock', 'limited') as has,
                 jsonb_build_object('code', ts.store_code, 'name', ts.name, 'address', ts.address, 'city', ts.city,
                   'availability', ss.availability, 'state', ss.availability_state, 'quantity', ss.quantity,
                   'updated_at', ss.updated_at) as store
          from public.partner_store_stock ss
          join town_stores ts on ts.partner_id = ss.partner_id and ts.store_code = ss.store_code
          where ss.partner_id = m.partner_id and ss.item_id = m.item_id
            and public.partner_data_fresh(ss.updated_at)
          order by has desc, ts.name
          limit 5
        ) x), '[]'::jsonb) end as town_stock
    from matched m
  )
  select
    s.partner_id, s.p_name, s.logo_path, s.p_timezone, s.p_affiliate,
    s.item_id, s.title, s.brand, s.gtin,
    case when s.sale_price is not null and (s.sale_from is null or s.sale_from <= now())
              and (s.sale_to is null or s.sale_to > now())
         then s.sale_price else s.price end,
    case when s.sale_price is not null and (s.sale_from is null or s.sale_from <= now())
              and (s.sale_to is null or s.sale_to > now()) and s.price is not null and s.price > s.sale_price
         then s.price end,
    s.currency, s.link, s.image_link,
    case when s.is_stale then null else s.availability end,
    case when s.is_stale then null else s.availability_state end,
    case when s.is_stale then null else s.availability_days end,
    s.updated_at, s.is_stale, s.town_stock
  from with_stores s
  order by
    s.is_stale,
    exists (select 1 from jsonb_array_elements(s.town_stock) e where e ->> 'state' in ('in_stock', 'limited')) desc,
    (s.availability_state = 'in_stock') desc,
    s.fit desc,
    s.price nulls last,
    s.p_name, s.title, s.item_id
  limit least(greatest(coalesce(p_limit, 10), 1), 20)
$$;
revoke execute on function public.search_partner_products(text, text, integer) from public;
grant execute on function public.search_partner_products(text, text, integer) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 7. The admin ("Partnerské feedy")

/** Everything the admin page shows: the partners, their store lists, counts and the last imports. */
create or replace function public.admin_partner_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return jsonb_build_object('partners', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'logo_path', p.logo_path,
      'feed_url', p.feed_url, 'feed_file_path', p.feed_file_path, 'feed_file_at', p.feed_file_at,
      'feed_format', p.feed_format,
      'inventory_url', p.inventory_url, 'inventory_file_path', p.inventory_file_path,
      'inventory_file_at', p.inventory_file_at, 'inventory_format', p.inventory_format,
      'currency', p.currency, 'timezone', p.timezone, 'schedule', p.schedule,
      'affiliate', p.affiliate, 'enabled', p.enabled, 'next_run_at', p.next_run_at,
      'products', (select count(*) from public.partner_products pp where pp.partner_id = p.id),
      'products_fresh', (select count(*) from public.partner_products pp
                         where pp.partner_id = p.id and public.partner_data_fresh(pp.updated_at)),
      'data_time', (select max(pp.updated_at) from public.partner_products pp where pp.partner_id = p.id),
      'store_stock', (select count(*) from public.partner_store_stock ss where ss.partner_id = p.id),
      'stores', coalesce((
        select jsonb_agg(jsonb_build_object('code', s.store_code, 'name', s.name, 'address', s.address,
          'city', s.city, 'postal_code', s.postal_code, 'country', s.country, 'lat', s.lat, 'lng', s.lng)
          order by s.store_code)
        from public.partner_stores s where s.partner_id = p.id), '[]'::jsonb),
      'imports', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.started_at desc)
        from (
          select i.id, i.kind, i.status, i.error, i.error_detail, i.feed_time, i.bytes, i.parts, i.part_index,
                 i.rows_read, i.rows_bad, i.rows_kept, i.started_at, i.finished_at
          from public.partner_imports i where i.partner_id = p.id
          order by i.started_at desc
          limit 6
        ) x), '[]'::jsonb)
    ) order by p.name)
    from public.partners p), '[]'::jsonb));
end;
$$;
revoke execute on function public.admin_partner_settings() from public, anon;
grant execute on function public.admin_partner_settings() to authenticated;

/**
 * Adds (p.id empty) or changes a partner. A new address or format means a full import soon. Errors: name,
 * feed_url, inventory_url, format, inventory_format, currency, heureka_currency, timezone, schedule, too_many.
 */
create or replace function public.admin_save_partner(p jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_old public.partners;
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_feed_url text := nullif(btrim(coalesce(p ->> 'feed_url', '')), '');
  v_inventory_url text := nullif(btrim(coalesce(p ->> 'inventory_url', '')), '');
  v_format text := coalesce(p ->> 'feed_format', '');
  v_inventory_format text := nullif(coalesce(p ->> 'inventory_format', ''), '');
  v_currency text := nullif(upper(btrim(coalesce(p ->> 'currency', ''))), '');
  v_timezone text := btrim(coalesce(p ->> 'timezone', ''));
  v_schedule text := coalesce(nullif(p ->> 'schedule', ''), 'daily');
  v_changed boolean;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 or v_name ~ '[\x01-\x1f<>]' then
    raise exception 'name' using errcode = '22023';
  end if;
  if v_format not in ('google_xml', 'google_csv', 'heureka_xml', 'csv') then
    raise exception 'format' using errcode = '22023';
  end if;
  if v_feed_url is not null and not public.valid_feed_url(v_feed_url) then
    raise exception 'feed_url' using errcode = '22023';
  end if;
  if v_inventory_url is not null and not public.valid_feed_url(v_inventory_url) then
    raise exception 'inventory_url' using errcode = '22023';
  end if;
  if v_inventory_format is not null and v_inventory_format not in ('google_local_xml', 'google_local_csv') then
    raise exception 'inventory_format' using errcode = '22023';
  end if;
  if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency' using errcode = '22023';
  end if;
  if v_format = 'heureka_xml' and v_currency is null then
    raise exception 'heureka_currency' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    raise exception 'timezone' using errcode = '22023';
  end if;
  if v_schedule not in ('hourly', '6h', 'daily', 'weekly') then
    raise exception 'schedule' using errcode = '22023';
  end if;

  if v_id is null then
    if (select count(*) from public.partners) >= 50 then
      raise exception 'too_many' using errcode = '22023';
    end if;
    insert into public.partners (name, feed_url, feed_format, inventory_url, inventory_format, currency, timezone,
                                 schedule, affiliate, enabled, next_run_at, force_next)
    values (v_name, v_feed_url, v_format, v_inventory_url,
            case when v_inventory_url is not null then coalesce(v_inventory_format, 'google_local_xml') else v_inventory_format end,
            v_currency, v_timezone, v_schedule, coalesce((p ->> 'affiliate')::boolean, false),
            coalesce((p ->> 'enabled')::boolean, true), now(), true)
    returning id into v_id;
    return v_id;
  end if;

  select * into v_old from public.partners where id = v_id for update;
  if not found then
    raise exception 'Unknown partner' using errcode = 'P0002';
  end if;
  v_inventory_format := case
    when v_inventory_url is not null or v_old.inventory_file_path is not null
    then coalesce(v_inventory_format, v_old.inventory_format, 'google_local_xml')
    else v_inventory_format end;
  -- Another address, file kind, format or currency: the next import reads everything again.
  v_changed := v_old.feed_url is distinct from v_feed_url
    or v_old.feed_format is distinct from v_format
    or v_old.inventory_url is distinct from v_inventory_url
    or v_old.inventory_format is distinct from v_inventory_format
    or v_old.currency is distinct from v_currency;
  update public.partners set
    name = v_name,
    -- A typed address replaces an uploaded file; an empty address keeps the file.
    feed_url = v_feed_url,
    feed_file_path = case when v_feed_url is not null then null else feed_file_path end,
    feed_file_at = case when v_feed_url is not null then null else feed_file_at end,
    feed_format = v_format,
    inventory_url = v_inventory_url,
    inventory_file_path = case when v_inventory_url is not null then null else inventory_file_path end,
    inventory_file_at = case when v_inventory_url is not null then null else inventory_file_at end,
    inventory_format = v_inventory_format,
    currency = v_currency,
    timezone = v_timezone,
    schedule = v_schedule,
    affiliate = coalesce((p ->> 'affiliate')::boolean, false),
    enabled = coalesce((p ->> 'enabled')::boolean, true),
    next_run_at = case when v_changed then now()
                       when v_schedule <> v_old.schedule then least(next_run_at, now() + public.partner_schedule_interval(v_schedule))
                       else next_run_at end,
    force_next = force_next or v_changed,
    updated_at = now()
  where id = v_id;
  return v_id;
end;
$$;
revoke execute on function public.admin_save_partner(jsonb) from public, anon;
grant execute on function public.admin_save_partner(jsonb) to authenticated;

/**
 * A feed file the admin uploaded (private bucket partner-feeds, "<partner>/feed-<ms>.xml"): it replaces the feed
 * address and is read soon. Returns the file it replaced (the page deletes it), or null.
 */
create or replace function public.admin_set_partner_file(p_partner uuid, p_kind text, p_path text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_exists boolean := true;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_kind not in ('products', 'inventory')
     or coalesce(p_path, '') !~ ('^' || p_partner::text || '/' || case when p_kind = 'products' then 'feed' else 'inventory' end
                                 || '-[0-9]{13}\.(xml|csv|tsv|txt|gz)$') then
    raise exception 'file' using errcode = '22023';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
      into v_exists using 'partner-feeds', p_path;
  end if;
  if not v_exists then
    raise exception 'file' using errcode = '22023';
  end if;
  if p_kind = 'products' then
    select feed_file_path into v_old from public.partners where id = p_partner for update;
    if not found then
      raise exception 'Unknown partner' using errcode = 'P0002';
    end if;
    update public.partners
    set feed_file_path = p_path, feed_file_at = now(), feed_url = null, next_run_at = now(), force_next = true, updated_at = now()
    where id = p_partner;
  else
    select inventory_file_path into v_old from public.partners where id = p_partner for update;
    if not found then
      raise exception 'Unknown partner' using errcode = 'P0002';
    end if;
    update public.partners
    set inventory_file_path = p_path, inventory_file_at = now(), inventory_url = null,
        inventory_format = coalesce(inventory_format,
          case when p_path ~ '\.xml$' then 'google_local_xml' else 'google_local_csv' end),
        next_run_at = now(), force_next = true, updated_at = now()
    where id = p_partner;
  end if;
  return nullif(v_old, p_path);
end;
$$;
revoke execute on function public.admin_set_partner_file(uuid, text, text) from public, anon;
grant execute on function public.admin_set_partner_file(uuid, text, text) to authenticated;

/** The partner's logo (public bucket partner-logos, "<partner>/logo-<ms>.webp"); null removes it. Returns the old one. */
create or replace function public.admin_set_partner_logo(p_partner uuid, p_path text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  select logo_path into v_old from public.partners where id = p_partner for update;
  if not found then
    raise exception 'Unknown partner' using errcode = 'P0002';
  end if;
  begin
    update public.partners set logo_path = p_path, updated_at = now() where id = p_partner;
  exception when check_violation then
    raise exception 'logo' using errcode = '22023';
  end;
  return nullif(v_old, p_path);
end;
$$;
revoke execute on function public.admin_set_partner_logo(uuid, text) from public, anon;
grant execute on function public.admin_set_partner_logo(uuid, text) to authenticated;

/**
 * Replaces the partner's store list: [{code, name, address, city, postal_code, country, lat, lng}], at most 5000.
 * A wrong row: error "stores:<row number>".
 */
create or replace function public.admin_save_partner_stores(p_partner uuid, p_stores jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_n integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.partners where id = p_partner) then
    raise exception 'Unknown partner' using errcode = 'P0002';
  end if;
  if jsonb_typeof(coalesce(p_stores, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_stores, '[]'::jsonb)) > 5000 then
    raise exception 'stores' using errcode = '22023';
  end if;
  delete from public.partner_stores where partner_id = p_partner;
  for v_row in select value from jsonb_array_elements(coalesce(p_stores, '[]'::jsonb)) loop
    v_n := v_n + 1;
    begin
      insert into public.partner_stores (partner_id, store_code, name, address, city, postal_code, country, lat, lng)
      values (p_partner, btrim(v_row ->> 'code'), btrim(v_row ->> 'name'),
              nullif(btrim(coalesce(v_row ->> 'address', '')), ''), nullif(btrim(coalesce(v_row ->> 'city', '')), ''),
              nullif(btrim(coalesce(v_row ->> 'postal_code', '')), ''),
              nullif(upper(btrim(coalesce(v_row ->> 'country', ''))), ''),
              nullif(v_row ->> 'lat', '')::double precision, nullif(v_row ->> 'lng', '')::double precision);
    exception when check_violation or not_null_violation or unique_violation or invalid_text_representation then
      raise exception 'stores:%', v_n using errcode = '22023';
    end;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.admin_save_partner_stores(uuid, jsonb) from public, anon;
grant execute on function public.admin_save_partner_stores(uuid, jsonb) to authenticated;

/** "Importovať teraz": the partner's feeds are read on the next step, in full (no If-Modified-Since). */
create or replace function public.admin_queue_partner_import(p_partner uuid)
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
  update public.partners set next_run_at = now(), force_next = true where id = p_partner;
  if not found then
    raise exception 'Unknown partner' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.admin_queue_partner_import(uuid) from public, anon;
grant execute on function public.admin_queue_partner_import(uuid) to authenticated;

/** Removes a partner with its stores, rows and imports. Returns its files (the page deletes them). */
create or replace function public.admin_delete_partner(p_partner uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.partners;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  delete from public.partners where id = p_partner returning * into p;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'logo', p.logo_path,
    'files', to_jsonb(array_remove(array[p.feed_file_path, p.inventory_file_path], null)));
end;
$$;
revoke execute on function public.admin_delete_partner(uuid) from public, anon;
grant execute on function public.admin_delete_partner(uuid) to authenticated;

-- ------------------------------------------------------------------ 8. Storage

-- partner-feeds (private): the admin uploads feed files into "<partner>/"; the function (service role) reads them
-- and keeps an import's parts in "imports/<import>/" until the import ends. partner-logos (public): the admin's logos.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('partner-feeds', 'partner-feeds', false)
    on conflict (id) do update set public = false;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('partner-logos', 'partner-logos', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update
      set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

    execute 'drop policy if exists "partner-feeds: admin uploads" on storage.objects';
    execute 'drop policy if exists "partner-feeds: admin deletes" on storage.objects';
    execute $p$
      create policy "partner-feeds: admin uploads" on storage.objects for insert to authenticated
      with check (bucket_id = 'partner-feeds' and public.is_admin()
                  and name ~ '^[0-9a-f-]{36}/(feed|inventory)-[0-9]{13}\.(xml|csv|tsv|txt|gz)$')$p$;
    execute $p$
      create policy "partner-feeds: admin deletes" on storage.objects for delete to authenticated
      using (bucket_id = 'partner-feeds' and public.is_admin() and name !~ '^imports/')$p$;

    execute 'drop policy if exists "partner-logos: admin uploads" on storage.objects';
    execute 'drop policy if exists "partner-logos: admin updates" on storage.objects';
    execute 'drop policy if exists "partner-logos: admin deletes" on storage.objects';
    execute $p$
      create policy "partner-logos: admin uploads" on storage.objects for insert to authenticated
      with check (bucket_id = 'partner-logos' and public.is_admin())$p$;
    execute $p$
      create policy "partner-logos: admin updates" on storage.objects for update to authenticated
      using (bucket_id = 'partner-logos' and public.is_admin())$p$;
    execute $p$
      create policy "partner-logos: admin deletes" on storage.objects for delete to authenticated
      using (bucket_id = 'partner-logos' and public.is_admin())$p$;
  end if;
end;
$$;

-- ------------------------------------------------------------------ 9. The job (pg_cron + pg_net)

-- Every 5 minutes: starts the imports that are due and goes on with unfinished ones (each call of the function
-- reads one part and calls the next step itself). Uses the Vault secrets ppi_project_url and ppi_assistant_cron.
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/partner-feeds',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_assistant_cron')),
      body := jsonb_build_object('action', 'tick'),
      timeout_milliseconds := 60000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-partner-feeds-tick', '3-59/5 * * * *', v_call);
end;
$$;

notify pgrst, 'reload schema';
