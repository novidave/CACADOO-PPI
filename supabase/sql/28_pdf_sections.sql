-- PPI · 28 · Page sections from PDFs (Pro) and the header picture of a shop's own domain. Paste the whole file into the Supabase SQL Editor and Run.
--  Needs update 27. Shop profile content, not stock:
--  - public.shop_page_sections: up to 10 sections per shop ("Novinky október", "Leták" …), each made
--    from one PDF: title, collapsed or always open, position on the shop page, download on/off,
--    visible from / until, hidden, published. The owner writes only through owner_* functions; the
--    page-sections Edge Function (service role) stores the cleaned PDF, the page pictures and the
--    text (as written, never translated or corrected).
--  - public.shop_section_pages: per page of the live (or the uploading) version: the picture sizes
--    and the text, searchable for the shop's assistant.
--  - A section is shown only while it is published, not hidden, inside its dates (the shop's own
--    day) and the shop has the paid plan: section_shown() decides for the page, the assistant and
--    the download. Its page pictures are in the public bucket "shop-sections-public" only then; the
--    rest stays in the private bucket "shop-sections". The hourly job "ppi-sections-hourly" moves
--    the pictures when a date passes or the plan ends.
--  - shops.header_url …: the picture at the top of the shop's own domain (owner_set_header_picture()).
-- Safe to run again.

-- ------------------------------------------------------------------ the header picture of an own domain

alter table public.shops add column if not exists header_url text;
alter table public.shops add column if not exists header_small_url text;
alter table public.shops add column if not exists header_width integer;
alter table public.shops add column if not exists header_height integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shops_header_picture_check') then
    alter table public.shops add constraint shops_header_picture_check check (
      (header_url is null and header_small_url is null and header_width is null and header_height is null)
      or (header_url ~ ('/storage/v1/object/public/logos/' || id::text || '/header-[0-9]{10,16}\.(webp|jpg)$')
          and header_small_url ~ ('/storage/v1/object/public/logos/' || id::text || '/header-[0-9]{10,16}-800\.(webp|jpg)$')
          and header_url ~ '^https?://[^/?#@]+/storage/v1/object/public/logos/'
          and header_small_url ~ '^https?://[^/?#@]+/storage/v1/object/public/logos/'
          and header_width between 200 and 4000 and header_height between 50 and 4000));
  end if;
end;
$$;

/** The header picture is changed only through owner_set_header_picture(). */
create or replace function public.guard_shop_header_picture()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request()
     and (new.header_url is distinct from old.header_url or new.header_small_url is distinct from old.header_small_url
          or new.header_width is distinct from old.header_width or new.header_height is distinct from old.header_height) then
    raise exception 'The header picture is changed only through owner_set_header_picture()' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_shop_header_picture() from public, anon, authenticated;
drop trigger if exists shops_guard_header_picture on public.shops;
create trigger shops_guard_header_picture before update of header_url, header_small_url, header_width, header_height
  on public.shops for each row execute function public.guard_shop_header_picture();

/**
 * "Obrázok v hlavičke" (own domain): the picture uploaded into the shop's folder of the public
 * bucket "logos" (1600 px and 800 px wide). Only for shops with the paid plan or a domain of
 * their own; removing it (p_url null) is always allowed.
 */
