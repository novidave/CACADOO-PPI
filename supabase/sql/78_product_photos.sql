-- PPI · update 78: product photos (2026-11-04, at the owner's request)
--
-- ONE photo per product, shown ONLY on that product's page (and in that page's JSON-LD / og:image). Never in the shop
-- page's lists, the search, "Zoznam", cacaduu.com's listings, "Dostupné aj v", the sitemap, RSS or feeds, the public
-- API (/api/v1) or the MCP server — so the photo is kept apart from everything those read:
--
-- 1. product_photos: one row per product (the 1600 and 800 px WebP in the public bucket "product-photos" under random
--    names, their size, where it came from). No grant to visitors: the shop's members read their own rows (RLS);
--    only the product-photos Edge Function (service role) writes. public_stock, search_stock, item_search,
--    shop_item_search, shop_stock and every other public read stay exactly as they were.
-- 2. item_photo(slug, item): the only public read — the product page's photo (the item must be on the shop's public
--    stock). The shop assistant's show_product_photo tool uses it too, only when the shopper asks for a picture.
-- 3. owner_product_photo_item(item): the function's check that the caller is a member of the product's shop.
-- 4. product_photo_set / product_photo_remove (service role): a new photo replaces the old one; the old files are
--    returned so the function deletes them from storage.
-- 5. Bulk (CSV / XML read in the owner's browser): owner_product_photo_job() matches each row's code (then EAN) to
--    the shop's products, here in SQL; the function downloads each image in the background (https only, public
--    hosts, 15 MB, checked by its bytes) — product_photo_claim / _part / _row_done; an empty image_url does nothing.
--    The report: product_photo_jobs + product_photo_job_rows (members read).
-- 6. A product deleted and made again by code (a new stock file after "Začať sklad odznova", update 43) gets its
--    photo back (trigger on shop_items); a photo of a product gone for 30 days is removed; files nothing uses go.
--
-- Run once in the Supabase SQL Editor (Claude applies it as 78_product_photos). Safe to run again.

-- ------------------------------------------------------------------ 1. the photos

create table if not exists public.product_photos (
  item_id     uuid primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  -- the product's code when the photo was set: a product made again with the same code gets it back
  source_code text,
  path_large  text not null check (length(path_large) between 10 and 300),
  path_small  text not null check (length(path_small) between 10 and 300),
  width       integer not null check (width between 1 and 1600),
  height      integer not null check (height between 1 and 12800),
  source      text not null check (source in ('owner', 'bulk')),
  source_url  text check (source_url is null or length(source_url) <= 2000),
  updated_at  timestamptz not null default now()
);
create index if not exists product_photos_shop_idx on public.product_photos (shop_id, source_code);

alter table public.product_photos enable row level security;
revoke all on public.product_photos from public, anon, authenticated;
grant select on public.product_photos to authenticated;
grant all on public.product_photos to service_role;
drop policy if exists product_photos_members on public.product_photos;
create policy product_photos_members on public.product_photos for select to authenticated
  using (public.is_shop_member(shop_id));

-- The public bucket: the pictures are served straight from storage under random names (nothing lists the bucket:
-- no storage policies, so only the service role writes, reads its list or deletes).
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-photos', 'product-photos', true, 5242880, array['image/webp', 'image/jpeg'])
    on conflict (id) do update
      set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ------------------------------------------------------------------ 2. the one public read

/**
 * The product page's photo: {large, small, width, height, v} (paths in the bucket; v = when it changed, for the
 * address), or null. Only for a product on the shop's public stock (active shop, a stock row) — the same products
 * public_stock shows. Nothing else in the database returns a product photo to visitors.
 */
