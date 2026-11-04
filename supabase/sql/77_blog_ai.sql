-- PPI · update 77: the blog editor's AI ("Opraviť gramatiku", "Skrášliť článok"), the safe text format and the owner's
-- own text of a Facebook post (2026-11-04, at the owner's request; the owner's OK for the sync rule of point 3)
--
-- 1. owner_blog_ai_hit(post): before every AI action of the blog editor — a member of the shop with the plan, at most
--    owner_ai_settings.blog_daily_limit a day per shop (default 20, the admin's setting; 0 = off), counted in
--    owner_ai_usage (kind blog). Returns what the AI may use: the shop's public details and this post's photos.
--    The AI call itself runs in the translate function (its monthly AI budget, the spend and the 80 % e-mail).
-- 2. owner_blog_own_text(post, title, body): an imported Facebook post rewritten by the owner ("Použiť" + "Uložiť"):
--    body_by_owner — from then on the sync never changes its text (or its title); deleted on Facebook still hides it.
-- 3. blog_import_post(): keeps an owner's text (body_by_owner).
-- 4. shop_blog_post(): 'formatted' — whether the text's marks count (written in Cacaduu, or the owner's own text).
-- 5. The admin's "AI pre majiteľov": the blog limit next to the grammar limit.
--
-- Run once in the Supabase SQL Editor (Claude applies it as 77_blog_ai). Safe to run again.

-- ------------------------------------------------------------------ settings, usage and the post's flag

alter table public.blog_posts add column if not exists body_by_owner boolean not null default false;

alter table public.owner_ai_settings add column if not exists blog_daily_limit integer not null default 20;
alter table public.owner_ai_settings drop constraint if exists owner_ai_settings_blog_daily_limit_check;
alter table public.owner_ai_settings add constraint owner_ai_settings_blog_daily_limit_check
  check (blog_daily_limit between 0 and 1000);

alter table public.owner_ai_usage drop constraint if exists owner_ai_usage_kind_check;
alter table public.owner_ai_usage add constraint owner_ai_usage_kind_check check (kind in ('grammar', 'assistant', 'blog'));

-- ------------------------------------------------------------------ 1. the AI's door