create or replace function public.owner_set_header_picture(
  p_shop_id uuid, p_url text, p_small_url text, p_width integer, p_height integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_url is null then
    update public.shops set header_url = null, header_small_url = null, header_width = null, header_height = null
    where id = p_shop_id;
    return;
  end if;
  if not public.shop_stands_alone(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  begin
    update public.shops
    set header_url = p_url, header_small_url = p_small_url, header_width = p_width, header_height = p_height
    where id = p_shop_id;
  exception when check_violation then
    raise exception 'picture' using errcode = '22023';
  end;
end;
$$;
revoke execute on function public.owner_set_header_picture(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.owner_set_header_picture(uuid, text, text, integer, integer) to authenticated;

/** The header picture for the shop's own domain (public; null without one). */
create or replace function public.shop_header_picture(p_slug text)
returns table (url text, small_url text, width integer, height integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.header_url, s.header_small_url, s.header_width, s.header_height
  from public.shops s
  where s.slug = p_slug and s.is_active and s.header_url is not null
$$;
revoke execute on function public.shop_header_picture(text) from public;
grant execute on function public.shop_header_picture(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ page sections

create table if not exists public.shop_page_sections (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 80),
  -- 'collapsed' = "Rozbaľovacie – zatvorené", 'open' = "Vždy otvorené"
  display          text not null default 'collapsed' check (display in ('collapsed', 'open')),
  position         text not null default 'after_details'
                   check (position in ('after_details', 'after_map', 'before_items', 'end')),
  sort             integer not null default 0,
  allow_download   boolean not null default false,
  visible_from     date,
  visible_until    date,
  hidden           boolean not null default false,
  published        boolean not null default false,
  -- the live PDF (version 0 = none yet): cleaned file, pages, language of its text
  version          integer not null default 0 check (version >= 0),
  pdf_path         text,
  pdf_bytes        integer check (pdf_bytes is null or pdf_bytes between 1 and 10485760),
  pages            integer check (pages is null or pages between 1 and 20),
  lang             text check (lang is null or lang ~ '^[a-z]{2}$'),
  -- a new PDF being made ready (the live one stays on the page until it is done)
  upload_version   integer,
  upload_pages     integer check (upload_pages is null or upload_pages between 1 and 20),
  upload_pdf_path  text,
  upload_pdf_bytes integer check (upload_pdf_bytes is null or upload_pdf_bytes between 1 and 10485760),
  upload_error     text check (upload_error is null or length(upload_error) <= 500),
  -- the version whose page pictures are in the public bucket now (null = none)
  public_version   integer,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (visible_until is null or visible_from is null or visible_until >= visible_from),
  check ((version = 0) = (pdf_path is null))
);
create index if not exists shop_page_sections_shop_idx on public.shop_page_sections (shop_id, position, sort);

create table if not exists public.shop_section_pages (
  id          bigint generated always as identity primary key,
  section_id  uuid not null references public.shop_page_sections (id) on delete cascade,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  version     integer not null check (version >= 1),
  page        integer not null check (page between 1 and 20),
  -- the 1600 px picture's size (the 800 px one has the same proportions)
  width       integer check (width is null or width between 100 and 4000),
  height      integer check (height is null or height between 100 and 8000),
  ext         text check (ext is null or ext in ('webp', 'jpg')),
  small_bytes integer check (small_bytes is null or small_bytes between 1 and 5242880),
  large_bytes integer check (large_bytes is null or large_bytes between 1 and 5242880),
  -- the page's text as written (from the PDF's text layer, or read by the AI from the picture)
  text        text not null default '' check (length(text) <= 20000),
  text_done   boolean not null default false,
  needs_ai    boolean not null default false,
  ai_attempts integer not null default 0,
  ai_error    text check (ai_error is null or length(ai_error) <= 500),
  lang        text check (lang is null or lang ~ '^[a-z]{2}$'),
  search      tsvector generated always as (to_tsvector('simple'::regconfig, public.search_text(text))) stored,
  unique (section_id, version, page)
);
create index if not exists shop_section_pages_search_idx on public.shop_section_pages using gin (search);
create index if not exists shop_section_pages_ai_idx on public.shop_section_pages (needs_ai) where needs_ai;

alter table public.shop_page_sections enable row level security;
alter table public.shop_section_pages enable row level security;
revoke all on public.shop_page_sections, public.shop_section_pages from anon, authenticated;
grant select on public.shop_page_sections, public.shop_section_pages to authenticated;
grant all on public.shop_page_sections, public.shop_section_pages to service_role;
drop policy if exists "shop_page_sections: members read" on public.shop_page_sections;
create policy "shop_page_sections: members read" on public.shop_page_sections
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "shop_section_pages: members read" on public.shop_section_pages;
create policy "shop_section_pages: members read" on public.shop_section_pages
  for select to authenticated using (public.is_shop_member(shop_id));

/** Today in the shop's own time zone (the dates of a section are the shop's days). */
create or replace function public.shop_today(p_shop_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce((select s.timezone from public.shops s where s.id = p_shop_id), 'UTC'))::date
$$;
revoke execute on function public.shop_today(uuid) from public, anon, authenticated;

/**
 * Whether a section is visible now: published, not hidden, has a PDF, inside its dates (the
 * shop's day), an active shop with the paid plan. One rule for the page, the assistant, the
 * download and the public bucket.
 */
create or replace function public.section_visible(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.published and not s.hidden and s.version > 0
       and (s.visible_from is null or s.visible_from <= public.shop_today(s.shop_id))
       and (s.visible_until is null or public.shop_today(s.shop_id) <= s.visible_until)
       and sh.is_active and public.shop_has_plan(s.shop_id)
    from public.shop_page_sections s
    join public.shops sh on sh.id = s.shop_id
    where s.id = p_section_id), false)
$$;
revoke execute on function public.section_visible(uuid) from public, anon, authenticated;

/** Visible and its page pictures are in the public bucket: what visitors and the assistant get. */
create or replace function public.section_shown(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.section_visible(p_section_id)
     and exists (select 1 from public.shop_page_sections s where s.id = p_section_id and s.public_version = s.version)
$$;
revoke execute on function public.section_shown(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ the owner (Môj obchod → "Sekcie stránky (PDF)")

/**
 * Adds (p_section_id null) or changes a section's settings. Errors (P0001): no_plan, title,
 * dates, limit (10 per shop), bad. A new section, or one moved to another position, goes last.
 */
create or replace function public.owner_save_section(
  p_shop_id uuid, p_section_id uuid, p_title text, p_display text, p_position text,
  p_allow_download boolean, p_from date, p_until date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := public.plain_text(p_title, 80);
  v_id uuid := p_section_id;
  v_old_position text;
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  if v_title is null or length(btrim(v_title)) = 0 then
    raise exception 'title' using errcode = 'P0001';
  end if;
  if coalesce(p_display, '') not in ('collapsed', 'open')
     or coalesce(p_position, '') not in ('after_details', 'after_map', 'before_items', 'end') then
    raise exception 'bad' using errcode = 'P0001';
  end if;
  if p_from is not null and p_until is not null and p_until < p_from then
    raise exception 'dates' using errcode = 'P0001';
  end if;

  if v_id is null then
    perform 1 from public.shops where id = p_shop_id for update;
    if (select count(*) from public.shop_page_sections where shop_id = p_shop_id) >= 10 then
      raise exception 'limit' using errcode = 'P0001';
    end if;
    insert into public.shop_page_sections (shop_id, title, display, position, sort, allow_download, visible_from, visible_until)
    values (p_shop_id, v_title, p_display, p_position,
            coalesce((select max(sort) + 1 from public.shop_page_sections where shop_id = p_shop_id and position = p_position), 0),
            coalesce(p_allow_download, false), p_from, p_until)
    returning id into v_id;
    return v_id;
  end if;

  select position into v_old_position from public.shop_page_sections where id = v_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.shop_page_sections
  set title = v_title, display = p_display, position = p_position, allow_download = coalesce(p_allow_download, false),
      visible_from = p_from, visible_until = p_until, updated_at = now(),
      sort = case when p_position = v_old_position then sort
                  else coalesce((select max(o.sort) + 1 from public.shop_page_sections o
                                 where o.shop_id = p_shop_id and o.position = p_position), 0) end
  where id = v_id;
  return v_id;
end;
$$;
revoke execute on function public.owner_save_section(uuid, uuid, text, text, text, boolean, date, date) from public, anon;
grant execute on function public.owner_save_section(uuid, uuid, text, text, text, boolean, date, date) to authenticated;

/**
 * "Zverejniť" (after the preview), "Skryť" / "Zobraziť". Publishing needs a PDF ('empty').
 * Returns whether the section is visible now (the website then asks the function to move its
 * pictures at once; the hourly job would do it anyway).
 */
create or replace function public.owner_set_section_state(p_section_id uuid, p_action text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_version integer;
begin
  select shop_id, version into v_shop, v_version from public.shop_page_sections where id = p_section_id;
  if v_shop is null or auth.uid() is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_action = 'publish' then
    if v_version = 0 then
      raise exception 'empty' using errcode = 'P0001';
    end if;
    update public.shop_page_sections set published = true, hidden = false, updated_at = now() where id = p_section_id;
  elsif p_action = 'hide' then
    update public.shop_page_sections set hidden = true, updated_at = now() where id = p_section_id;
  elsif p_action = 'show' then
    update public.shop_page_sections set hidden = false, updated_at = now() where id = p_section_id;
  else
    raise exception 'bad' using errcode = 'P0001';
  end if;
  return public.section_visible(p_section_id);
end;
$$;
revoke execute on function public.owner_set_section_state(uuid, text) from public, anon;
grant execute on function public.owner_set_section_state(uuid, text) to authenticated;

/** The order within one position (drag and drop, or ↑ ↓): the ids in their new order. */
create or replace function public.owner_reorder_sections(p_shop_id uuid, p_position text, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.shop_page_sections s
  set sort = o.n - 1, updated_at = now()
  from unnest(p_ids) with ordinality as o(id, n)
  where s.id = o.id and s.shop_id = p_shop_id and s.position = p_position;
end;
$$;
revoke execute on function public.owner_reorder_sections(uuid, text, uuid[]) from public, anon;
grant execute on function public.owner_reorder_sections(uuid, text, uuid[]) to authenticated;

/**
 * Every file of a section (all versions; private and public bucket), for "Vymazať": the
 * page-sections function asks with the owner's login, removes the files, then the rows.
 */
create or replace function public.owner_section_files(p_section_id uuid)
returns table (bucket text, path text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select shop_id from public.shop_page_sections where id = p_section_id);
begin
  if v_shop is null or auth.uid() is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return query
  select 'shop-sections'::text, x.p from public.shop_page_sections s
  cross join lateral unnest(array[s.pdf_path, s.upload_pdf_path]) as x(p)
  where s.id = p_section_id and x.p is not null
  union all
  select b.bucket, format('%s/%s/v%s/%s-%s.%s', p.shop_id, p.section_id, p.version, p.page, w.w, p.ext)
  from public.shop_section_pages p
  cross join (values (800), (1600)) as w(w)
  cross join (values ('shop-sections'), ('shop-sections-public')) as b(bucket)
  where p.section_id = p_section_id and p.ext is not null;
end;
$$;
revoke execute on function public.owner_section_files(uuid) from public, anon;
grant execute on function public.owner_section_files(uuid) to authenticated;

/** The owner's own section (RLS would also do): shop, live and uploading version, for the function. */
create or replace function public.owner_section(p_section_id uuid)
returns table (shop_id uuid, version integer, upload_version integer, upload_pages integer, has_plan boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select s.shop_id from public.shop_page_sections s where s.id = p_section_id);
begin
  if v_shop is null or auth.uid() is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return query
  select s.shop_id, s.version, s.upload_version, s.upload_pages, public.shop_has_plan(s.shop_id)
  from public.shop_page_sections s where s.id = p_section_id;
end;
$$;
revoke execute on function public.owner_section(uuid) from public, anon;
grant execute on function public.owner_section(uuid) to authenticated;

-- ------------------------------------------------------------------ the page-sections function (service role)

/**
 * A new PDF (already checked and cleaned by the function): the next version starts; a PDF that
 * was being made ready before and never finished is dropped (its files are returned).
 */
create or replace function public.sections_begin_upload(p_section_id uuid, p_pages integer, p_bytes integer)
returns table (version integer, pdf_path text, stale_paths text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.shop_page_sections;
  v_version integer;
  v_stale text[];
begin
  select * into v_row from public.shop_page_sections s where s.id = p_section_id for update;
  if not found then
    raise exception 'section' using errcode = 'P0001';
  end if;
  if not public.shop_has_plan(v_row.shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  if p_pages is null or p_pages not between 1 and 20 or p_bytes is null or p_bytes not between 1 and 10485760 then
    raise exception 'limits' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(x.path), '{}') into v_stale from (
    select v_row.upload_pdf_path as path where v_row.upload_pdf_path is not null
    union all
    select format('%s/%s/v%s/%s-%s.%s', p.shop_id, p.section_id, p.version, p.page, w.w, p.ext)
    from public.shop_section_pages p cross join (values (800), (1600)) as w(w)
    where p.section_id = p_section_id and p.version = v_row.upload_version and p.ext is not null
  ) x;
  delete from public.shop_section_pages p where p.section_id = p_section_id and p.version = v_row.upload_version;
  v_version := greatest(v_row.version, coalesce(v_row.upload_version, 0)) + 1;
  update public.shop_page_sections s
  set upload_version = v_version, upload_pages = p_pages, upload_pdf_bytes = p_bytes, upload_error = null,
      upload_pdf_path = format('%s/%s/v%s/section.pdf', v_row.shop_id, p_section_id, v_version), updated_at = now()
  where s.id = p_section_id;
  insert into public.shop_section_pages (section_id, shop_id, version, page)
  select p_section_id, v_row.shop_id, v_version, n from generate_series(1, p_pages) n;
  return query select v_version, format('%s/%s/v%s/section.pdf', v_row.shop_id, p_section_id, v_version), v_stale;
end;
$$;

/** One page picture stored by the function (it checked type, size and pixels): 800 or 1600 px. */
create or replace function public.sections_page_stored(
  p_section_id uuid, p_version integer, p_page integer, p_size integer, p_ext text, p_bytes integer,
  p_width integer, p_height integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.shop_section_pages p
  set ext = p_ext,
      small_bytes = case when p_size = 800 then p_bytes else p.small_bytes end,
      large_bytes = case when p_size = 1600 then p_bytes else p.large_bytes end,
      width = case when p_size = 1600 then p_width else p.width end,
      height = case when p_size = 1600 then p_height else p.height end
  where p.section_id = p_section_id and p.version = p_version and p.page = p_page
    and (p.ext is null or p.ext = p_ext);
  if not found then
    raise exception 'page' using errcode = 'P0001';
  end if;
end;
$$;

/** The text of pages, as written; a page without text is read by the AI from its picture. */
create or replace function public.sections_save_text(p_section_id uuid, p_version integer, p_pages jsonb, p_lang text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.shop_section_pages p
  set text = left(coalesce(x.text, ''), 20000), text_done = true,
      needs_ai = btrim(coalesce(x.text, '')) = '', ai_attempts = 0, ai_error = null, lang = p_lang
  from jsonb_to_recordset(coalesce(p_pages, '[]'::jsonb)) as x(page integer, text text)
  where p.section_id = p_section_id and p.version = p_version and p.page = x.page;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/**
 * Every page has both pictures and its text: the new version goes live (the live one stays
 * until then). Returns the files of the version it replaces (to be removed) and whether the
 * replaced version's pictures were public.
 */
create or replace function public.sections_finish(p_section_id uuid, p_version integer)
returns table (old_paths text[], old_public_paths text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.shop_page_sections;
  v_old text[];
  v_old_public text[];
begin
  select * into v_row from public.shop_page_sections s where s.id = p_section_id for update;
  if not found or v_row.upload_version is distinct from p_version then
    raise exception 'version' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shop_section_pages p
             where p.section_id = p_section_id and p.version = p_version
               and (p.small_bytes is null or p.large_bytes is null or not p.text_done)) then
    raise exception 'incomplete' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(x.path), '{}') into v_old from (
    select v_row.pdf_path as path where v_row.pdf_path is not null
    union all
    select format('%s/%s/v%s/%s-%s.%s', p.shop_id, p.section_id, p.version, p.page, w.w, p.ext)
    from public.shop_section_pages p cross join (values (800), (1600)) as w(w)
    where p.section_id = p_section_id and p.version = v_row.version and p.ext is not null
  ) x;
  select coalesce(array_agg(format('%s/%s/v%s/%s-%s.%s', p.shop_id, p.section_id, p.version, p.page, w.w, p.ext)), '{}')
  into v_old_public
  from public.shop_section_pages p cross join (values (800), (1600)) as w(w)
  where p.section_id = p_section_id and p.version = v_row.public_version and p.ext is not null;
  delete from public.shop_section_pages p where p.section_id = p_section_id and p.version <> p_version;
  update public.shop_page_sections s
  set version = p_version, pdf_path = s.upload_pdf_path, pdf_bytes = s.upload_pdf_bytes, pages = s.upload_pages,
      lang = (select p.lang from public.shop_section_pages p where p.section_id = p_section_id and p.lang is not null limit 1),
      upload_version = null, upload_pages = null, upload_pdf_path = null, upload_pdf_bytes = null, upload_error = null,
      public_version = null, updated_at = now()
  where s.id = p_section_id;
  return query select v_old, v_old_public;
end;
$$;

/** A problem while a new PDF was made ready (shown to the owner; the live PDF stays). */
create or replace function public.sections_upload_failed(p_section_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shop_page_sections set upload_error = left(coalesce(p_error, 'error'), 500), updated_at = now()
  where id = p_section_id and upload_version is not null
$$;

/**
 * Sections whose pictures must move: visible but not (or not this version) in the public bucket,
 * or in it but not visible. p_section_id: only that one (after an owner's action).
 */
create or replace function public.sections_to_sync(p_section_id uuid default null)
returns table (id uuid, shop_id uuid, version integer, public_version integer, visible boolean, pages jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.shop_id, s.version, s.public_version, v.visible,
         coalesce((select jsonb_agg(jsonb_build_object('page', p.page, 'ext', p.ext) order by p.page)
                   from public.shop_section_pages p
                   where p.section_id = s.id and p.version = s.version and p.ext is not null), '[]'::jsonb)
  from public.shop_page_sections s
  cross join lateral (select public.section_visible(s.id) as visible) v
  where (p_section_id is null or s.id = p_section_id)
    and ((v.visible and s.public_version is distinct from s.version)
         or (not v.visible and s.public_version is not null))
  order by s.updated_at
  limit 200
$$;

/** The version whose pictures are now in the public bucket (null: none). */
create or replace function public.sections_mark_public(p_section_id uuid, p_version integer)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shop_page_sections set public_version = p_version where id = p_section_id
$$;

/** Pages without text, for the AI (at most 3 tries each; only shops with the paid plan). */
create or replace function public.sections_claim_ai(p_section_id uuid, p_limit integer)
returns table (page_id bigint, shop_id uuid, section_id uuid, version integer, page integer, ext text)
language sql
security definer
set search_path = ''
as $$
  update public.shop_section_pages p
  set ai_attempts = p.ai_attempts + 1
  where p.id in (
    select q.id from public.shop_section_pages q
    join public.shop_page_sections s on s.id = q.section_id
    where q.needs_ai and q.ai_attempts < 3 and q.large_bytes is not null
      and (p_section_id is null or q.section_id = p_section_id)
      and q.version in (s.version, coalesce(s.upload_version, -1))
      and public.shop_has_plan(s.shop_id)
    order by q.id
    limit least(greatest(coalesce(p_limit, 3), 1), 10)
    for update skip locked)
  returning p.id, p.shop_id, p.section_id, p.version, p.page, p.ext
$$;

/** What the AI read on a page without text (as written), or why it failed. */
create or replace function public.sections_save_ai_text(p_page_id bigint, p_text text, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shop_section_pages
  set text = case when p_error is null then left(coalesce(p_text, ''), 20000) else text end,
      needs_ai = p_error is not null and ai_attempts < 3,
      ai_error = left(p_error, 500)
  where id = p_page_id
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'sections_begin_upload(uuid, integer, integer)',
    'sections_page_stored(uuid, integer, integer, integer, text, integer, integer, integer)',
    'sections_save_text(uuid, integer, jsonb, text)', 'sections_finish(uuid, integer)',
    'sections_upload_failed(uuid, text)', 'sections_to_sync(uuid)', 'sections_mark_public(uuid, integer)',
    'sections_claim_ai(uuid, integer)', 'sections_save_ai_text(bigint, text, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ visitors

/**
 * The shop page's sections: only shown ones (visible, pictures public), in their positions and
 * order, each with its pages (picture size and type, the text as written). Free shops: none.
 */
create or replace function public.shop_sections(p_slug text)
returns table (id uuid, title text, display text, "position" text, sort integer, allow_download boolean,
               version integer, pages jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.title, s.display, s.position, s.sort, s.allow_download, s.version,
         coalesce((select jsonb_agg(jsonb_build_object('page', p.page, 'width', p.width, 'height', p.height,
                                                       'ext', p.ext, 'text', p.text) order by p.page)
                   from public.shop_section_pages p
                   where p.section_id = s.id and p.version = s.version), '[]'::jsonb)
  from public.shop_page_sections s
  join public.shops sh on sh.id = s.shop_id
  where sh.slug = p_slug and public.section_shown(s.id)
  order by s.position, s.sort, s.created_at
$$;
revoke execute on function public.shop_sections(text) from public;
grant execute on function public.shop_sections(text) to anon, authenticated, service_role;

/** shop-files: the cleaned PDF of a shown section whose owner allows the download, or null. */
create or replace function public.shop_section_pdf(p_slug text, p_section_id uuid)
returns table (path text, title text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.pdf_path, s.title
  from public.shop_page_sections s
  join public.shops sh on sh.id = s.shop_id
  where s.id = p_section_id and sh.slug = p_slug and s.allow_download and public.section_shown(s.id)
$$;
revoke execute on function public.shop_section_pdf(text, uuid) from public, anon, authenticated;
grant execute on function public.shop_section_pdf(text, uuid) to service_role;

-- ------------------------------------------------------------------ the assistant: shown sections are public documents

-- As in update 20, plus the text of the shop's shown sections (source = the section's title).
create or replace function public.search_shop_docs(p_slug text, p_query text, p_session_token text, p_limit integer default 8)
returns table (
  chunk_id bigint,
  type text,
  document_id uuid,
  picture_id uuid,
  source text,
  page integer,
  folder text,
  is_public boolean,
  lang text,
  text text,
  downloadable boolean,
  score real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid := public.docs_shop(p_slug);
  v_folders uuid[];
  v_q text := btrim(public.search_text(left(coalesce(p_query, ''), 300)));
  v_tsquery tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 20);
begin
  if v_shop is null then
    return;
  end if;
  v_folders := public.docs_visible_folders(v_shop, p_session_token);

  if v_q <> '' then
    select to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' | ')) into v_tsquery
    from (
      select distinct case when length(w) <= 4 then w else left(w, greatest(4, length(w) - 2)) end as w
      from regexp_split_to_table(regexp_replace(v_q, '[^a-z0-9]+', ' ', 'g'), '\s+') as w
      where length(w) >= 2
      limit 12
    ) words;
  end if;

  return query
  with docs as (
    select c.id as cid, c.type as ctype,
           case when c.picture_id is null then c.document_id else p.document_id end as doc_id,
           c.picture_id as pic_id,
           -- the source a shopper is shown: the document (also for its pictures) or the picture's title
           coalesce(case when c.picture_id is null then d.name when p.document_id is not null then pd.name
                         else nullif(p.title, '') end, '') as src,
           c.page as pg, f.name as folder_name, f.is_public as pub, c.lang as lng, c.text as body,
           coalesce(d.downloadable, false) as dl, c.search as sv
    from public.shop_document_chunks c
    join public.shop_folders f on f.id = c.folder_id
    left join public.shop_documents d on d.id = c.document_id and c.picture_id is null
    left join public.shop_pictures p on p.id = c.picture_id
    left join public.shop_documents pd on pd.id = p.document_id
    where c.shop_id = v_shop
      and c.folder_id = any (v_folders)
      and (c.picture_id is null or (p.kind = 'picture' and p.show and p.status <> 'uploading'))
      and (case when c.picture_id is null then d.assistant_enabled else coalesce(pd.assistant_enabled, true) end)
  ),
  sections as (
    -- the page sections visitors see now (update 28): public, named by their title
    select -sp.id as cid, 'text'::text as ctype, null::uuid as doc_id, null::uuid as pic_id, s.title as src,
           sp.page as pg, null::text as folder_name, true as pub, sp.lang as lng, sp.text as body,
           s.allow_download as dl, sp.search as sv
    from public.shop_page_sections s
    join public.shop_section_pages sp on sp.section_id = s.id and sp.version = s.version
    where s.shop_id = v_shop and btrim(sp.text) <> '' and public.section_shown(s.id)
  ),
  allowed as (
    select * from docs
    union all
    select * from sections
  )
  select a.cid, a.ctype, a.doc_id, a.pic_id, a.src, a.pg, a.folder_name, a.pub, a.lng, left(a.body, 4000), a.dl,
         sc.score::real
  from allowed a
  cross join lateral (
    select case
      when v_q = '' then (case when a.ctype = 'picture' then 0.5 else 1.0 / greatest(coalesce(a.pg, 1), 1) end)
      else greatest(
        case when v_tsquery is not null and a.sv @@ v_tsquery then ts_rank_cd(a.sv, v_tsquery) + 0.5 else 0 end,
        extensions.word_similarity(v_q, public.search_text(a.body)))
    end as score
  ) sc
  where v_q = '' or (v_tsquery is not null and a.sv @@ v_tsquery)
     or extensions.word_similarity(v_q, public.search_text(a.body)) >= 0.5
  order by sc.score desc, a.pg nulls last, a.cid
  limit v_limit;
end;
$$;
revoke execute on function public.search_shop_docs(text, text, text, integer) from public;
grant execute on function public.search_shop_docs(text, text, text, integer) to anon, authenticated, service_role;

-- As in update 20, plus the shown sections (public, named by their title).
create or replace function public.shop_docs_list(p_slug text, p_session_token text)
returns table (name text, pages integer, lang text, folder text, is_public boolean, downloadable boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select x.name, x.pages, x.lang, x.folder, x.is_public, x.downloadable
  from (
    select d.name, d.pages, d.lang, f.name as folder, f.is_public, d.downloadable, 0 as kind
    from public.shop_documents d
    join public.shop_folders f on f.id = d.folder_id
    where d.shop_id = public.docs_shop(p_slug)
      and d.folder_id = any (public.docs_visible_folders(d.shop_id, p_session_token))
      and d.assistant_enabled
      and exists (select 1 from public.shop_document_chunks c where c.document_id = d.id)
    union all
    select s.title, s.pages, s.lang, null::text, true, s.allow_download, 1
    from public.shop_page_sections s
    where s.shop_id = public.docs_shop(p_slug)
      and public.section_shown(s.id)
      and exists (select 1 from public.shop_section_pages p
                  where p.section_id = s.id and p.version = s.version and btrim(p.text) <> '')
  ) x
  order by x.is_public desc, x.kind, x.name
  limit 50
$$;
revoke execute on function public.shop_docs_list(text, text) from public;
grant execute on function public.shop_docs_list(text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ deleting a shop

-- As in update 20, plus: its page sections first (their files are removed with them).
create or replace function public.owner_delete_shop(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.subscriptions s
    where s.shop_id = p_shop_id
      and s.status in ('trialing', 'active', 'past_due', 'unpaid', 'paused')
      and s.cancel_at is null
  ) then
    raise exception 'Cancel the paid plan first' using errcode = '55000';
  end if;
  if exists (select 1 from public.shop_documents where shop_id = p_shop_id)
     or exists (select 1 from public.shop_pictures where shop_id = p_shop_id) then
    raise exception 'Delete the documents and pictures first' using errcode = '55006';
  end if;
  if exists (select 1 from public.shop_page_sections where shop_id = p_shop_id) then
    raise exception 'Delete the page sections first' using errcode = '55006';
  end if;
  delete from public.shops where id = p_shop_id;
end;
$$;
revoke execute on function public.owner_delete_shop(uuid) from public, anon;
grant execute on function public.owner_delete_shop(uuid) to authenticated;

-- ------------------------------------------------------------------ storage

-- Private: the cleaned PDFs and every page picture (previews, hidden and expired sections).
-- Public: copies of the page pictures of shown sections only. No policies: only the service
-- role (the page-sections function) writes either bucket.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('shop-sections', 'shop-sections', false, 10485760, array['application/pdf', 'image/webp', 'image/jpeg'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('shop-sections-public', 'shop-sections-public', true, 5242880, array['image/webp', 'image/jpeg'])
    on conflict (id) do update
      set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ------------------------------------------------------------------ the hourly job (pg_cron + pg_net)

-- Applies the visible-from / until dates and the end of the paid plan: pictures leave (or come
-- back to) the public bucket; also retries the AI on pages without text. Uses the Vault secrets
-- ppi_project_url and ppi_assistant_cron (update 22).
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/page-sections',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_assistant_cron')),
      body := jsonb_build_object('action', 'tick'),
      timeout_milliseconds := 120000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-sections-hourly', '7 * * * *', v_call);
end;
$$;

notify pgrst, 'reload schema';
