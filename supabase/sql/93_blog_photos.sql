-- PPI · database update 93 — blog photos: a ratio and crop per photo line, replace, remove, the cover and its crop, and
-- an imported post's photos that the owner changed (2026-11-07, at the owner's request; his OK for the Facebook sync
-- rule: once the owner changes, adds, removes or reorders a photo of an imported post, Facebook never changes that
-- post's photos again — its text keeps update 77's rule, "deleted on Facebook" still hides it).
--
--   blog_posts.photos_by_owner        true after the owner's first photo change of an imported post
--   blog_posts.cover_photo_id         the post's cover (a photo of THIS post; null = the first photo, as before)
--   blog_posts.cover_focus            the cover's crop: top | center (default) | bottom
--   blog_photos.path_*                a replaced photo's files carry a short suffix (a new address, so no cache
--                                     shows the old picture): "<id>-1600-<8 letters>.webp"
--   blog_photo_list(post)             the cover first, with 'cover' true and its 'focus' (every reader takes the first
--                                     photo as the cover: shop_blog, shop_blog_post, shop_content — no change there)
--   owner_blog_set_cover(post, photo, focus)   members; the photo must be a ready photo of this post
--   owner_blog_photos_take(post)      members; an imported post's photos become the owner's (activity blog_photos_owned)
--   owner_blog_photo_order            as update 37, plus: reordering an imported post's photos takes them
--   blog_photo_swapped(...)           service role (the shop-blog function's photo_replace): the new file into the
--                                     SAME row (the id and every [[foto:<id>]] stay); returns the old file(s) to delete
--   blog_import_post                  as update 77, plus: photos_by_owner → the photos are never touched
--   owner_blog_ai_hit                 as update 77, plus each photo's width / height and the cover
-- Nothing is deleted by this file.

alter table public.blog_posts add column if not exists photos_by_owner boolean not null default false;
alter table public.blog_posts add column if not exists cover_photo_id uuid references public.blog_photos (id) on delete set null;
alter table public.blog_posts add column if not exists cover_focus text not null default 'center';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'blog_posts_cover_focus_check') then
    alter table public.blog_posts add constraint blog_posts_cover_focus_check check (cover_focus in ('top', 'center', 'bottom'));
  end if;
  -- a replaced photo's files: the same names plus "-<8 letters>"
  alter table public.blog_photos drop constraint if exists blog_photos_path_large_check;
  alter table public.blog_photos drop constraint if exists blog_photos_path_small_check;
  alter table public.blog_photos add constraint blog_photos_path_large_check
    check (path_large is null or path_large ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}-(1600|800)(-[0-9a-z]{8})?\.(webp|jpg)$');
  alter table public.blog_photos add constraint blog_photos_path_small_check
    check (path_small is null or path_small ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}-(1600|800)(-[0-9a-z]{8})?\.(webp|jpg)$');
end;
$$;

-- the activity log: the new action
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
begin
  if v_def is not null and position('''blog_photos_owned''' in v_def) = 0 then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''blog_photos_owned''::text, ');
  end if;
end;
$$;

/** A post's ready photos for visitors: the cover first (with 'cover' and its 'focus'), then the others in order. */
create or replace function public.blog_photo_list(p_post_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'kind', f.kind, 'large', f.path_large, 'small', coalesce(f.path_small, f.path_large),
           'width', f.width, 'height', f.height, 'small_width', coalesce(f.small_width, f.width),
           'small_height', coalesce(f.small_height, f.height), 'link', f.link_url)
           || case when f.id = c.cover then jsonb_build_object('cover', true, 'focus', c.focus) else '{}'::jsonb end
         order by (f.id = c.cover) desc, f.position, f.created_at), '[]'::jsonb)
  from public.blog_photos f
  cross join lateral (
    select coalesce(
             (select g.id from public.blog_photos g
              where g.id = p.cover_photo_id and g.status = 'ready' and g.path_large is not null),
             (select g.id from public.blog_photos g
              where g.post_id = p_post_id and g.status = 'ready' and g.path_large is not null
              order by g.position, g.created_at limit 1)) as cover,
           p.cover_focus as focus
    from public.blog_posts p where p.id = p_post_id
  ) c
  where f.post_id = p_post_id and f.status = 'ready' and f.path_large is not null
