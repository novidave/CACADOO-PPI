-- PPI · 31 · The own domain's header logo, a section position after the opening hours, and sections made of pictures.
--  Paste the whole file into the Supabase SQL Editor and Run. Needs update 30. Shop profile content, not stock:
--  - shops.site_logo_url / _width / _height: the small logo at the top left of the shop's own domain (a link to its
--    home page), only through owner_set_site_logo() (Pro or a domain of its own), read through shop_site_logo().
--    It replaces the header picture of update 28 (its columns stay, unused; nothing is deleted).
--  - Page sections get the position after_hours (between "Otváracie hodiny" and the assistant); a free shop's
--    sections now come back with it (on a free page it is the same place: after the hours, before the items).
--  - A section is a PDF or pictures (source 'pdf' / 'pictures'; JPG, PNG, WebP; one picture = one page, within the
--    plan's pages and MB): sections_begin_upload(…, p_source), sections_finish keeps it; a section of pictures has no
--    PDF, so there is nothing to download (shop_section_pdf); shop_sections() also returns source.
-- Safe to run again.

-- ------------------------------------------------------------------ the header logo of an own domain

alter table public.shops add column if not exists site_logo_url text;
alter table public.shops add column if not exists site_logo_width integer;
alter table public.shops add column if not exists site_logo_height integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shops_site_logo_check') then
    alter table public.shops add constraint shops_site_logo_check check (
      (site_logo_url is null and site_logo_width is null and site_logo_height is null)
      or (site_logo_url ~ ('/storage/v1/object/public/logos/' || id::text || '/site-logo-[0-9]{10,16}\.(webp|png)$')
          and site_logo_url ~ '^https?://[^/?#@]+/storage/v1/object/public/logos/'
          and site_logo_width between 16 and 1600 and site_logo_height between 16 and 400));
  end if;
end;
$$;

/** The header logo is changed only through owner_set_site_logo(). */
create or replace function public.guard_shop_site_logo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request()
     and (new.site_logo_url is distinct from old.site_logo_url or new.site_logo_width is distinct from old.site_logo_width
          or new.site_logo_height is distinct from old.site_logo_height) then
    raise exception 'The header logo is changed only through owner_set_site_logo()' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_shop_site_logo() from public, anon, authenticated;
drop trigger if exists shops_guard_site_logo on public.shops;
create trigger shops_guard_site_logo before update of site_logo_url, site_logo_width, site_logo_height
  on public.shops for each row execute function public.guard_shop_site_logo();

/**
 * "Logo v hlavičke webu" (own domain): a picture in the shop's folder of the public bucket "logos"
 * (made at most 120 px high in the browser, checked on the server). Only for shops with the paid
 * plan or a domain of their own; removing it (p_url null) is always allowed.
 */
create or replace function public.owner_set_site_logo(p_shop_id uuid, p_url text, p_width integer, p_height integer)
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
    update public.shops set site_logo_url = null, site_logo_width = null, site_logo_height = null where id = p_shop_id;
    return;
  end if;
  if not public.shop_stands_alone(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  begin
    update public.shops set site_logo_url = p_url, site_logo_width = p_width, site_logo_height = p_height where id = p_shop_id;
  exception when check_violation then
    raise exception 'picture' using errcode = '22023';
  end;
end;
$$;
revoke execute on function public.owner_set_site_logo(uuid, text, integer, integer) from public, anon;
grant execute on function public.owner_set_site_logo(uuid, text, integer, integer) to authenticated;

/** The header logo of the shop's own domain (public; no row without one: the page then uses the shop's logo). */
create or replace function public.shop_site_logo(p_slug text)
returns table (url text, width integer, height integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.site_logo_url, s.site_logo_width, s.site_logo_height
  from public.shops s
  where s.slug = p_slug and s.is_active and s.site_logo_url is not null
$$;
revoke execute on function public.shop_site_logo(text) from public;
grant execute on function public.shop_site_logo(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ page sections: after the opening hours, pictures

alter table public.shop_page_sections add column if not exists source text not null default 'pdf';
alter table public.shop_page_sections add column if not exists upload_source text;

do $$
declare
  c record;
begin
  -- the position after_hours
  alter table public.shop_page_sections drop constraint if exists shop_page_sections_position_check;
  alter table public.shop_page_sections add constraint shop_page_sections_position_check
    check (position in ('after_details', 'after_map', 'after_hours', 'before_items', 'end'));
  -- a section of pictures has no PDF (update 28: a live version always had one)
  for c in
    select conname from pg_constraint
    where conrelid = 'public.shop_page_sections'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%(version = 0) = (pdf_path IS NULL)%'
  loop
    execute format('alter table public.shop_page_sections drop constraint %I', c.conname);
  end loop;
  alter table public.shop_page_sections drop constraint if exists shop_page_sections_source_pdf_check;
  alter table public.shop_page_sections add constraint shop_page_sections_source_pdf_check check (
    source in ('pdf', 'pictures') and (upload_source is null or upload_source in ('pdf', 'pictures'))
    and ((version = 0 and pdf_path is null) or (version > 0 and (pdf_path is not null) = (source = 'pdf'))));
end;
$$;

-- As in update 30, plus the position after_hours in the owner's order.
create or replace function public.section_visible(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select s.shop_id from public.shop_page_sections s where s.id = p_section_id
  ),
  could as (
    select s.id,
           row_number() over (order by array_position(array['after_details', 'after_map', 'after_hours', 'before_items', 'end'], s.position),
                                       s.sort, s.created_at, s.id) as n
    from public.shop_page_sections s
    join mine on mine.shop_id = s.shop_id
    join public.shops sh on sh.id = s.shop_id
    where s.published and not s.hidden and s.version > 0
      and (s.visible_from is null or s.visible_from <= public.shop_today(s.shop_id))
      and (s.visible_until is null or public.shop_today(s.shop_id) <= s.visible_until)
      and sh.is_active
  )
  select coalesce((
    select c.n <= l.max_sections
    from could c
    cross join mine
    cross join lateral public.section_limits_for(mine.shop_id) l
    where c.id = p_section_id), false)
$$;
revoke execute on function public.section_visible(uuid) from public, anon, authenticated;

-- As in update 30, plus the position after_hours; a free shop's new section goes there (after the opening hours).
create or replace function public.owner_save_section(
  p_shop_id uuid, p_section_id uuid, p_title text, p_display text, p_position text,
  p_allow_download boolean, p_from date, p_until date, p_page_layout text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := public.plain_text(p_title, 80);
  v_id uuid := p_section_id;
  v_plan boolean := public.shop_has_plan(p_shop_id);
  v_position text := p_position;
  v_old_position text;
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if v_title is null or length(btrim(v_title)) = 0 then
    raise exception 'title' using errcode = 'P0001';
  end if;
  if coalesce(p_display, '') not in ('collapsed', 'open')
     or coalesce(p_position, '') not in ('after_details', 'after_map', 'after_hours', 'before_items', 'end')
     or coalesce(p_page_layout, 'slider') not in ('slider', 'stacked') then
    raise exception 'bad' using errcode = 'P0001';
  end if;
  if p_from is not null and p_until is not null and p_until < p_from then
    raise exception 'dates' using errcode = 'P0001';
  end if;

  if v_id is null then
    perform 1 from public.shops where id = p_shop_id for update;
    if (select count(*) from public.shop_page_sections where shop_id = p_shop_id)
       >= coalesce((select l.max_sections from public.section_limits_for(p_shop_id) l), 0) then
      raise exception 'limit' using errcode = 'P0001';
    end if;
    if not v_plan then
      v_position := 'after_hours';
    end if;
    insert into public.shop_page_sections (shop_id, title, display, position, sort, allow_download, visible_from, visible_until,
                                           page_layout)
    values (p_shop_id, v_title, p_display, v_position,
            coalesce((select max(sort) + 1 from public.shop_page_sections where shop_id = p_shop_id and position = v_position), 0),
            coalesce(p_allow_download, false), p_from, p_until, coalesce(p_page_layout, 'slider'))
    returning id into v_id;
    return v_id;
  end if;

  select position into v_old_position from public.shop_page_sections where id = v_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not v_plan then
    v_position := v_old_position;
  end if;
  update public.shop_page_sections
  set title = v_title, display = p_display, position = v_position, allow_download = coalesce(p_allow_download, false),
      visible_from = p_from, visible_until = p_until, page_layout = coalesce(p_page_layout, page_layout), updated_at = now(),
      sort = case when v_position = v_old_position then sort
                  else coalesce((select max(o.sort) + 1 from public.shop_page_sections o
                                 where o.shop_id = p_shop_id and o.position = v_position), 0) end
  where id = v_id;
  return v_id;
end;
$$;
revoke execute on function public.owner_save_section(uuid, uuid, text, text, text, boolean, date, date, text) from public, anon;
grant execute on function public.owner_save_section(uuid, uuid, text, text, text, boolean, date, date, text) to authenticated;

-- As in update 30, plus p_source: 'pdf' (a cleaned PDF is stored) or 'pictures' (no PDF; p_bytes = the largest picture).
drop function if exists public.sections_begin_upload(uuid, integer, integer);
create or replace function public.sections_begin_upload(p_section_id uuid, p_pages integer, p_bytes integer, p_source text default 'pdf')
returns table (version integer, pdf_path text, stale_paths text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.shop_page_sections;
  v_limits record;
  v_version integer;
  v_stale text[];
begin
  select * into v_row from public.shop_page_sections s where s.id = p_section_id for update;
  if not found then
    raise exception 'section' using errcode = 'P0001';
  end if;
  if coalesce(p_source, '') not in ('pdf', 'pictures') then
    raise exception 'bad' using errcode = 'P0001';
  end if;
  select * into v_limits from public.section_limits_for(v_row.shop_id);
  if p_pages is null or p_pages < 1 or p_pages > coalesce(v_limits.max_pages, 0)
     or p_bytes is null or p_bytes < 1 or p_bytes > coalesce(v_limits.max_bytes, 0) then
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
  set upload_version = v_version, upload_pages = p_pages, upload_error = null, upload_source = p_source,
      upload_pdf_bytes = case when p_source = 'pdf' then p_bytes end,
      upload_pdf_path = case when p_source = 'pdf' then format('%s/%s/v%s/section.pdf', v_row.shop_id, p_section_id, v_version) end,
      updated_at = now()
  where s.id = p_section_id;
  insert into public.shop_section_pages (section_id, shop_id, version, page)
  select p_section_id, v_row.shop_id, v_version, n from generate_series(1, p_pages) n;
  return query select v_version,
    case when p_source = 'pdf' then format('%s/%s/v%s/section.pdf', v_row.shop_id, p_section_id, v_version) end, v_stale;
end;
$$;
revoke execute on function public.sections_begin_upload(uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.sections_begin_upload(uuid, integer, integer, text) to service_role;

-- As in update 28, plus the source of the new version (a PDF or pictures).
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
      source = coalesce(s.upload_source, 'pdf'), upload_source = null,
      lang = (select p.lang from public.shop_section_pages p where p.section_id = p_section_id and p.lang is not null limit 1),
      upload_version = null, upload_pages = null, upload_pdf_path = null, upload_pdf_bytes = null, upload_error = null,
      public_version = null, updated_at = now()
  where s.id = p_section_id;
  return query select v_old, v_old_public;
end;
$$;

-- As in update 30, plus after_hours for free shops and in the order, and source (last).
drop function if exists public.shop_sections(text);
create or replace function public.shop_sections(p_slug text)
returns table (id uuid, title text, display text, "position" text, sort integer, allow_download boolean,
               version integer, pages jsonb, page_layout text, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.title, s.display,
         case when public.shop_has_plan(s.shop_id) then s.position else 'after_hours' end,
         s.sort, s.allow_download, s.version,
         coalesce((select jsonb_agg(jsonb_build_object('page', p.page, 'width', p.width, 'height', p.height,
                                                       'ext', p.ext, 'text', p.text) order by p.page)
                   from public.shop_section_pages p
                   where p.section_id = s.id and p.version = s.version), '[]'::jsonb),
         s.page_layout, s.source
  from public.shop_page_sections s
  join public.shops sh on sh.id = s.shop_id
  where sh.slug = p_slug and public.section_shown(s.id)
  order by array_position(array['after_details', 'after_map', 'after_hours', 'before_items', 'end'], s.position), s.sort, s.created_at
$$;
revoke execute on function public.shop_sections(text) from public;
grant execute on function public.shop_sections(text) to anon, authenticated, service_role;

-- As in update 28, only a section made from a PDF (pictures have none to download).
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
  where s.id = p_section_id and sh.slug = p_slug and s.allow_download and s.pdf_path is not null and public.section_shown(s.id)
$$;
revoke execute on function public.shop_section_pdf(text, uuid) from public, anon, authenticated;
grant execute on function public.shop_section_pdf(text, uuid) to service_role;

notify pgrst, 'reload schema';
