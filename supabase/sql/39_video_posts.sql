-- ================================================================================================================
-- Update 39: videos in the blog and the slider ("Obsah stránky").
--
-- Paste the whole file into Supabase → SQL Editor → Run. Safe to run again. Needs updates 37 and 38.
--
-- * A Facebook video or reel already comes in as its picture with a link (update 37). A YouTube video shared on the
--   Page came in only as a link card: from now on the shop-blog function also keeps the video's YouTube picture
--   (blog_photos kind 'video', link = the YouTube address); the posts imported before get it here (backfill: the
--   function's job downloads the pictures within minutes).
-- * blog_post_video(post): the post's video for the pages — kind 'facebook' or 'youtube', the YouTube id, the link,
--   and the Facebook post's own address (fb_permalink).
-- * "Tlačidlo ▶ pri videách otvorí" (shop_page_content.video_target): 'post' = the article on Cacaduu (default),
--   'facebook' = the post on Facebook (the Facebook app on a phone that has it); a post that is not on Facebook always
--   opens on Cacaduu. Saved only through owner_save_content(…, p_video_target).
-- * shop_content() and owner_content() return both.
-- ================================================================================================================

-- ------------------------------------------------------------------ YouTube addresses

/** The 11-character id of a YouTube video address (watch, youtu.be, shorts, embed, live, m. and music.), else null. */
create or replace function public.youtube_id(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    substring(p_url from '^https?://(?:www\.|m\.|music\.)?youtube(?:-nocookie)?\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/|v/)([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)'),
    substring(p_url from '^https?://youtu\.be/([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)'))
$$;
grant execute on function public.youtube_id(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the setting

alter table public.shop_page_content add column if not exists video_target text not null default 'post';
do $$
begin
  alter table public.shop_page_content drop constraint if exists shop_page_content_video_target_check;
  alter table public.shop_page_content add constraint shop_page_content_video_target_check
    check (video_target in ('post', 'facebook'));
end;
$$;

-- ------------------------------------------------------------------ a post's video

/**
 * The first video of a post (its picture may still be on its way): {kind: 'youtube'|'facebook', youtube_id, link,
 * facebook_url}. A YouTube link without a picture row counts too. Null: no video.
 */
create or replace function public.blog_post_video(p_post_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with post as (
    select p.id, p.fb_permalink, p.links from public.blog_posts p where p.id = p_post_id
  ),
  found as (
    select f.link_url as link, 0 as rank, f.position from public.blog_photos f
    where f.post_id = p_post_id and f.kind = 'video'
    union all
    select l ->> 'url', 1, (n - 1)::integer from post, jsonb_array_elements(post.links) with ordinality as x(l, n)
    where public.youtube_id(l ->> 'url') is not null
  ),
  first as (
    select link from found order by rank, position limit 1
  )
  select jsonb_build_object(
           'kind', case when public.youtube_id(f.link) is not null then 'youtube' else 'facebook' end,
           'youtube_id', public.youtube_id(f.link),
           'link', f.link,
           'facebook_url', post.fb_permalink)
  from first f, post
$$;
revoke execute on function public.blog_post_video(uuid) from public, anon, authenticated;
grant execute on function public.blog_post_video(uuid) to service_role;

-- ------------------------------------------------------------------ the YouTube pictures of posts imported before

/**
 * Posts from Facebook with a YouTube link and no video picture yet get one 'video' row each (the function's job
 * downloads the picture). Returns how many. Run once here; safe to run again.
 */
create or replace function public.blog_youtube_backfill()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select distinct on (p.id) p.id, public.youtube_id(l ->> 'url') as yt
    from public.blog_posts p, jsonb_array_elements(p.links) with ordinality as x(l, n)
    where p.source = 'facebook' and public.youtube_id(l ->> 'url') is not null
      and not exists (select 1 from public.blog_photos f where f.post_id = p.id and f.kind = 'video')
      and (select count(*) from public.blog_photos f where f.post_id = p.id) < 100
    order by p.id, n
  loop
    perform public.blog_photo_add(r.id, 'pending', 'video', null,
                                  'https://i.ytimg.com/vi/' || r.yt || '/hqdefault.jpg',
                                  'https://www.youtube.com/watch?v=' || r.yt);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.blog_youtube_backfill() from public, anon, authenticated;
select public.blog_youtube_backfill();

-- ------------------------------------------------------------------ the slider: as update 38, plus the videos

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
                        'photo', (select ph from jsonb_array_elements(public.blog_photo_list(p.id)) ph limit 1),
                        'video', public.blog_post_video(p.id))
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
    'video_target', coalesce(v_settings.video_target, 'post'),
    'has_posts', exists (select 1 from public.blog_visible_posts(v_shop.id)),
    'slides', v_slides);
end;
$$;
revoke execute on function public.shop_content(text) from public;
grant execute on function public.shop_content(text) to anon, authenticated, service_role;

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
    'video_target', coalesce(v_settings.video_target, 'post'),
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
                         'photo', (select ph from jsonb_array_elements(public.blog_photo_list(p.id)) ph limit 1),
                         'video', public.blog_post_video(p.id))
                       order by p.publish_at desc, p.id desc)
                       from public.blog_visible_posts(p_shop_id) p), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_content(uuid) from public, anon;
grant execute on function public.owner_content(uuid) to authenticated;

-- The editor's "Uložiť" with the video setting (null = keep it).
drop function if exists public.owner_save_content(uuid, text, boolean, text, jsonb);
create function public.owner_save_content(p_shop_id uuid, p_title text, p_show_title boolean, p_display text, p_slots jsonb,
                                          p_video_target text default null)
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
  if coalesce(p_display, '') not in ('open', 'collapsed') or p_slots is null or jsonb_typeof(p_slots) <> 'array'
     or coalesce(p_video_target, 'post') not in ('post', 'facebook') then
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
  insert into public.shop_page_content (shop_id, title, show_title, display, video_target, updated_at)
  values (p_shop_id, v_title, coalesce(p_show_title, true), p_display, coalesce(p_video_target, 'post'), now())
  on conflict (shop_id) do update
  set title = excluded.title, show_title = excluded.show_title, display = excluded.display,
      video_target = coalesce(p_video_target, public.shop_page_content.video_target), updated_at = now();
  return v_i;
end;
$$;
revoke execute on function public.owner_save_content(uuid, text, boolean, text, jsonb, text) from public, anon;
grant execute on function public.owner_save_content(uuid, text, boolean, text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