$$;
revoke execute on function public.blog_photo_list(uuid) from public, anon, authenticated;

/** The cover and its crop (members): a ready photo of THIS post, or null = the first photo; focus top | center | bottom. */
create or replace function public.owner_blog_set_cover(p_post_id uuid, p_photo_id uuid, p_focus text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
begin
  if p_focus is null or p_focus not in ('top', 'center', 'bottom') then
    raise exception 'focus' using errcode = '22023';
  end if;
  if p_photo_id is not null and not exists (
    select 1 from public.blog_photos f where f.id = p_photo_id and f.post_id = v_post.id and f.status = 'ready' and f.kind = 'photo'
  ) then
    raise exception 'photo' using errcode = '22023';
  end if;
  update public.blog_posts set cover_photo_id = p_photo_id, cover_focus = p_focus where id = v_post.id;
  return jsonb_build_object('cover_photo_id', p_photo_id, 'cover_focus', p_focus);
end;
$$;
revoke execute on function public.owner_blog_set_cover(uuid, uuid, text) from public, anon;
grant execute on function public.owner_blog_set_cover(uuid, uuid, text) to authenticated, service_role;

/** An imported post's photos become the owner's (members): from now on no import changes them. Returns true. */
create or replace function public.owner_blog_photos_take(p_post_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
begin
  if v_post.source <> 'cacaduu' and not v_post.photos_by_owner then
    update public.blog_posts set photos_by_owner = true where id = v_post.id;
    insert into public.shop_activity (shop_id, actor, action, details)
    values (v_post.shop_id, auth.uid(), 'blog_photos_owned', jsonb_build_object('post_id', v_post.id));
  end if;
  return true;
end;
$$;
revoke execute on function public.owner_blog_photos_take(uuid) from public, anon;
grant execute on function public.owner_blog_photos_take(uuid) to authenticated, service_role;

/** The photos' order (ids in the new order; others keep theirs after them); an imported post's photos are then the owner's. */
create or replace function public.owner_blog_photo_order(p_post_id uuid, p_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
begin
  perform public.owner_blog_photos_take(v_post.id);
  update public.blog_photos f
  set position = x.n - 1
  from unnest(p_ids) with ordinality as x(id, n)
  where f.id = x.id and f.post_id = v_post.id and x.n <= 100;
end;
$$;
revoke execute on function public.owner_blog_photo_order(uuid, uuid[]) from public, anon;
grant execute on function public.owner_blog_photo_order(uuid, uuid[]) to authenticated;

/**
 * "Vymeniť" (the shop-blog function, service role): one size of the new picture into the SAME photo row; returns the
 * old file(s) of that size, "|"-separated (the function deletes them). Only a ready photo. With p_last on the large
 * size (a small new picture has one size only) the old small file goes too.
 */
create or replace function public.blog_photo_swapped(p_photo_id uuid, p_size integer, p_path text, p_ext text,
                                                     p_width integer, p_height integer, p_last boolean default false)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_small text;
  v_one boolean := coalesce(p_last, false) and p_size = 1600;
begin
  select case when p_size = 1600 then path_large else path_small end, path_small into v_old, v_small
  from public.blog_photos where id = p_photo_id and status = 'ready' for update;
  if not found then raise exception 'photo' using errcode = '22023'; end if;
  update public.blog_photos
  set path_large = case when p_size = 1600 then p_path else path_large end,
      width = case when p_size = 1600 then p_width else width end,
      height = case when p_size = 1600 then p_height else height end,
      path_small = case when p_size = 800 then p_path when v_one then null else path_small end,
      small_width = case when p_size = 800 then p_width when v_one then null else small_width end,
      small_height = case when p_size = 800 then p_height when v_one then null else small_height end,
      ext = p_ext, last_error = null
  where id = p_photo_id;
  return concat_ws('|', v_old, case when v_one and v_small is distinct from v_old then v_small end);
end;
$$;
revoke execute on function public.blog_photo_swapped(uuid, integer, text, text, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.blog_photo_swapped(uuid, integer, text, text, integer, integer, boolean) to service_role;

/**
 * Before "Opraviť gramatiku" / "Skrášliť článok": the post's shop (a member), the plan, the daily limit (the shop's
 * day). Raises no_plan / blog_ai_off / blog_ai_limit. Returns {left, shop_id, source, body_by_owner, shop: {name,
 * address, city, phone, email, website}, photos: [{id, kind, small, width, height}], cover_photo_id} — the post's ready photos in their
 * order (update 93: the cover is cover_photo_id, else the first).
 */
create or replace function public.owner_blog_ai_hit(p_post_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
  v_limit integer := (select blog_daily_limit from public.owner_ai_settings where id);
  v_shop public.shops;
  v_day date;
  v_used integer;
begin
  perform public.crm_owner_check(v_post.shop_id);
  if coalesce(v_limit, 0) = 0 then raise exception 'blog_ai_off' using errcode = 'P0001'; end if;
  select * into v_shop from public.shops where id = v_post.shop_id;
  v_day := (now() at time zone coalesce(v_shop.timezone, 'UTC'))::date;
  perform pg_advisory_xact_lock(hashtext('ppi-blog-ai:' || v_post.shop_id::text));
  select coalesce(sum(calls), 0) into v_used from public.owner_ai_usage
  where shop_id = v_post.shop_id and day = v_day and kind = 'blog';
  if v_used >= v_limit then raise exception 'blog_ai_limit' using errcode = '54000'; end if;
  insert into public.owner_ai_usage (shop_id, user_id, day, kind, calls) values (v_post.shop_id, auth.uid(), v_day, 'blog', 1)
  on conflict (shop_id, user_id, day, kind) do update set calls = public.owner_ai_usage.calls + 1;
  return jsonb_build_object(
    'left', v_limit - v_used - 1,
    'shop_id', v_post.shop_id,
    'source', v_post.source,
    'body_by_owner', v_post.body_by_owner,
    -- update 93: the cover (the AI never places it in the text)
    'cover_photo_id', v_post.cover_photo_id,
    'shop', jsonb_build_object('name', v_shop.name, 'address', v_shop.address, 'city', v_shop.city,
                               'phone', v_shop.phone, 'email', v_shop.email, 'website', v_shop.website),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'small', coalesce(f.path_small, f.path_large),
                                          'width', f.width, 'height', f.height)
             order by f.position, f.created_at)
      from public.blog_photos f
      where f.post_id = v_post.id and f.status = 'ready' and f.path_large is not null), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_blog_ai_hit(uuid) from public, anon;
grant execute on function public.owner_blog_ai_hit(uuid) to authenticated;

/**
 * One Facebook post from the import or the daily sync (update 37), returns {result, post_id, removed}:
 *   own     — Cacaduu's own post published to Facebook (never imported again);
 *   linked  — Cacaduu's post whose "Čítať na webe" link it carries (p_own_slug), now linked to it;
 *   same    — already imported and unchanged;
 *   updated — imported, and changed on Facebook since (text, links, photos; the owner's title stays);
 *   new     — a new post: live at once, or waiting for the owner (Schvaľovať pred zverejnením).
 * Update 93: a post whose photos the owner changed (photos_by_owner) keeps them — the import never touches them.
 * Update 77: a post with the owner's own text (body_by_owner) keeps it — Facebook's text edits are not taken; its
 * links and photos still follow Facebook.
 * p_media: [{kind, fb_media_id, source_url, link_url}] in order; removed: the files of photos that are gone.
 */
create or replace function public.blog_import_post(p_shop_id uuid, p_fb_post_id text, p_title text, p_message text,
                                                   p_created timestamptz, p_updated timestamptz, p_permalink text,
                                                   p_links jsonb, p_media jsonb, p_own_slug text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts;
  v_auto boolean;
  v_id uuid;
  v_removed text[] := '{}';
  v_old_media text[];
  v_new_media text[];
  v_links jsonb := case when jsonb_typeof(p_links) = 'array' then p_links else '[]'::jsonb end;
  v_media jsonb := case when jsonb_typeof(p_media) = 'array' then p_media else '[]'::jsonb end;
  v_title text := left(coalesce(nullif(btrim(p_title), ''), 'Facebook'), 200);
  m jsonb;
begin
  if jsonb_array_length(v_links) > 20 then
    v_links := (select jsonb_agg(e) from (select e from jsonb_array_elements(v_links) e limit 20) x);
  end if;
  select * into v_post from public.blog_posts where shop_id = p_shop_id and fb_post_id = p_fb_post_id for update;
  if v_post.id is not null and v_post.source = 'cacaduu' then
    return jsonb_build_object('result', 'own', 'post_id', v_post.id, 'removed', '[]'::jsonb);
  end if;
  if v_post.id is null and p_own_slug is not null then
    update public.blog_posts
    set fb_post_id = p_fb_post_id, fb_permalink = coalesce(p_permalink, fb_permalink), fb_status = 'posted', fb_error = null
    where shop_id = p_shop_id and slug = p_own_slug and source = 'cacaduu' and fb_post_id is null
    returning id into v_id;
    if v_id is not null then
      return jsonb_build_object('result', 'linked', 'post_id', v_id, 'removed', '[]'::jsonb);
    end if;
  end if;

  select array_agg(e ->> 'fb_media_id' order by n) into v_new_media
  from jsonb_array_elements(v_media) with ordinality as x(e, n);

  if v_post.id is not null then
    select array_agg(f.fb_media_id order by f.position, f.created_at) into v_old_media
    from public.blog_photos f where f.post_id = v_post.id;
    -- Facebook's updated_time also moves when people comment: only a different text, title, link or photo is an edit;
    -- the owner's own text (update 77) is never compared with Facebook's.
    if (v_post.body_by_owner or v_post.body = coalesce(p_message, '')) and v_post.links = v_links
       and (v_post.photos_by_owner or v_old_media is not distinct from v_new_media)
       and (v_post.title_by_owner or v_post.title = v_title) then
      update public.blog_posts
      set fb_checked_at = now(), fb_updated_at = coalesce(p_updated, fb_updated_at),
          fb_permalink = coalesce(p_permalink, fb_permalink)
      where id = v_post.id;
      return jsonb_build_object('result', 'same', 'post_id', v_post.id, 'removed', '[]'::jsonb);
    end if;
    update public.blog_posts
    set body = case when body_by_owner then body else coalesce(p_message, '') end,
        links = v_links, fb_updated_at = p_updated, fb_checked_at = now(),
        fb_permalink = coalesce(p_permalink, fb_permalink),
        title = case when title_by_owner then title else v_title end,
        edited_at = case when status = 'published' then coalesce(p_updated, now()) else edited_at end
    where id = v_post.id;
    -- update 93: the owner's own photos (photos_by_owner) are never changed by an import
    if not v_post.photos_by_owner and v_old_media is distinct from v_new_media then
      select coalesce(array_agg(x.path), '{}') into v_removed
      from public.blog_photos f, unnest(array[f.path_large, f.path_small]) as x(path)
      where f.post_id = v_post.id and x.path is not null;
      delete from public.blog_photos where post_id = v_post.id;
      for m in select e from jsonb_array_elements(v_media) e limit 100 loop
        perform public.blog_photo_add(v_post.id, 'pending', coalesce(m ->> 'kind', 'photo'), m ->> 'fb_media_id',
                                      m ->> 'source_url', m ->> 'link_url');
      end loop;
    end if;
    return jsonb_build_object('result', 'updated', 'post_id', v_post.id, 'removed', to_jsonb(v_removed));
  end if;

  select coalesce((select s.auto_publish from public.shop_blog_settings s where s.shop_id = p_shop_id), true) into v_auto;
  insert into public.blog_posts (shop_id, slug, title, body, source, status, publish_at, fb_post_id, fb_permalink,
                                 fb_updated_at, fb_checked_at, links)
  values (p_shop_id, public.blog_slug(p_shop_id, v_title), v_title, coalesce(p_message, ''), 'facebook',
          case when v_auto then 'published' else 'pending' end, coalesce(p_created, now()), p_fb_post_id, p_permalink,
          p_updated, now(), v_links)
  returning id into v_id;
  for m in select e from jsonb_array_elements(v_media) e limit 100 loop
    perform public.blog_photo_add(v_id, 'pending', coalesce(m ->> 'kind', 'photo'), m ->> 'fb_media_id',
                                  m ->> 'source_url', m ->> 'link_url');
  end loop;
  return jsonb_build_object('result', 'new', 'post_id', v_id, 'removed', '[]'::jsonb);
end;
$$;
revoke execute on function public.blog_import_post(uuid, text, text, text, timestamptz, timestamptz, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.blog_import_post(uuid, text, text, text, timestamptz, timestamptz, text, jsonb, jsonb, text)
  to service_role;