create or replace function public.item_photo(p_slug text, p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('large', pp.path_large, 'small', pp.path_small, 'width', pp.width, 'height', pp.height,
                            'v', floor(extract(epoch from pp.updated_at))::bigint)
  from public.product_photos pp
  join public.shop_items si on si.id = pp.item_id and si.shop_id = pp.shop_id
  join public.shops sh on sh.id = si.shop_id and sh.is_active and sh.slug = p_slug
  join public.inventory inv on inv.shop_item_id = si.id
  where pp.item_id = p_item_id
$$;
revoke execute on function public.item_photo(text, uuid) from public;
grant execute on function public.item_photo(text, uuid) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 3. the owner's check

/** For the function, with the caller's login: {item_id, shop_id, slug, source_code} of a product of the caller's shop. */
create or replace function public.owner_product_photo_item(p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  select jsonb_build_object('item_id', si.id, 'shop_id', si.shop_id, 'slug', sh.slug, 'source_code', si.source_code)
  into v
  from public.shop_items si join public.shops sh on sh.id = si.shop_id
  where si.id = p_item_id;
  if v is null or not public.is_shop_member((v->>'shop_id')::uuid) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  return v;
end;
$$;
revoke execute on function public.owner_product_photo_item(uuid) from public, anon;
grant execute on function public.owner_product_photo_item(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ 4. writes (the function only)

/**
 * A new photo for a product (it replaces the old one): returns {old: [paths], slug} — the old files, which the
 * function deletes from storage.
 */
create or replace function public.product_photo_set(
  p_item_id uuid, p_large text, p_small text, p_width integer, p_height integer, p_source text, p_url text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item public.shop_items;
  v_old public.product_photos;
begin
  select * into v_item from public.shop_items where id = p_item_id;
  if v_item.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- the files belong to the product's own shop folder
  if split_part(p_large, '/', 1) <> v_item.shop_id::text or split_part(p_small, '/', 1) <> v_item.shop_id::text then
    raise exception 'path' using errcode = '22023';
  end if;
  select * into v_old from public.product_photos where item_id = p_item_id for update;
  insert into public.product_photos (item_id, shop_id, source_code, path_large, path_small, width, height, source, source_url, updated_at)
  values (p_item_id, v_item.shop_id, v_item.source_code, p_large, p_small, p_width, p_height, p_source,
          case when p_source = 'bulk' then p_url end, now())
  on conflict (item_id) do update
    set shop_id = excluded.shop_id, source_code = excluded.source_code, path_large = excluded.path_large,
        path_small = excluded.path_small, width = excluded.width, height = excluded.height, source = excluded.source,
        source_url = excluded.source_url, updated_at = now();
  return jsonb_build_object(
    'old', case when v_old.item_id is null then '[]'::jsonb
                else (select coalesce(jsonb_agg(distinct p), '[]'::jsonb)
                      from unnest(array[v_old.path_large, v_old.path_small]) p
                      where p is not null and p not in (p_large, p_small)) end,
    'slug', (select slug from public.shops where id = v_item.shop_id));
end;
$$;
revoke execute on function public.product_photo_set(uuid, text, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.product_photo_set(uuid, text, text, integer, integer, text, text) to service_role;

/** "Odstrániť fotku": returns {old: [paths], slug}. */
create or replace function public.product_photo_remove(p_item_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old public.product_photos;
begin
  delete from public.product_photos where item_id = p_item_id returning * into v_old;
  return jsonb_build_object(
    'old', case when v_old.item_id is null then '[]'::jsonb else jsonb_build_array(v_old.path_large, v_old.path_small) end,
    'slug', (select slug from public.shops where id = v_old.shop_id));
end;
$$;
revoke execute on function public.product_photo_remove(uuid) from public, anon, authenticated;
grant execute on function public.product_photo_remove(uuid) to service_role;

-- ------------------------------------------------------------------ 5. bulk files

create table if not exists public.product_photo_jobs (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops (id) on delete cascade,
  created_by  uuid,
  file_name   text not null check (length(file_name) between 1 and 200),
  kind        text not null check (kind in ('csv', 'xml')),
  status      text not null default 'running' check (status in ('running', 'done')),
  total       integer not null check (total between 1 and 5000),
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists product_photo_jobs_shop_idx on public.product_photo_jobs (shop_id, created_at desc);

create table if not exists public.product_photo_job_rows (
  job_id      uuid not null references public.product_photo_jobs (id) on delete cascade,
  n           integer not null,
  code        text,
  ean         text,
  url         text,
  item_id     uuid,
  status      text not null check (status in ('pending', 'working', 'done', 'unchanged', 'empty', 'not_found',
                                              'bad_url', 'bad_image', 'too_big', 'failed')),
  detail      text check (detail is null or length(detail) <= 200),
  tries       smallint not null default 0,
  -- the 1600 px picture made in the first step (the 800 px one follows in the next call)
  part_path   text,
  part_width  integer,
  part_height integer,
  updated_at  timestamptz not null default now(),
  primary key (job_id, n)
);
create index if not exists product_photo_job_rows_todo_idx on public.product_photo_job_rows (status, updated_at)
  where status in ('pending', 'working');

alter table public.product_photo_jobs enable row level security;
alter table public.product_photo_job_rows enable row level security;
revoke all on public.product_photo_jobs, public.product_photo_job_rows from public, anon, authenticated;
grant select on public.product_photo_jobs, public.product_photo_job_rows to authenticated;
grant all on public.product_photo_jobs, public.product_photo_job_rows to service_role;
drop policy if exists product_photo_jobs_members on public.product_photo_jobs;
create policy product_photo_jobs_members on public.product_photo_jobs for select to authenticated
  using (public.is_shop_member(shop_id));
drop policy if exists product_photo_job_rows_members on public.product_photo_job_rows;
create policy product_photo_job_rows_members on public.product_photo_job_rows for select to authenticated
  using (exists (select 1 from public.product_photo_jobs j where j.id = job_id and public.is_shop_member(j.shop_id)));

/** The shop's product with this code, else the one with this EAN (the shop's own, then the catalogue's); or null. */
create or replace function public.product_photo_match(p_shop_id uuid, p_code text, p_ean text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select si.id from public.shop_items si
     where si.shop_id = p_shop_id and nullif(btrim(p_code), '') is not null and si.source_code = btrim(p_code) limit 1),
    (select si.id from public.shop_items si left join public.products p on p.id = si.product_id
     where si.shop_id = p_shop_id and nullif(btrim(p_ean), '') is not null
       and coalesce(si.ean, p.ean) = btrim(p_ean)
     order by si.source_code limit 1))
$$;
revoke execute on function public.product_photo_match(uuid, text, text) from public, anon, authenticated;
grant execute on function public.product_photo_match(uuid, text, text) to service_role;

/**
 * A bulk file read in the owner's browser: p_rows = [{code, ean, url}] (≤ 5000; the file's order). Each row is decided
 * here: an empty image_url → "empty" (nothing changes, never a deletion); not https → "bad_url"; no product with that
 * code (then EAN) → "not_found"; the same address as the product's photo → "unchanged"; else "pending" (the function
 * downloads it). One running file per shop, ≤ 10 files a day. Returns the job's id.
 */
create or replace function public.owner_product_photo_job(p_shop_id uuid, p_file_name text, p_kind text, p_rows jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job uuid;
  v_total integer := case when jsonb_typeof(p_rows) = 'array' then jsonb_array_length(p_rows) else 0 end;
  v_name text := left(btrim(coalesce(p_file_name, '')), 200);
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'not_member' using errcode = '42501'; end if;
  if p_kind not in ('csv', 'xml') then raise exception 'kind' using errcode = '22023'; end if;
  if v_total < 1 or v_total > 5000 then raise exception 'rows' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('ppi-product-photos:' || p_shop_id::text));
  if exists (select 1 from public.product_photo_jobs where shop_id = p_shop_id and status = 'running') then
    raise exception 'job_running' using errcode = '55P03';
  end if;
  if (select count(*) from public.product_photo_jobs where shop_id = p_shop_id and created_at > now() - interval '1 day') >= 10 then
    raise exception 'job_limit' using errcode = '54000';
  end if;
  insert into public.product_photo_jobs (shop_id, created_by, file_name, kind, total)
  values (p_shop_id, auth.uid(), coalesce(nullif(v_name, ''), 'file'), p_kind, v_total)
  returning id into v_job;

  insert into public.product_photo_job_rows (job_id, n, code, ean, url, item_id, status)
  select v_job, r.n, r.code, r.ean, r.url, r.item_id,
         case
           when r.url is null then 'empty'
           when r.url !~ '^https://[^\s/?#]+' or length(r.url) > 2000 or r.url ~ '\s' then 'bad_url'
           when r.item_id is null then 'not_found'
           when exists (select 1 from public.product_photos pp where pp.item_id = r.item_id and pp.source_url = r.url) then 'unchanged'
           else 'pending'
         end
  from (
    select e.n::integer as n,
           left(nullif(btrim(e.value->>'code'), ''), 100) as code,
           left(nullif(btrim(e.value->>'ean'), ''), 40) as ean,
           nullif(btrim(e.value->>'url'), '') as url,
           public.product_photo_match(p_shop_id, e.value->>'code', e.value->>'ean') as item_id
    from jsonb_array_elements(p_rows) with ordinality as e(value, n)
  ) r;

  -- a file with nothing to download is done at once
  update public.product_photo_jobs set status = 'done', finished_at = now()
  where id = v_job and not exists (select 1 from public.product_photo_job_rows where job_id = v_job and status = 'pending');

  -- the newest 20 reports per shop are kept
  delete from public.product_photo_jobs j
  where j.shop_id = p_shop_id and j.status = 'done'
    and j.id not in (select id from public.product_photo_jobs where shop_id = p_shop_id order by created_at desc limit 20);
  return v_job;
end;
$$;
revoke execute on function public.owner_product_photo_job(uuid, text, text, jsonb) from public, anon;
grant execute on function public.owner_product_photo_job(uuid, text, text, jsonb) to authenticated;

/**
 * The function's next step (service role): a row whose time has come — first a row that left its step (5 minutes
 * without an answer: back to pending, after 3 tries "failed"), then the oldest pending row. Returns {job_id, n, url,
 * item_id, shop_id, part_path, part_width, part_height} or null when nothing waits.
 */
create or replace function public.product_photo_claim()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.product_photo_job_rows;
  v_shop uuid;
begin
  update public.product_photo_job_rows
  set status = case when tries >= 3 then 'failed' else 'pending' end,
      detail = case when tries >= 3 then 'timeout' else detail end,
      updated_at = now()
  where status = 'working' and updated_at < now() - interval '5 minutes';
  perform public.product_photo_finish(j.id) from public.product_photo_jobs j where j.status = 'running';

  select r.* into v
  from public.product_photo_job_rows r join public.product_photo_jobs j on j.id = r.job_id
  where r.status = 'pending' and j.status = 'running'
  order by j.created_at, r.n
  limit 1
  for update of r skip locked;
  if v.job_id is null then return null; end if;
  update public.product_photo_job_rows set status = 'working', tries = tries + 1, updated_at = now()
  where job_id = v.job_id and n = v.n;
  select shop_id into v_shop from public.product_photo_jobs where id = v.job_id;
  return jsonb_build_object('job_id', v.job_id, 'n', v.n, 'url', v.url, 'item_id', v.item_id, 'shop_id', v_shop,
                            'part_path', v.part_path, 'part_width', v.part_width, 'part_height', v.part_height);
end;
$$;
revoke execute on function public.product_photo_claim() from public, anon, authenticated;
grant execute on function public.product_photo_claim() to service_role;

/** A job without pending or working rows is done. Returns true when it just finished. */
create or replace function public.product_photo_finish(p_job_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with done as (
    update public.product_photo_jobs set status = 'done', finished_at = now()
    where id = p_job_id and status = 'running'
      and not exists (select 1 from public.product_photo_job_rows where job_id = p_job_id and status in ('pending', 'working'))
    returning 1)
  select exists (select 1 from done)
$$;
revoke execute on function public.product_photo_finish(uuid) from public, anon, authenticated;
grant execute on function public.product_photo_finish(uuid) to service_role;

/** The first step's 1600 px picture is stored: the row waits for its 800 px step. */
create or replace function public.product_photo_part(p_job_id uuid, p_n integer, p_path text, p_width integer, p_height integer)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.product_photo_job_rows
  set status = 'pending', part_path = p_path, part_width = p_width, part_height = p_height, tries = 0, updated_at = now()
  where job_id = p_job_id and n = p_n and status = 'working'
$$;
revoke execute on function public.product_photo_part(uuid, integer, text, integer, integer) from public, anon, authenticated;
grant execute on function public.product_photo_part(uuid, integer, text, integer, integer) to service_role;

/**
 * A row's result. "done" with the files: the product's photo is replaced (the old files come back to be deleted).
 * Returns {old: [paths], slug, finished}.
 */
create or replace function public.product_photo_row_done(
  p_job_id uuid, p_n integer, p_status text, p_detail text default null,
  p_large text default null, p_small text default null, p_width integer default null, p_height integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.product_photo_job_rows;
  v_set jsonb := jsonb_build_object('old', '[]'::jsonb);
  v_slug text;
begin
  if p_status not in ('done', 'bad_url', 'bad_image', 'too_big', 'failed') then raise exception 'status' using errcode = '22023'; end if;
  select * into v from public.product_photo_job_rows where job_id = p_job_id and n = p_n for update;
  if v.job_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_status = 'done' then
    v_set := public.product_photo_set(v.item_id, p_large, p_small, p_width, p_height, 'bulk', v.url);
  end if;
  update public.product_photo_job_rows
  set status = p_status, detail = left(p_detail, 200), part_path = null, updated_at = now()
  where job_id = p_job_id and n = p_n;
  select sh.slug into v_slug from public.product_photo_jobs j join public.shops sh on sh.id = j.shop_id where j.id = p_job_id;
  return jsonb_build_object('old', coalesce(v_set->'old', '[]'::jsonb), 'slug', v_slug,
                            'finished', public.product_photo_finish(p_job_id));
end;
$$;
revoke execute on function public.product_photo_row_done(uuid, integer, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.product_photo_row_done(uuid, integer, text, text, text, text, integer, integer) to service_role;

/**
 * Whether a bulk file waits. p_quiet (the 5-minute job: '2 minutes'): only when no row moved for that long — its
 * chain of calls broke off, so the job starts a new one (never a second chain beside a running one).
 */
create or replace function public.product_photo_due(p_quiet interval default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.product_photo_job_rows r join public.product_photo_jobs j on j.id = r.job_id
                 where j.status = 'running' and r.status in ('pending', 'working'))
     and (p_quiet is null or not exists (
           select 1 from public.product_photo_job_rows r join public.product_photo_jobs j on j.id = r.job_id
           where j.status = 'running' and r.updated_at > now() - p_quiet))
$$;
drop function if exists public.product_photo_due();
revoke execute on function public.product_photo_due(interval) from public, anon, authenticated;
grant execute on function public.product_photo_due(interval) to service_role;

-- ------------------------------------------------------------------ 6. a product made again, tidying up

/** A product made again with the same code (a new id: "Začať sklad odznova") gets its photo back. */
create or replace function public.shop_items_reattach_photo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.product_photos pp set item_id = new.id
  where pp.shop_id = new.shop_id and pp.source_code = new.source_code and pp.item_id <> new.id
    and not exists (select 1 from public.shop_items si where si.id = pp.item_id)
    and not exists (select 1 from public.product_photos o where o.item_id = new.id);
  return null;
end;
$$;
revoke execute on function public.shop_items_reattach_photo() from public, anon, authenticated;
drop trigger if exists shop_items_reattach_photo on public.shop_items;
create trigger shop_items_reattach_photo after insert on public.shop_items
  for each row execute function public.shop_items_reattach_photo();

/**
 * The job's tidying (service role): photos of products gone for 30 days are removed; returns up to p_limit files
 * of the bucket nothing uses any more (older than a day), for the function to delete.
 */
create or replace function public.product_photo_tidy(p_limit integer default 200)
returns setof text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.product_photos pp
  where pp.updated_at < now() - interval '30 days'
    and not exists (select 1 from public.shop_items si where si.id = pp.item_id);
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'objects') then
    return;
  end if;
  return query execute
    'select o.name from storage.objects o
     where o.bucket_id = ''product-photos'' and o.created_at < now() - interval ''1 day''
       and not exists (select 1 from public.product_photos f where f.path_large = o.name or f.path_small = o.name)
       and not exists (select 1 from public.product_photo_job_rows r where r.part_path = o.name)
     order by o.created_at limit $1'
    using least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;
revoke execute on function public.product_photo_tidy(integer) from public, anon, authenticated;
grant execute on function public.product_photo_tidy(integer) to service_role;

-- ------------------------------------------------------------------ the job (pg_cron + pg_net)

-- Every 5 minutes: a bulk file whose chain of calls broke off goes on, unused files go. Uses the Vault secrets
-- ppi_project_url and ppi_assistant_cron (update 22).
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/product-photos',
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
  perform cron.schedule('ppi-product-photos-tick', '4-59/5 * * * *', v_call);
end;
$$;

notify pgrst, 'reload schema';