/**
 * Before "Opraviť gramatiku" / "Skrášliť článok": the post's shop (a member), the plan, the daily limit (the shop's
 * day). Raises no_plan / blog_ai_off / blog_ai_limit. Returns {left, shop_id, source, body_by_owner, shop: {name,
 * address, city, phone, email, website}, photos: [{id, kind, small}]} — the post's ready photos in their order (the
 * first is the cover).
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
    'shop', jsonb_build_object('name', v_shop.name, 'address', v_shop.address, 'city', v_shop.city,
                               'phone', v_shop.phone, 'email', v_shop.email, 'website', v_shop.website),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'small', coalesce(f.path_small, f.path_large))
             order by f.position, f.created_at)
      from public.blog_photos f
      where f.post_id = v_post.id and f.status = 'ready' and f.path_large is not null), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_blog_ai_hit(uuid) from public, anon;
grant execute on function public.owner_blog_ai_hit(uuid) to authenticated;

/** After an AI call of the owner's tools: its tokens on today's row (update 76; 'blog' since update 77). Members only. */
create or replace function public.owner_ai_spend(p_shop_id uuid, p_kind text, p_input bigint, p_output bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date;
begin
  if p_shop_id is null or not public.is_shop_member(p_shop_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('grammar', 'assistant', 'blog') then raise exception 'kind' using errcode = '22023'; end if;
  v_day := case when p_kind in ('grammar', 'blog')
                then (now() at time zone coalesce((select timezone from public.shops where id = p_shop_id), 'UTC'))::date
                else current_date end;
  insert into public.owner_ai_usage (shop_id, user_id, day, kind, input_tokens, output_tokens)
  values (p_shop_id, auth.uid(), v_day, p_kind, greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0))
  on conflict (shop_id, user_id, day, kind) do update
  set input_tokens = public.owner_ai_usage.input_tokens + excluded.input_tokens,
      output_tokens = public.owner_ai_usage.output_tokens + excluded.output_tokens;
end;
$$;
revoke execute on function public.owner_ai_spend(uuid, text, bigint, bigint) from public, anon;
grant execute on function public.owner_ai_spend(uuid, text, bigint, bigint) to authenticated;

-- ------------------------------------------------------------------ 2. the owner's own text of an imported post

/**
 * "Použiť" + "Uložiť" on an imported Facebook post: the owner's title and text (as written, the marks of the safe
 * format allowed); body_by_owner and title_by_owner, so the sync never changes them again (a post deleted on Facebook
 * is still hidden). Posts written in Cacaduu use owner_blog_save. Errors: title, body, not_imported.
 */
create or replace function public.owner_blog_own_text(p_post_id uuid, p_title text, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := coalesce(p_body, '');
begin
  if v_post.source <> 'facebook' then raise exception 'not_imported' using errcode = '22023'; end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then raise exception 'title' using errcode = '22023'; end if;
  if btrim(v_body) = '' or char_length(v_body) > 70000 then raise exception 'body' using errcode = '22023'; end if;
  update public.blog_posts
  set title = v_title, body = v_body, body_by_owner = true,
      title_by_owner = title_by_owner or v_title <> v_post.title,
      edited_at = case when status = 'published' and (body <> v_body or title <> v_title) then now() else edited_at end
  where id = v_post.id;
  return v_post.id;
end;
$$;
revoke execute on function public.owner_blog_own_text(uuid, text, text) from public, anon;
grant execute on function public.owner_blog_own_text(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ 3. the sync keeps the owner's text

/**
 * One Facebook post from the import or the daily sync (update 37), returns {result, post_id, removed}:
 *   own     — Cacaduu's own post published to Facebook (never imported again);
 *   linked  — Cacaduu's post whose "Čítať na webe" link it carries (p_own_slug), now linked to it;
 *   same    — already imported and unchanged;
 *   updated — imported, and changed on Facebook since (text, links, photos; the owner's title stays);
 *   new     — a new post: live at once, or waiting for the owner (Schvaľovať pred zverejnením).
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
       and v_old_media is not distinct from v_new_media and (v_post.title_by_owner or v_post.title = v_title) then
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
    if v_old_media is distinct from v_new_media then
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

-- ------------------------------------------------------------------ 4. the post page knows whether marks count

create or replace function public.shop_blog_post(p_slug text, p_post_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', p.id, 'slug', p.slug, 'title', p.title, 'body', p.body, 'source', p.source, 'publish_at', p.publish_at,
           'modified_at', greatest(p.publish_at, coalesce(p.edited_at, p.publish_at)), 'fb_permalink', p.fb_permalink,
           'links', p.links, 'photos', public.blog_photo_list(p.id),
           -- update 77: the safe format's marks count in posts written in Cacaduu and in the owner's own texts
           'formatted', p.source = 'cacaduu' or p.body_by_owner)
  from public.shops s, public.blog_visible_posts(s.id) p
  where s.slug = p_slug and s.is_active and p.slug = p_post_slug
$$;
revoke execute on function public.shop_blog_post(text, text) from public;
grant execute on function public.shop_blog_post(text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 5. the admin's limit

/** "AI pre majiteľov" on the admin page: the limits and today's / this month's use of the owner's AI tools. */
create or replace function public.admin_owner_ai()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'grammar_daily_limit', (select grammar_daily_limit from public.owner_ai_settings where id),
    'blog_daily_limit', (select blog_daily_limit from public.owner_ai_settings where id),
    'today', (select coalesce(jsonb_object_agg(kind, jsonb_build_object('calls', calls, 'input', input, 'output', output)), '{}'::jsonb)
              from (select kind, sum(calls) as calls, sum(input_tokens) as input, sum(output_tokens) as output
                    from public.owner_ai_usage where day = current_date group by kind) x),
    'month', (select coalesce(jsonb_object_agg(kind, jsonb_build_object('calls', calls, 'input', input, 'output', output)), '{}'::jsonb)
              from (select kind, sum(calls) as calls, sum(input_tokens) as input, sum(output_tokens) as output
                    from public.owner_ai_usage where day >= date_trunc('month', current_date)::date group by kind) x));
end;
$$;
revoke execute on function public.admin_owner_ai() from public, anon;
grant execute on function public.admin_owner_ai() to authenticated;

create or replace function public.admin_save_blog_ai(p_blog_daily_limit integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_blog_daily_limit is null or p_blog_daily_limit not between 0 and 1000 then
    raise exception 'limit' using errcode = '22023';
  end if;
  update public.owner_ai_settings set blog_daily_limit = p_blog_daily_limit, updated_at = now() where id;
end;
$$;
revoke execute on function public.admin_save_blog_ai(integer) from public, anon;
grant execute on function public.admin_save_blog_ai(integer) to authenticated;
