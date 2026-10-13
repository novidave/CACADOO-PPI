-- PPI · 30 · Page sections for FREE shops too, with limits per plan that the admin sets.
--  Paste the whole file into the Supabase SQL Editor and Run. Needs update 29. Shop profile content, not stock:
--  - section_limits: per plan (free / pro) the number of sections, pages per PDF and MB per PDF;
--    defaults free 1 / 5 / 10, Pro 10 / 20 / 10; changed only through admin_save_section_limits()
--    (the admin page "Predplatné a domény" → "Limity sekcií (PDF)").
--  - Every shop may add sections up to its plan's number (owner_save_section → 'limit'); a free
--    shop's sections sit after the opening hours, before the items (shop_sections() gives them the
--    position before_items, where a free page has nothing between the hours and the items).
--  - A section is visible only while it is among the first N of its shop's sections that could be
--    shown (published, not hidden, inside its dates; the owner's order: position, then the order
--    within it; N = the plan's number): a Pro shop that goes back to free keeps every section,
--    shows the first one and hides the rest (section_visible()).
--  - Pages and MB per PDF by the shop's plan now (sections_begin_upload, owner_section for the
--    page-sections function); the AI writes out pages without text for every shop's sections;
--    sections_to_sync(p_shop_id) moves the pictures of a whole shop after an owner's action.
--  - The shop assistant (paid plan) gets the sections' text only while the shop has the plan
--    (section_for_assistant()); free shops have no assistant: the text is on the page only.
-- Safe to run again.

-- The limits per plan: the admin's page "Predplatné a domény" → "Limity sekcií (PDF)".
create table if not exists public.section_limits (
  plan         text primary key check (plan in ('free', 'pro')),
  max_sections integer not null check (max_sections between 0 and 50),
  max_pages    integer not null check (max_pages between 1 and 50),
  max_mb       integer not null check (max_mb between 1 and 20),
  updated_at   timestamptz not null default now()
);
insert into public.section_limits (plan, max_sections, max_pages, max_mb)
values ('free', 1, 5, 10), ('pro', 10, 20, 10)
on conflict (plan) do nothing;
alter table public.section_limits enable row level security;
drop policy if exists "section_limits: signed-in users read" on public.section_limits;
create policy "section_limits: signed-in users read" on public.section_limits for select to authenticated using (true);
revoke all on table public.section_limits from anon;
revoke insert, update, delete, truncate on table public.section_limits from authenticated;
grant select on table public.section_limits to authenticated;
grant all on table public.section_limits to service_role;

-- Room for the admin's limits (at most 50 pages and 20 MB per PDF).
do $$
begin
  alter table public.shop_page_sections drop constraint if exists shop_page_sections_pages_check;
  alter table public.shop_page_sections add constraint shop_page_sections_pages_check
    check (pages is null or pages between 1 and 50);
  alter table public.shop_page_sections drop constraint if exists shop_page_sections_upload_pages_check;
  alter table public.shop_page_sections add constraint shop_page_sections_upload_pages_check
    check (upload_pages is null or upload_pages between 1 and 50);
  alter table public.shop_page_sections drop constraint if exists shop_page_sections_pdf_bytes_check;
  alter table public.shop_page_sections add constraint shop_page_sections_pdf_bytes_check
    check (pdf_bytes is null or pdf_bytes between 1 and 20971520);
  alter table public.shop_page_sections drop constraint if exists shop_page_sections_upload_pdf_bytes_check;
  alter table public.shop_page_sections add constraint shop_page_sections_upload_pdf_bytes_check
    check (upload_pdf_bytes is null or upload_pdf_bytes between 1 and 20971520);
  alter table public.shop_section_pages drop constraint if exists shop_section_pages_page_check;
  alter table public.shop_section_pages add constraint shop_section_pages_page_check check (page between 1 and 50);
end;
$$;

