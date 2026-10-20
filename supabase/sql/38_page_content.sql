-- PPI · 38 · "Obsah stránky": ONE slider on the shop page with blog posts, PDFs and pictures, arranged by the owner.
--  Paste the whole file into the Supabase SQL Editor and Run. Needs updates 31 and 37. Shop profile content, not stock:
--  - The page sections of updates 28–31 become the shop's LIBRARY of files (shop_page_sections): a PDF (kind 'pdf') or
--    one picture (kind 'picture'; the original, without its place data, kept privately for "Stiahnuť"), with an
--    optional alt text (the owner's, else the AI's). Every file is checked, cleaned and drawn as before.
--  - shop_page_content (the section's title, "Zobraziť názov sekcie", "Vždy otvorené" / "Rozbaľovacie") and
--    shop_content_slots: up to 10 slides in the owner's order — automatic post (the newest posts), pinned post, PDF,
--    picture. A pinned post is never repeated by an automatic slot; slots without a post or file show nothing;
--    hidden, expired or deleted files drop out and the rest keep their order.
--  - Limits per plan are the admin's settings (section_limits): free 5 slides of which 1 PDF, Pro 10; files in the
--    library free 10, Pro 30. A shop back on free keeps every setting and shows only the first slides within its limit.
--  - One rule decides which file is shown (content_slots_shown); its pictures are in the public bucket only then
--    (section_visible(), as before). shop_content() gives the page its slides in one call.
--  - The existing sections are moved into the library and the slider: shown sections first in their old order, then
--    up to three automatic posts (content_materialize()); a shop that never arranged its slider shows the same.
-- Safe to run again.

-- ------------------------------------------------------------------ limits per plan (the admin's settings)

alter table public.section_limits add column if not exists max_slides integer;
alter table public.section_limits add column if not exists max_pdf_slides integer;
alter table public.section_limits add column if not exists max_items integer;
update public.section_limits set max_slides = case plan when 'free' then 5 else 10 end where max_slides is null;
update public.section_limits set max_pdf_slides = case plan when 'free' then 1 else 10 end where max_pdf_slides is null;
update public.section_limits set max_items = case plan when 'free' then 10 else 30 end where max_items is null;
do $$
begin
  -- (the defaults only for a plan's row made by admin_save_section_limits(), which inserts when the row is missing)
  alter table public.section_limits alter column max_slides set default 10;
  alter table public.section_limits alter column max_pdf_slides set default 10;
  alter table public.section_limits alter column max_items set default 30;
  alter table public.section_limits alter column max_slides set not null;
  alter table public.section_limits alter column max_pdf_slides set not null;
  alter table public.section_limits alter column max_items set not null;
  alter table public.section_limits drop constraint if exists section_limits_slides_check;
  alter table public.section_limits add constraint section_limits_slides_check
    check (max_slides between 0 and 10 and max_pdf_slides between 0 and 10 and max_items between 0 and 100);
end;
$$;

/** The slides and files a shop's plan allows now, with the pages and bytes per file. */
create or replace function public.content_limits_for(p_shop_id uuid)
returns table (plan text, max_slides integer, max_pdf_slides integer, max_items integer, max_pages integer, max_bytes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select l.plan, l.max_slides, l.max_pdf_slides, l.max_items, l.max_pages, l.max_mb * 1048576
  from public.section_limits l
  where l.plan = case when public.shop_has_plan(p_shop_id) then 'pro' else 'free' end
$$;
revoke execute on function public.content_limits_for(uuid) from public, anon, authenticated;

/** The admin's "Limity obsahu stránky": slides, of which PDFs, and files in the library, for one plan. */
create or replace function public.admin_save_content_limits(p_plan text, p_max_slides integer, p_max_pdf_slides integer, p_max_items integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if coalesce(p_plan, '') not in ('free', 'pro') or p_max_slides is null or p_max_slides not between 0 and 10
     or p_max_pdf_slides is null or p_max_pdf_slides not between 0 and 10 or p_max_items is null or p_max_items not between 0 and 100 then
    raise exception 'limits' using errcode = 'P0001';
  end if;
  update public.section_limits
  set max_slides = p_max_slides, max_pdf_slides = p_max_pdf_slides, max_items = p_max_items, updated_at = now()
  where plan = p_plan;
end;
$$;
revoke execute on function public.admin_save_content_limits(text, integer, integer, integer) from public, anon;
grant execute on function public.admin_save_content_limits(text, integer, integer, integer) to authenticated;

-- ------------------------------------------------------------------ the library: files (the former page sections)

alter table public.shop_page_sections add column if not exists kind text not null default 'pdf';
alter table public.shop_page_sections add column if not exists show_title boolean not null default true;
alter table public.shop_page_sections add column if not exists file_name text;
alter table public.shop_page_sections add column if not exists alt text;
alter table public.shop_page_sections add column if not exists alt_ai text;
alter table public.shop_page_sections add column if not exists original_path text;
alter table public.shop_page_sections add column if not exists original_bytes integer;
alter table public.shop_page_sections add column if not exists upload_original_path text;
alter table public.shop_page_sections add column if not exists upload_original_bytes integer;
-- A section made of one picture is a picture now (several pictures stay a document of pages, shown like a PDF).
update public.shop_page_sections set kind = 'picture'
where kind = 'pdf' and source = 'pictures' and pages = 1 and version > 0;
do $$
begin
  alter table public.shop_page_sections drop constraint if exists shop_page_sections_kind_check;
  alter table public.shop_page_sections add constraint shop_page_sections_kind_check check (
    kind in ('pdf', 'picture')
    and (kind = 'pdf' or version = 0 or pages = 1)
    and (file_name is null or length(file_name) <= 200)
    and (alt is null or length(alt) <= 250)
    and (alt_ai is null or length(alt_ai) <= 250)
    and (original_path is null or original_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/v[0-9]+/original\.(webp|jpg|png)$')
    and (upload_original_path is null or upload_original_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/v[0-9]+/original\.(webp|jpg|png)$')
    and (original_bytes is null or original_bytes between 1 and 20971520)
    and (upload_original_bytes is null or upload_original_bytes between 1 and 20971520));
end;
$$;

/** A file's own rule: uploaded, not hidden, inside its dates (the shop's day), an active shop. */
create or replace function public.section_item_ready(p_section_id uuid)
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
       and sh.is_active
    from public.shop_page_sections s
    join public.shops sh on sh.id = s.shop_id
    where s.id = p_section_id), false)
$$;
revoke execute on function public.section_item_ready(uuid) from public, anon, authenticated;

/** The rule of update 31 (the owner's old positions and the plan's number of sections), for a shop not arranged yet. */
create or replace function public.section_visible_legacy(p_section_id uuid)
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
revoke execute on function public.section_visible_legacy(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ the slider: settings and slots

create table if not exists public.shop_page_content (
  shop_id    uuid primary key references public.shops (id) on delete cascade,
  -- null = the default "Novinky a ponuky" in the page language
  title      text check (title is null or length(btrim(title)) between 1 and 80),
  show_title boolean not null default true,
  -- 'open' = "Vždy otvorené", 'collapsed' = "Rozbaľovacie"
  display    text not null default 'open' check (display in ('open', 'collapsed')),
  updated_at timestamptz not null default now()
);

create table if not exists public.shop_content_slots (
  id         bigint generated always as identity primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  position   integer not null check (position between 0 and 99),
  kind       text not null check (kind in ('auto_post', 'pinned_post', 'pdf', 'picture')),
  -- a deleted file or post leaves its slot empty (not shown); the owner fills it again or removes it
  item_id    uuid references public.shop_page_sections (id) on delete set null,
  post_id    uuid references public.blog_posts (id) on delete set null,
  check ((kind = 'auto_post' and item_id is null and post_id is null)
      or (kind = 'pinned_post' and item_id is null)
      or (kind in ('pdf', 'picture') and post_id is null)),
  unique (shop_id, position)
);
create unique index if not exists shop_content_slots_item on public.shop_content_slots (shop_id, item_id) where item_id is not null;
create unique index if not exists shop_content_slots_post on public.shop_content_slots (shop_id, post_id) where post_id is not null;

alter table public.shop_page_content enable row level security;
alter table public.shop_content_slots enable row level security;
revoke all on public.shop_page_content, public.shop_content_slots from public, anon, authenticated;
grant select on public.shop_page_content, public.shop_content_slots to authenticated;
grant all on public.shop_page_content, public.shop_content_slots to service_role;
drop policy if exists "shop_page_content: members read" on public.shop_page_content;
create policy "shop_page_content: members read" on public.shop_page_content
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "shop_content_slots: members read" on public.shop_content_slots;
create policy "shop_content_slots: members read" on public.shop_content_slots
  for select to authenticated using (public.is_shop_member(shop_id));

/**
 * The shop's slots in order. A shop that never arranged its slider: the sections shown by the rule of update 31 in
 * their old order, then three automatic posts (what content_materialize() would store).
 */
create or replace function public.content_slots(p_shop_id uuid)
returns table ("position" integer, kind text, item_id uuid, post_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select c.position, c.kind, c.item_id, c.post_id
  from public.shop_content_slots c
  where c.shop_id = p_shop_id and exists (select 1 from public.shop_page_content p where p.shop_id = p_shop_id)
  union all
  select v.position, v.kind, v.item_id, v.post_id
  from (
    select (row_number() over (order by array_position(array['after_details', 'after_map', 'after_hours', 'before_items', 'end'], s.position),
                                         s.sort, s.created_at, s.id) - 1)::integer as position,
           s.kind, s.id as item_id, null::uuid as post_id
    from public.shop_page_sections s
    where s.shop_id = p_shop_id and public.section_visible_legacy(s.id)
    union all
    select 50 + g, 'auto_post', null, null from generate_series(0, 2) g
  ) v
  where not exists (select 1 from public.shop_page_content p where p.shop_id = p_shop_id)
$$;
revoke execute on function public.content_slots(uuid) from public, anon, authenticated;

/**
 * The one rule: the slots shown on the page, numbered. In the owner's order, every automatic or pinned slot counts
 * and every slot whose file can be shown (section_item_ready, the slot's kind); PDFs over the plan's number of PDFs
 * are skipped; the first max_slides are shown. Empty, hidden, expired and deleted files drop out (the rest keep
 * their order). Whether a post fills its slot is decided by shop_content() (never by the files' visibility).
 */
create or replace function public.content_slots_shown(p_shop_id uuid)
returns table (n integer, "position" integer, kind text, item_id uuid, post_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with lim as (
    select l.max_slides, l.max_pdf_slides from public.content_limits_for(p_shop_id) l
  ),
  counted as (
    select c.position, c.kind, c.item_id, c.post_id
    from public.content_slots(p_shop_id) c
    left join public.shop_page_sections s on s.id = c.item_id and s.shop_id = p_shop_id and s.kind = c.kind
    where c.kind in ('auto_post', 'pinned_post') or (s.id is not null and public.section_item_ready(s.id))
  ),
  pdfs as (
    select x.*, case when x.kind = 'pdf'
                     then count(*) filter (where x.kind = 'pdf') over (order by x.position rows between unbounded preceding and current row)
                end as pdf_n
    from counted x
  ),
  kept as (
    select p.*, row_number() over (order by p.position) as k
    from pdfs p cross join lim
    where p.kind <> 'pdf' or p.pdf_n <= lim.max_pdf_slides
  )
  select k.k::integer, k.position, k.kind, k.item_id, k.post_id
  from kept k cross join lim
  where k.k <= lim.max_slides
  order by k.k
$$;
revoke execute on function public.content_slots_shown(uuid) from public, anon, authenticated;

/**
 * Whether a file is shown now: in one of the shown slots. One rule for the page, the assistant, the download and the
 * public bucket (as in updates 28–31, which now ask the slider).
 */
create or replace function public.section_visible(p_section_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.shop_page_sections s, public.content_slots_shown(s.shop_id) x
    where s.id = p_section_id and x.item_id = s.id
  )
$$;
revoke execute on function public.section_visible(uuid) from public, anon, authenticated;

/**
 * Stores what a shop not arranged yet shows (its shown sections, then up to three automatic posts, at most 10), so
 * the owner starts from it. Nothing for a shop already arranged. Used once for every shop by this update.
 */
create or replace function public.content_materialize(p_shop_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if exists (select 1 from public.shop_page_content where shop_id = p_shop_id) then
    return false;
  end if;
  insert into public.shop_content_slots (shop_id, position, kind, item_id)
  select p_shop_id, (row_number() over (order by array_position(array['after_details', 'after_map', 'after_hours', 'before_items', 'end'], s.position),
                                                 s.sort, s.created_at, s.id) - 1)::integer, s.kind, s.id
  from public.shop_page_sections s
  where s.shop_id = p_shop_id and s.published and not s.hidden and s.version > 0
  order by 2
  limit 10;
  get diagnostics v_n = row_count;
  insert into public.shop_content_slots (shop_id, position, kind)
  select p_shop_id, v_n + g, 'auto_post' from generate_series(0, least(3, 10 - v_n) - 1) g;
  insert into public.shop_page_content (shop_id) values (p_shop_id);
  return true;
end;
$$;
revoke execute on function public.content_materialize(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ visitors: the slides in one call

/**
 * The shop page's "Obsah stránky": the settings and the slides in order. Automatic slots take the newest visible
 * posts that are not pinned in a shown slot (fewer posts → fewer slides); pinned slots their post while it is
 * visible; PDF and picture slots their file while its pictures are public (section_shown). Null for an unknown or
 * inactive shop.
 */
create or replace function public.shop_content(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops;
  v_settings public.shop_page_content;
  v_slides jsonb;
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if v_shop.id is null then
    return null;
  end if;
  select * into v_settings from public.shop_page_content where shop_id = v_shop.id;
  with shown as (
    select * from public.content_slots_shown(v_shop.id)
  ),
  vis as (
    select v.* from public.blog_visible_posts(v_shop.id) v
  ),
  pinned as (
    select s.n, s.post_id from shown s join vis on vis.id = s.post_id where s.kind = 'pinned_post'
  ),
  queue as (
    select v.id, row_number() over (order by v.publish_at desc, v.id desc) as k
    from vis v where v.id not in (select p.post_id from pinned p)
  ),
  autos as (
    select s.n, row_number() over (order by s.n) as k from shown s where s.kind = 'auto_post'
  ),
  filled as (
    select a.n, 'post'::text as kind, q.id as post_id, null::uuid as item_id, true as auto
    from autos a join queue q on q.k = a.k
    union all
    select p.n, 'post', p.post_id, null, false from pinned p
    union all
    select s.n, s.kind, null, s.item_id, false
    from shown s where s.kind in ('pdf', 'picture') and public.section_shown(s.item_id)
  )
  select coalesce(jsonb_agg(
           case when f.kind = 'post' then
             jsonb_build_object('kind', 'post', 'auto', f.auto, 'post', (
               select jsonb_build_object(
                        'id', p.id, 'slug', p.slug, 'title', p.title, 'excerpt', left(p.body, 400), 'publish_at', p.publish_at,
                        'source', p.source,
                        'photo', (select ph from jsonb_array_elements(public.blog_photo_list(p.id)) ph limit 1))
               from public.blog_posts p where p.id = f.post_id))
           else
             jsonb_build_object('kind', f.kind, 'item', (
               select jsonb_build_object(
                        'id', s.id, 'title', s.title, 'show_title', s.show_title, 'alt', coalesce(s.alt, s.alt_ai),
                        'version', s.version, 'page_layout', s.page_layout, 'source', s.source,
                        'download', s.allow_download and (s.pdf_path is not null or s.original_path is not null),
                        'pages', coalesce((select jsonb_agg(jsonb_build_object('page', p.page, 'width', p.width, 'height', p.height,
                                                                               'ext', p.ext, 'text', p.text) order by p.page)
                                           from public.shop_section_pages p
                                           where p.section_id = s.id and p.version = s.version), '[]'::jsonb))
               from public.shop_page_sections s where s.id = f.item_id))
           end
         order by f.n), '[]'::jsonb)
  into v_slides
  from filled f;
  return jsonb_build_object(
    'title', v_settings.title,
    'show_title', coalesce(v_settings.show_title, true),
    'display', coalesce(v_settings.display, 'open'),
    'has_posts', exists (select 1 from public.blog_visible_posts(v_shop.id)),
    'slides', v_slides);
end;
$$;
revoke execute on function public.shop_content(text) from public;
grant execute on function public.shop_content(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the owner (Môj obchod → "Obsah stránky")

/** The editor's data: settings, slots, limits, the library and the posts that can fill a slot (members only). */
create or replace function public.owner_content(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings public.shop_page_content;
  v_limits record;
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  select * into v_settings from public.shop_page_content where shop_id = p_shop_id;
  select * into v_limits from public.content_limits_for(p_shop_id);
  return jsonb_build_object(
    'configured', v_settings.shop_id is not null,
    'title', v_settings.title,
    'show_title', coalesce(v_settings.show_title, true),
    'display', coalesce(v_settings.display, 'open'),
    'limits', jsonb_build_object('plan', v_limits.plan, 'max_slides', v_limits.max_slides,
                                 'max_pdf_slides', v_limits.max_pdf_slides, 'max_items', v_limits.max_items,
                                 'max_pages', v_limits.max_pages, 'max_bytes', v_limits.max_bytes),
    'slots', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'item_id', c.item_id, 'post_id', c.post_id)
                                        order by c.position)
                       from public.content_slots(p_shop_id) c), '[]'::jsonb),
    'shown', coalesce((select jsonb_agg(x.position order by x.n) from public.content_slots_shown(p_shop_id) x), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', s.id, 'kind', s.kind, 'title', s.title, 'show_title', s.show_title, 'file_name', s.file_name,
                         'alt', s.alt, 'alt_ai', s.alt_ai, 'allow_download', s.allow_download, 'page_layout', s.page_layout,
                         'visible_from', s.visible_from, 'visible_until', s.visible_until, 'hidden', s.hidden,
                         'version', s.version, 'pages', s.pages, 'source', s.source, 'upload_version', s.upload_version,
                         'upload_error', s.upload_error, 'ready', public.section_item_ready(s.id),
                         'downloadable', s.pdf_path is not null or s.original_path is not null,
                         'width', (select p.width from public.shop_section_pages p where p.section_id = s.id and p.version = s.version and p.page = 1),
                         'height', (select p.height from public.shop_section_pages p where p.section_id = s.id and p.version = s.version and p.page = 1),
                         'created_at', s.created_at)
                       order by s.created_at desc, s.id)
                       from public.shop_page_sections s where s.shop_id = p_shop_id), '[]'::jsonb),
    'posts', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', p.id, 'slug', p.slug, 'title', p.title, 'excerpt', left(p.body, 400), 'publish_at', p.publish_at,
                         'source', p.source,
                         'photo', (select ph from jsonb_array_elements(public.blog_photo_list(p.id)) ph limit 1))
                       order by p.publish_at desc, p.id desc)
                       from public.blog_visible_posts(p_shop_id) p), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_content(uuid) from public, anon;
grant execute on function public.owner_content(uuid) to authenticated;

/**
 * Saves the section's settings and every slot in order (the editor sends the whole list). Errors (P0001): bad, title,
 * limit (more slides than the plan allows — a shop back on free keeps what it had, but cannot add), pdf_limit,
 * duplicate (a file or post twice), item, post (not this shop's, or the wrong kind).
 */
create or replace function public.owner_save_content(p_shop_id uuid, p_title text, p_show_title boolean, p_display text, p_slots jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := nullif(btrim(coalesce(public.plain_text(p_title, 80), '')), '');
  v_limits record;
  v_count integer;
  v_pdfs integer;
  v_old_count integer;
  v_old_pdfs integer;
  v_slot jsonb;
  v_kind text;
  v_item uuid;
  v_post uuid;
  v_i integer := 0;
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if coalesce(p_display, '') not in ('open', 'collapsed') or p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    raise exception 'bad' using errcode = 'P0001';
  end if;
  if p_title is not null and length(btrim(p_title)) > 0 and v_title is null then
    raise exception 'title' using errcode = 'P0001';
  end if;
  perform 1 from public.shops where id = p_shop_id for update;
  select * into v_limits from public.content_limits_for(p_shop_id);
  select count(*), count(*) filter (where c.kind = 'pdf') into v_old_count, v_old_pdfs from public.content_slots(p_shop_id) c;
  v_count := jsonb_array_length(p_slots);
  select count(*) into v_pdfs from jsonb_array_elements(p_slots) e where e ->> 'kind' = 'pdf';
  if v_count > 10 or v_count > greatest(v_limits.max_slides, v_old_count) then
    raise exception 'limit' using errcode = 'P0001';
  end if;
  if v_pdfs > greatest(v_limits.max_pdf_slides, v_old_pdfs) then
    raise exception 'pdf_limit' using errcode = 'P0001';
  end if;

  delete from public.shop_content_slots where shop_id = p_shop_id;
  for v_slot in select e from jsonb_array_elements(p_slots) e loop
    v_kind := v_slot ->> 'kind';
    v_item := null;
    v_post := null;
    if v_kind not in ('auto_post', 'pinned_post', 'pdf', 'picture') then
      raise exception 'bad' using errcode = 'P0001';
    end if;
    if v_kind = 'pinned_post' and nullif(v_slot ->> 'post_id', '') is not null then
      begin
        v_post := (v_slot ->> 'post_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'post' using errcode = 'P0001';
      end;
      if not exists (select 1 from public.blog_posts p where p.id = v_post and p.shop_id = p_shop_id and p.status = 'published') then
        raise exception 'post' using errcode = 'P0001';
      end if;
    end if;
    if v_kind in ('pdf', 'picture') and nullif(v_slot ->> 'item_id', '') is not null then
      begin
        v_item := (v_slot ->> 'item_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'item' using errcode = 'P0001';
      end;
      if not exists (select 1 from public.shop_page_sections s where s.id = v_item and s.shop_id = p_shop_id and s.kind = v_kind) then
        raise exception 'item' using errcode = 'P0001';
      end if;
    end if;
    begin
      insert into public.shop_content_slots (shop_id, position, kind, item_id, post_id) values (p_shop_id, v_i, v_kind, v_item, v_post);
    exception when unique_violation then
      raise exception 'duplicate' using errcode = 'P0001';
    end;
    v_i := v_i + 1;
  end loop;
  insert into public.shop_page_content (shop_id, title, show_title, display, updated_at)
  values (p_shop_id, v_title, coalesce(p_show_title, true), p_display, now())
  on conflict (shop_id) do update
  set title = excluded.title, show_title = excluded.show_title, display = excluded.display, updated_at = now();
  return v_i;
end;
$$;
revoke execute on function public.owner_save_content(uuid, text, boolean, text, jsonb) from public, anon;
grant execute on function public.owner_save_content(uuid, text, boolean, text, jsonb) to authenticated;

/**
 * Adds a file to the library (p_item_id null; then the browser sends the PDF or the picture) or changes its settings.
 * A picture's title is optional: without one its file name is kept as its name (never shown on the page). A new file
 * goes into a free slot of its kind when p_add_slot and the plan has room. Errors (P0001): title, bad, dates, limit
 * (the plan's number of files).
 */
create or replace function public.owner_save_item(
  p_shop_id uuid, p_item_id uuid, p_kind text, p_title text, p_file_name text, p_allow_download boolean,
  p_page_layout text, p_from date, p_until date, p_alt text, p_add_slot boolean default true)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := nullif(btrim(coalesce(public.plain_text(p_title, 80), '')), '');
  v_file text := nullif(btrim(coalesce(public.plain_text(regexp_replace(coalesce(p_file_name, ''), '\.[A-Za-z0-9]{1,5}$', ''), 80), '')), '');
  v_alt text := nullif(btrim(coalesce(public.plain_text(p_alt, 250), '')), '');
  v_id uuid := p_item_id;
  v_kind text;
  v_limits record;
  v_slots integer;
  v_pdfs integer;
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if coalesce(p_page_layout, 'slider') not in ('slider', 'stacked') then
    raise exception 'bad' using errcode = 'P0001';
  end if;
  if p_from is not null and p_until is not null and p_until < p_from then
    raise exception 'dates' using errcode = 'P0001';
  end if;
  if v_id is null then
    v_kind := p_kind;
  else
    select s.kind into v_kind from public.shop_page_sections s where s.id = v_id and s.shop_id = p_shop_id;
    if not found then
      raise exception 'Not your shop' using errcode = '42501';
    end if;
  end if;
  if coalesce(v_kind, '') not in ('pdf', 'picture') then
    raise exception 'bad' using errcode = 'P0001';
  end if;
  -- A PDF needs a title; a picture without one keeps its file name as its name (not shown).
  if v_title is null and (v_kind = 'pdf' or (v_file is null and v_id is null)) then
    raise exception 'title' using errcode = 'P0001';
  end if;

  if v_id is null then
    perform 1 from public.shops where id = p_shop_id for update;
    select * into v_limits from public.content_limits_for(p_shop_id);
    if (select count(*) from public.shop_page_sections where shop_id = p_shop_id) >= v_limits.max_items then
      raise exception 'limit' using errcode = 'P0001';
    end if;
    -- The slider is arranged from now on (a shop not arranged yet keeps what it showed).
    perform public.content_materialize(p_shop_id);
    insert into public.shop_page_sections (shop_id, kind, title, show_title, file_name, display, position, sort, allow_download,
                                           visible_from, visible_until, page_layout, alt, published)
    values (p_shop_id, v_kind, coalesce(v_title, v_file), v_title is not null, left(p_file_name, 200), 'open', 'after_hours',
            coalesce((select max(sort) + 1 from public.shop_page_sections where shop_id = p_shop_id), 0),
            coalesce(p_allow_download, false), p_from, p_until, coalesce(p_page_layout, 'slider'),
            case when v_kind = 'picture' then v_alt end, true)
    returning id into v_id;
    if coalesce(p_add_slot, true) then
      select count(*), count(*) filter (where c.kind = 'pdf') into v_slots, v_pdfs from public.shop_content_slots c where c.shop_id = p_shop_id;
      if v_slots < least(v_limits.max_slides, 10) and (v_kind <> 'pdf' or v_pdfs < v_limits.max_pdf_slides) then
        insert into public.shop_content_slots (shop_id, position, kind, item_id)
        values (p_shop_id, coalesce((select max(c.position) + 1 from public.shop_content_slots c where c.shop_id = p_shop_id), 0), v_kind, v_id);
      end if;
    end if;
    return v_id;
  end if;

  update public.shop_page_sections s
  set title = coalesce(v_title, s.title),
      show_title = case when v_kind = 'picture' then v_title is not null else true end,
      allow_download = coalesce(p_allow_download, false), visible_from = p_from, visible_until = p_until,
      page_layout = coalesce(p_page_layout, s.page_layout),
      alt = case when v_kind = 'picture' then v_alt end,
      updated_at = now()
  where s.id = v_id;
  return v_id;
end;
$$;
revoke execute on function public.owner_save_item(uuid, uuid, text, text, text, boolean, text, date, date, text, boolean) from public, anon;
grant execute on function public.owner_save_item(uuid, uuid, text, text, text, boolean, text, date, date, text, boolean) to authenticated;

-- As in update 30, plus the file's kind (the page-sections function: a picture takes exactly one picture).
drop function if exists public.owner_section(uuid);
create function public.owner_section(p_section_id uuid)
returns table (shop_id uuid, version integer, upload_version integer, upload_pages integer, has_plan boolean,
               plan text, max_pages integer, max_bytes integer, kind text)
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
  select s.shop_id, s.version, s.upload_version, s.upload_pages, public.shop_has_plan(s.shop_id), l.plan, l.max_pages, l.max_bytes, s.kind
  from public.shop_page_sections s
  left join lateral public.section_limits_for(s.shop_id) l on true
  where s.id = p_section_id;
end;
$$;
revoke execute on function public.owner_section(uuid) from public, anon;
grant execute on function public.owner_section(uuid) to authenticated;

-- As in update 28, plus the picture's original (both versions).
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
  cross join lateral unnest(array[s.pdf_path, s.upload_pdf_path, s.original_path, s.upload_original_path]) as x(p)
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

-- ------------------------------------------------------------------ the page-sections function's steps (service role)

-- As in update 31, plus: a picture takes exactly one picture; the picture's original being made ready is dropped
-- with the rest of an unfinished upload.
drop function if exists public.sections_begin_upload(uuid, integer, integer, text);
create function public.sections_begin_upload(p_section_id uuid, p_pages integer, p_bytes integer, p_source text default 'pdf')
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
  if coalesce(p_source, '') not in ('pdf', 'pictures') or (v_row.kind = 'picture' and (p_source <> 'pictures' or p_pages <> 1)) then
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
    select v_row.upload_original_path where v_row.upload_original_path is not null
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
      upload_original_path = null, upload_original_bytes = null,
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

/** A picture's original (place data removed in the browser, at most 4000 px) is stored: its path for the new version. */
create or replace function public.sections_original_stored(p_section_id uuid, p_version integer, p_ext text, p_bytes integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.shop_page_sections;
  v_limits record;
  v_path text;
begin
  select * into v_row from public.shop_page_sections s where s.id = p_section_id for update;
  if not found or v_row.kind <> 'picture' or v_row.upload_version is distinct from p_version then
    raise exception 'version' using errcode = 'P0001';
  end if;
  select * into v_limits from public.section_limits_for(v_row.shop_id);
  if coalesce(p_ext, '') not in ('webp', 'jpg', 'png') or p_bytes is null or p_bytes < 1 or p_bytes > v_limits.max_bytes then
    raise exception 'limits' using errcode = 'P0001';
  end if;
  v_path := format('%s/%s/v%s/original.%s', v_row.shop_id, p_section_id, p_version, p_ext);
  update public.shop_page_sections set upload_original_path = v_path, upload_original_bytes = p_bytes, updated_at = now()
  where id = p_section_id;
  return v_path;
end;
$$;
revoke execute on function public.sections_original_stored(uuid, integer, text, integer) from public, anon, authenticated;
grant execute on function public.sections_original_stored(uuid, integer, text, integer) to service_role;

-- As in update 31, plus the picture's original (needed before a picture goes live; the old one's files go).
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
               and (p.small_bytes is null or p.large_bytes is null or not p.text_done))
     or (v_row.kind = 'picture' and v_row.upload_original_path is null) then
    raise exception 'incomplete' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(x.path), '{}') into v_old from (
    select v_row.pdf_path as path where v_row.pdf_path is not null
    union all
    select v_row.original_path where v_row.original_path is not null
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
      original_path = s.upload_original_path, original_bytes = s.upload_original_bytes,
      source = coalesce(s.upload_source, 'pdf'), upload_source = null,
      lang = (select p.lang from public.shop_section_pages p where p.section_id = p_section_id and p.lang is not null limit 1),
      upload_version = null, upload_pages = null, upload_pdf_path = null, upload_pdf_bytes = null, upload_error = null,
      upload_original_path = null, upload_original_bytes = null,
      public_version = null, updated_at = now()
  where s.id = p_section_id;
  return query select v_old, v_old_public;
end;
$$;

-- As in update 30, plus the file's kind and whether the AI should also write a short alt text (a picture without
-- the owner's).
drop function if exists public.sections_claim_ai(uuid, integer);
create function public.sections_claim_ai(p_section_id uuid, p_limit integer)
returns table (page_id bigint, shop_id uuid, section_id uuid, version integer, page integer, ext text, kind text, wants_alt boolean)
language sql
security definer
set search_path = ''
as $$
  with claimed as (
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
  )
  select c.id, c.shop_id, c.section_id, c.version, c.page, c.ext, s.kind, s.kind = 'picture' and s.alt is null
  from claimed c join public.shop_page_sections s on s.id = c.section_id
$$;
revoke execute on function public.sections_claim_ai(uuid, integer) from public, anon, authenticated;
grant execute on function public.sections_claim_ai(uuid, integer) to service_role;

-- As in update 28, plus the AI's short alt text of a picture (kept apart from the owner's; the owner's wins).
drop function if exists public.sections_save_ai_text(bigint, text, text);
create function public.sections_save_ai_text(p_page_id bigint, p_text text, p_error text, p_alt text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section uuid;
begin
  update public.shop_section_pages
  set text = case when p_error is null then left(coalesce(p_text, ''), 20000) else text end,
      needs_ai = p_error is not null and ai_attempts < 3,
      ai_error = left(p_error, 500)
  where id = p_page_id
  returning section_id into v_section;
  if p_error is null and v_section is not null and nullif(btrim(coalesce(p_alt, '')), '') is not null then
    update public.shop_page_sections set alt_ai = nullif(btrim(public.plain_text(p_alt, 250)), '')
    where id = v_section and kind = 'picture';
  end if;
end;
$$;
revoke execute on function public.sections_save_ai_text(bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.sections_save_ai_text(bigint, text, text, text) to service_role;

-- As in update 31, plus a picture's original ("Stiahnuť"), only while the file is shown and its owner allows it.
create or replace function public.shop_section_pdf(p_slug text, p_section_id uuid)
returns table (path text, title text)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(s.pdf_path, s.original_path), s.title
  from public.shop_page_sections s
  join public.shops sh on sh.id = s.shop_id
  where s.id = p_section_id and sh.slug = p_slug and s.allow_download
    and coalesce(s.pdf_path, s.original_path) is not null and public.section_shown(s.id)
$$;
revoke execute on function public.shop_section_pdf(text, uuid) from public, anon, authenticated;
grant execute on function public.shop_section_pdf(text, uuid) to service_role;

-- ------------------------------------------------------------------ the existing sections move into the slider

do $$
declare
  r record;
begin
  for r in select distinct s.shop_id from public.shop_page_sections s
           where not exists (select 1 from public.shop_page_content c where c.shop_id = s.shop_id) loop
    perform public.content_materialize(r.shop_id);
  end loop;
  -- every uploaded file is a library file now (the old preview step is gone); only slots decide what is shown
  update public.shop_page_sections set published = true where not published and version > 0;
end;
$$;

notify pgrst, 'reload schema';