/** The section limits of a shop's plan now: 'pro' while shop_has_plan, else 'free'. */
create or replace function public.section_limits_for(p_shop_id uuid)
returns table (plan text, max_sections integer, max_pages integer, max_bytes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select l.plan, l.max_sections, l.max_pages, l.max_mb * 1048576
  from public.section_limits l
  where l.plan = case when public.shop_has_plan(p_shop_id) then 'pro' else 'free' end
$$;
revoke execute on function public.section_limits_for(uuid) from public, anon, authenticated;

/**
 * As in update 28, but the paid plan no longer decides: published, not hidden, a PDF, inside its
 * dates (the shop's day), an active shop, and among the first N such sections of its shop in the
 * owner's order (the positions in their order on the page, then the order within each; N = the
 * plan's number of sections). One rule for the page, the download and the public bucket.
 */
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
           row_number() over (order by array_position(array['after_details', 'after_map', 'before_items', 'end'], s.position),
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

/** Shown on the page and the shop has the paid plan: what the shop assistant may use. */
create or replace function public.section_for_assistant(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.section_shown(p_section_id)
     and public.shop_has_plan((select s.shop_id from public.shop_page_sections s where s.id = p_section_id))
$$;
revoke execute on function public.section_for_assistant(uuid) from public, anon, authenticated;

/** Môj obchod: the shop's plan, its limits and how many sections it has (owners of the shop only). */
create or replace function public.owner_section_limits(p_shop_id uuid)
returns table (plan text, max_sections integer, max_pages integer, max_bytes integer, sections integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return query
  select l.plan, l.max_sections, l.max_pages, l.max_bytes,
         (select count(*)::integer from public.shop_page_sections s where s.shop_id = p_shop_id)
  from public.section_limits_for(p_shop_id) l;
end;
$$;
revoke execute on function public.owner_section_limits(uuid) from public, anon;
grant execute on function public.owner_section_limits(uuid) to authenticated;

/** The admin's "Limity sekcií (PDF)": sections, pages and MB per PDF for one plan. */
create or replace function public.admin_save_section_limits(p_plan text, p_max_sections integer, p_max_pages integer, p_max_mb integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if coalesce(p_plan, '') not in ('free', 'pro') or p_max_sections is null or p_max_sections not between 0 and 50
     or p_max_pages is null or p_max_pages not between 1 and 50 or p_max_mb is null or p_max_mb not between 1 and 20 then
    raise exception 'limits' using errcode = 'P0001';
  end if;
  insert into public.section_limits (plan, max_sections, max_pages, max_mb)
  values (p_plan, p_max_sections, p_max_pages, p_max_mb)
  on conflict (plan) do update
  set max_sections = excluded.max_sections, max_pages = excluded.max_pages, max_mb = excluded.max_mb, updated_at = now();
end;
$$;
revoke execute on function public.admin_save_section_limits(text, integer, integer, integer) from public, anon;
grant execute on function public.admin_save_section_limits(text, integer, integer, integer) to authenticated;

-- As in update 29, but for every shop: up to its plan's
-- number of sections (no longer only with the paid plan); a free shop's new
-- section goes before the items (after the opening hours on its page) and its edits keep the
-- position (a free page has one place for sections).
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
     or coalesce(p_position, '') not in ('after_details', 'after_map', 'before_items', 'end')
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
      v_position := 'before_items';
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

-- As in update 28, plus the plan's limits for the page-sections function (it checks the PDF with them).
drop function if exists public.owner_section(uuid);
create or replace function public.owner_section(p_section_id uuid)
returns table (shop_id uuid, version integer, upload_version integer, upload_pages integer, has_plan boolean,
               plan text, max_pages integer, max_bytes integer)
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
  select s.shop_id, s.version, s.upload_version, s.upload_pages, public.shop_has_plan(s.shop_id), l.plan, l.max_pages, l.max_bytes
  from public.shop_page_sections s
  left join lateral public.section_limits_for(s.shop_id) l on true
  where s.id = p_section_id;
end;
$$;
revoke execute on function public.owner_section(uuid) from public, anon;
grant execute on function public.owner_section(uuid) to authenticated;

-- As in update 28, but for every shop, with the pages and bytes of its plan's limits.
create or replace function public.sections_begin_upload(p_section_id uuid, p_pages integer, p_bytes integer)
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
  set upload_version = v_version, upload_pages = p_pages, upload_pdf_bytes = p_bytes, upload_error = null,
      upload_pdf_path = format('%s/%s/v%s/section.pdf', v_row.shop_id, p_section_id, v_version), updated_at = now()
  where s.id = p_section_id;
  insert into public.shop_section_pages (section_id, shop_id, version, page)
  select p_section_id, v_row.shop_id, v_version, n from generate_series(1, p_pages) n;
  return query select v_version, format('%s/%s/v%s/section.pdf', v_row.shop_id, p_section_id, v_version), v_stale;
end;
$$;

-- As in update 28, plus p_shop_id: every section of one shop (on a free shop one section's change
-- can show or hide another, so the owner's actions move the whole shop's pictures).
drop function if exists public.sections_to_sync(uuid);
create or replace function public.sections_to_sync(p_section_id uuid default null, p_shop_id uuid default null)
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
    and (p_shop_id is null or s.shop_id = p_shop_id)
    and ((v.visible and s.public_version is distinct from s.version)
         or (not v.visible and s.public_version is not null))
  order by s.updated_at
  limit 200
$$;
revoke execute on function public.sections_to_sync(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sections_to_sync(uuid, uuid) to service_role;

-- As in update 28, but for every shop's sections (free shops have sections too).
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
    order by q.id
    limit least(greatest(coalesce(p_limit, 3), 1), 10)
    for update skip locked)
  returning p.id, p.shop_id, p.section_id, p.version, p.page, p.ext
$$;

-- As in update 29, plus a free shop's sections in their one place: before the items, where a
-- free page (no assistant) has nothing between the opening hours and the items.
drop function if exists public.shop_sections(text);
create or replace function public.shop_sections(p_slug text)
returns table (id uuid, title text, display text, "position" text, sort integer, allow_download boolean,
               version integer, pages jsonb, page_layout text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.title, s.display,
         case when public.shop_has_plan(s.shop_id) then s.position else 'before_items' end,
         s.sort, s.allow_download, s.version,
         coalesce((select jsonb_agg(jsonb_build_object('page', p.page, 'width', p.width, 'height', p.height,
                                                       'ext', p.ext, 'text', p.text) order by p.page)
                   from public.shop_section_pages p
                   where p.section_id = s.id and p.version = s.version), '[]'::jsonb),
         s.page_layout
  from public.shop_page_sections s
  join public.shops sh on sh.id = s.shop_id
  where sh.slug = p_slug and public.section_shown(s.id)
  order by array_position(array['after_details', 'after_map', 'before_items', 'end'], s.position), s.sort, s.created_at
$$;
revoke execute on function public.shop_sections(text) from public;
grant execute on function public.shop_sections(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the assistant: only shops with the paid plan

-- As in update 28; the sections' text only while the shop has the paid plan (section_for_assistant).
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
    -- the page sections visitors see now, only for shops with the paid plan (update 30): public, named by their title
    select -sp.id as cid, 'text'::text as ctype, null::uuid as doc_id, null::uuid as pic_id, s.title as src,
           sp.page as pg, null::text as folder_name, true as pub, sp.lang as lng, sp.text as body,
           s.allow_download as dl, sp.search as sv
    from public.shop_page_sections s
    join public.shop_section_pages sp on sp.section_id = s.id and sp.version = s.version
    where s.shop_id = v_shop and btrim(sp.text) <> '' and public.section_for_assistant(s.id)
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
      and public.section_for_assistant(s.id)
      and exists (select 1 from public.shop_section_pages p
                  where p.section_id = s.id and p.version = s.version and btrim(p.text) <> '')
  ) x
  order by x.is_public desc, x.kind, x.name
  limit 50
$$;
revoke execute on function public.shop_docs_list(text, text) from public;
grant execute on function public.shop_docs_list(text, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
