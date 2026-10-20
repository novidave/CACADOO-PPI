-- PPI · 37 · The shop's blog ("Novinky") and its Facebook Page. Paste the whole file into the Supabase SQL Editor and Run.
--  Needs update 36. Shop profile content, never stock:
--  - blog_posts / blog_photos: posts written in Cacaduu (Môj obchod → Novinky / Blog) or imported from the shop's
--    Facebook Page, shown as written (PPI never edits a shop's text). Statuses: draft (being written), published
--    (live from publish_at; "Naplánované" while publish_at is still ahead), hidden ("Skryté"), pending (imported,
--    waiting for the owner when the shop approves imports first). Photos are WebP (JPEG where the owner's browser
--    cannot write WebP) 1600 and 800 px wide in the public bucket "blog-photos" under random names; only the shop-blog
--    Edge Function (service role) writes there.
--  - Visible = published, its time has come, the shop is active, and among the newest N such posts of the shop
--    (blog_limits: free 10, Pro unlimited; the admin changes them). One rule for pages, sitemap, RSS, llms.txt,
--    IndexNow and the shop assistant: blog_visible_ids().
--  - facebook_connections: one Facebook Page per shop; its token only encrypted by the function
--    (FB_TOKEN_ENCRYPTION_KEY), never readable by owners or visitors; "Odpojiť" deletes it. OAuth states (SHA-256,
--    10 minutes, single use) and the pages to choose from (encrypted, 10 minutes).
--  - Facebook: the one-time import of all past posts, the daily sync (new, edited, deleted → hidden), publishing a
--    Cacaduu post to the Page ("Web + Facebook") now or at its time, retries, one e-mail when the connection expires.
--    Never comments, reactions or other people's names.
--  - IndexNow for new and changed posts (per host: the shop's live own domain, else the main Cacaduu domain; with the
--    stock's hourly limit per host), the job ppi-blog-tick every 5 minutes.
-- Safe to run again.

-- ------------------------------------------------------------------ limits (admin)

create table if not exists public.blog_limits (
  plan       text primary key check (plan in ('free', 'pro')),
  -- the newest N posts are visible; null = all
  max_posts  integer check (max_posts is null or max_posts between 0 and 10000),
  updated_at timestamptz not null default now()
);
insert into public.blog_limits (plan, max_posts) values ('free', 10), ('pro', null) on conflict (plan) do nothing;
alter table public.blog_limits enable row level security;
drop policy if exists "blog_limits: signed-in users read" on public.blog_limits;
create policy "blog_limits: signed-in users read" on public.blog_limits for select to authenticated using (true);
revoke all on table public.blog_limits from public, anon;
revoke insert, update, delete, truncate on table public.blog_limits from authenticated;
grant select on table public.blog_limits to authenticated;
grant all on table public.blog_limits to service_role;

-- ------------------------------------------------------------------ posts and photos

create table if not exists public.blog_posts (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  slug             text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  title            text not null check (char_length(btrim(title)) between 1 and 200),
  -- the text as written (Facebook allows 63,206 characters)
  body             text not null default '' check (char_length(body) <= 70000),
  source           text not null default 'cacaduu' check (source in ('cacaduu', 'facebook')),
  status           text not null default 'draft' check (status in ('draft', 'published', 'hidden', 'pending')),
  -- live from (published); Facebook's created time for imported posts
  publish_at       timestamptz,
  -- the last change of a live post (dateModified)
  edited_at        timestamptz,
  -- Cacaduu posts: "Web + Facebook" or "Len web"; the Facebook copy's state
  fb_choice        text check (fb_choice in ('web', 'web_fb')),
  fb_status        text check (fb_status in ('waiting', 'posting', 'posted', 'failed')),
  fb_error         text check (fb_error is null or char_length(fb_error) <= 300),
  fb_tries         integer not null default 0,
  fb_posting_at    timestamptz,
  -- Facebook's post id: imported posts, and Cacaduu posts once published there (never imported again)
  fb_post_id       text check (fb_post_id is null or fb_post_id ~ '^[0-9]{1,40}(_[0-9]{1,40})?$'),
  fb_permalink     text check (fb_permalink is null or (fb_permalink ~ '^https://([a-z0-9-]+\.)?facebook\.com/' and char_length(fb_permalink) <= 500)),
  fb_updated_at    timestamptz,
  fb_deleted_at    timestamptz,
  fb_checked_at    timestamptz,
  -- the owner changed an imported post's title: Facebook's edits keep it
  title_by_owner   boolean not null default false,
  -- shared links, events, videos: [{kind: link|event|video, url, title, description}]
  links            jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 20),
  search           text generated always as (public.search_text(title || ' ' || body)) stored,
  -- IndexNow: changed (title, text, links, visibility) at / sent at
  indexnow_at      timestamptz,
  indexnow_sent_at timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint blog_posts_slug_unique unique (shop_id, slug),
  constraint blog_posts_publish_at check (status in ('draft', 'pending') or publish_at is not null)
);
create unique index if not exists blog_posts_fb_post on public.blog_posts (shop_id, fb_post_id) where fb_post_id is not null;
create index if not exists blog_posts_shop_live on public.blog_posts (shop_id, publish_at desc, id desc) where status = 'published';
create index if not exists blog_posts_fb_due on public.blog_posts (publish_at) where fb_status in ('waiting', 'posting');
create index if not exists blog_posts_indexnow on public.blog_posts (indexnow_at) where indexnow_at is not null;

create table if not exists public.blog_photos (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.blog_posts (id) on delete cascade,
  shop_id      uuid not null references public.shops (id) on delete cascade,
  position     integer not null check (position between 0 and 99),
  -- a photo, or a video's picture (the video itself stays on Facebook: link_url)
  kind         text not null default 'photo' check (kind in ('photo', 'video')),
  link_url     text check (link_url is null or (link_url ~ '^https://' and char_length(link_url) <= 1000)),
  -- uploading (the owner's browser) / pending (an import: the function converts it) / ready / failed
  status       text not null default 'uploading' check (status in ('uploading', 'pending', 'ready', 'failed')),
  ext          text check (ext in ('webp', 'jpg')),
  path_large   text check (path_large is null or path_large ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}-(1600|800)\.(webp|jpg)$'),
  path_small   text check (path_small is null or path_small ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}-(1600|800)\.(webp|jpg)$'),
  width        integer check (width is null or width between 1 and 1600),
  height       integer check (height is null or height between 1 and 10000),
  small_width  integer check (small_width is null or small_width between 1 and 800),
  small_height integer check (small_height is null or small_height between 1 and 10000),
  -- imports: Facebook's photo id (the full picture is read when it is converted) and its picture address then
  fb_media_id  text check (fb_media_id is null or fb_media_id ~ '^[0-9_]{1,80}$'),
  source_url   text check (source_url is null or (source_url ~ '^https://' and char_length(source_url) <= 2000)),
  attempts     integer not null default 0,
  next_try_at  timestamptz,
  last_error   text check (last_error is null or char_length(last_error) <= 300),
  created_at   timestamptz not null default now()
);
create index if not exists blog_photos_post on public.blog_photos (post_id, position);
create index if not exists blog_photos_due on public.blog_photos (next_try_at) where status = 'pending';

create table if not exists public.shop_blog_settings (
  shop_id      uuid primary key references public.shops (id) on delete cascade,
  -- imported posts: live at once ("Publikovať importované príspevky automaticky") or wait for the owner
  auto_publish boolean not null default true,
  -- the owner's last answer in the publish dialog (pre-selected next time)
  last_choice  text check (last_choice in ('web', 'web_fb')),
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------ the Facebook Page

create table if not exists public.facebook_connections (
  shop_id            uuid primary key references public.shops (id) on delete cascade,
  page_id            text not null check (page_id ~ '^[0-9]{1,40}$'),
  page_name          text not null check (char_length(page_name) between 1 and 200),
  -- the Page's picture for the preview (Facebook's address, refreshed by the daily sync)
  page_picture       text check (page_picture is null or (page_picture ~ '^https://' and char_length(page_picture) <= 2000)),
  -- encrypted by the shop-blog function; never readable by owners or visitors
  page_token_enc     text not null,
  scopes             text check (scopes is null or char_length(scopes) <= 500),
  -- the website the owner connected from (links in the e-mail)
  site_url           text check (site_url is null or site_url ~ '^https?://'),
  status             text not null default 'ok' check (status in ('ok', 'expired')),
  last_error         text check (last_error is null or char_length(last_error) <= 300),
  connected_by       uuid,
  connected_at       timestamptz not null default now(),
  -- "Stiahnuť všetky príspevky": idle / running (page by page) / done / failed
  import_state       text not null default 'idle' check (import_state in ('idle', 'running', 'done', 'failed')),
  import_cursor      text check (import_cursor is null or char_length(import_cursor) <= 2000),
  import_count       integer not null default 0,
  import_started_at  timestamptz,
  import_finished_at timestamptz,
  import_error       text check (import_error is null or char_length(import_error) <= 300),
  -- one call works on the import at a time (the chain, or the job when the chain broke)
  import_lease_at    timestamptz,
  last_sync_at       timestamptz,
  next_sync_at       timestamptz,
  sync_running_at    timestamptz,
  failing_since      timestamptz,
  alert_sent_at      timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists facebook_connections_page on public.facebook_connections (page_id);

create table if not exists public.facebook_oauth_states (
  state_hash text primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  user_id    uuid not null,
  return_url text not null check (return_url ~ '^https?://' and char_length(return_url) <= 600),
  expires_at timestamptz not null
);

-- The Pages the owner may pick after logging in (encrypted with their tokens; 10 minutes).
create table if not exists public.facebook_pending_pages (
  id         uuid primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  user_id    uuid not null,
  pages_enc  text not null,
  return_url text not null check (return_url ~ '^https?://' and char_length(return_url) <= 600),
  scopes     text,
  expires_at timestamptz not null
);

-- ------------------------------------------------------------------ access

alter table public.blog_posts enable row level security;
alter table public.blog_photos enable row level security;
alter table public.shop_blog_settings enable row level security;
alter table public.facebook_connections enable row level security;
alter table public.facebook_oauth_states enable row level security;
alter table public.facebook_pending_pages enable row level security;

revoke all on public.blog_posts, public.blog_photos, public.shop_blog_settings, public.facebook_connections,
  public.facebook_oauth_states, public.facebook_pending_pages from public, anon, authenticated;
grant all on public.blog_posts, public.blog_photos, public.shop_blog_settings, public.facebook_connections,
  public.facebook_oauth_states, public.facebook_pending_pages to service_role;
-- Owners read their posts, photos and settings; writes only through the owner_blog_* functions and shop-blog.
grant select on public.blog_posts, public.blog_photos, public.shop_blog_settings to authenticated;
-- Owners see which Page is connected and how the import goes; never the token.
grant select (shop_id, page_id, page_name, page_picture, status, last_error, connected_at, import_state, import_count,
              import_started_at, import_finished_at, import_error, last_sync_at, next_sync_at, failing_since)
  on public.facebook_connections to authenticated;

drop policy if exists "blog_posts: members read" on public.blog_posts;
create policy "blog_posts: members read" on public.blog_posts for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "blog_photos: members read" on public.blog_photos;
create policy "blog_photos: members read" on public.blog_photos for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "shop_blog_settings: members read" on public.shop_blog_settings;
create policy "shop_blog_settings: members read" on public.shop_blog_settings for select to authenticated
  using (public.is_shop_member(shop_id));
drop policy if exists "facebook_connections: members read" on public.facebook_connections;
create policy "facebook_connections: members read" on public.facebook_connections for select to authenticated
  using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ helpers

/** A post's address from its title: "Nová kolekcia jar 2026!" → "nova-kolekcia-jar-2026" (unique in the shop). */
create or replace function public.blog_slug(p_shop_id uuid, p_title text, p_post_id uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base text := btrim(left(btrim(regexp_replace(public.search_text(p_title), '[^a-z0-9]+', '-', 'g'), '-'), 60), '-');
  v_slug text;
  v_n integer := 1;
begin
  if v_base = '' then
    v_base := 'prispevok';
  end if;
  v_slug := v_base;
  while exists (select 1 from public.blog_posts p where p.shop_id = p_shop_id and p.slug = v_slug
                and p.id is distinct from p_post_id) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;
  return v_slug;
end;
$$;
revoke execute on function public.blog_slug(uuid, text, uuid) from public, anon, authenticated;

/**
 * The one visibility rule: the posts that may be shown — published, their time has come, the shop is active, and
 * among the newest N such posts of their shop (N = the plan's limit; null = all). One shop, or every shop (null).
 */
create or replace function public.blog_visible_posts(p_shop_id uuid default null)
returns setof public.blog_posts
language sql
stable
security definer
set search_path = ''
as $$
  select (x.p).*
  from (
    select p, row_number() over (partition by p.shop_id order by p.publish_at desc, p.id desc) as n,
           (select l.max_posts from public.blog_limits l
            where l.plan = case when public.shop_has_plan(p.shop_id) then 'pro' else 'free' end) as lim
    from public.blog_posts p
    join public.shops s on s.id = p.shop_id
    where (p_shop_id is null or p.shop_id = p_shop_id) and s.is_active and p.status = 'published' and p.publish_at <= now()
  ) x
  where x.lim is null or x.n <= x.lim
$$;
revoke execute on function public.blog_visible_posts(uuid) from public, anon, authenticated;
grant execute on function public.blog_visible_posts(uuid) to service_role;

create or replace function public.blog_visible_ids(p_shop_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id from public.blog_visible_posts(p_shop_id) v
$$;
revoke execute on function public.blog_visible_ids(uuid) from public, anon, authenticated;
grant execute on function public.blog_visible_ids(uuid) to service_role;

create or replace function public.blog_post_visible(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blog_posts p, public.blog_visible_posts(p.shop_id) v
    where p.id = p_post_id and v.id = p.id
  )
$$;
revoke execute on function public.blog_post_visible(uuid) from public, anon, authenticated;
grant execute on function public.blog_post_visible(uuid) to service_role;

/** A post's photos as the pages use them (ready ones, in order). */
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
         order by f.position, f.created_at), '[]'::jsonb)
  from public.blog_photos f
  where f.post_id = p_post_id and f.status = 'ready' and f.path_large is not null
$$;
revoke execute on function public.blog_photo_list(uuid) from public, anon, authenticated;

-- IndexNow and dateModified: a live post's title, text, links or visibility changed.
create or replace function public.blog_posts_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.status in ('published', 'hidden') then
      new.indexnow_at := now();
    end if;
    return new;
  end if;
  if new.title is distinct from old.title or new.body is distinct from old.body or new.links is distinct from old.links
     or new.status is distinct from old.status or new.publish_at is distinct from old.publish_at
     or new.slug is distinct from old.slug then
    if new.status in ('published', 'hidden') or old.status in ('published', 'hidden') then
      new.indexnow_at := now();
    end if;
    -- a change of what a visitor already saw (an import sets Facebook's edit time itself)
    if old.status = 'published' and old.publish_at <= now() and new.status = 'published'
       and new.edited_at is not distinct from old.edited_at
       and (new.title is distinct from old.title or new.body is distinct from old.body or new.links is distinct from old.links) then
      new.edited_at := now();
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists blog_posts_touch on public.blog_posts;
create trigger blog_posts_touch before insert or update on public.blog_posts
  for each row execute function public.blog_posts_touch();

-- A live post's shown photos changed (one ready, removed or moved): IndexNow, and dateModified of the owner's own
-- posts (an imported post's photos arriving after the import are no edit).
create or replace function public.blog_photos_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post uuid;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'ready' then return new; end if;
    v_post := new.post_id;
  elsif tg_op = 'DELETE' then
    if old.status <> 'ready' then return old; end if;
    v_post := old.post_id;
  else
    if (new.status = 'ready') = (old.status = 'ready') and (new.status <> 'ready' or new.position = old.position) then
      return new;
    end if;
    v_post := new.post_id;
  end if;
  update public.blog_posts
  set edited_at = case when source = 'cacaduu' and status = 'published' and publish_at <= now() - interval '1 minute'
                       then now() else edited_at end,
      indexnow_at = case when status in ('published', 'hidden') then now() else indexnow_at end
  where id = v_post;
  return coalesce(new, old);
end;
$$;
drop trigger if exists blog_photos_touch on public.blog_photos;
create trigger blog_photos_touch after insert or update or delete on public.blog_photos
  for each row execute function public.blog_photos_touch();

-- ------------------------------------------------------------------ what visitors read (anon)

/** The shop's blog page: the visible posts, newest first, p_per_page (≤ 50) per page, with the first photo. */
create or replace function public.shop_blog(p_slug text, p_page integer default 1, p_per_page integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops;
  v_per integer := least(greatest(coalesce(p_per_page, 12), 1), 50);
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_total integer;
  v_posts jsonb;
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if v_shop.id is null then
    return null;
  end if;
  select count(*) into v_total from public.blog_visible_posts(v_shop.id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', p.slug, 'title', p.title, 'body', p.body, 'source', p.source, 'publish_at', p.publish_at,
           'modified_at', greatest(p.publish_at, coalesce(p.edited_at, p.publish_at)), 'fb_permalink', p.fb_permalink,
           'links', p.links, 'photos', public.blog_photo_list(p.id))
         order by p.publish_at desc, p.id desc), '[]'::jsonb)
  into v_posts
  from (
    select v.* from public.blog_visible_posts(v_shop.id) v
    order by v.publish_at desc, v.id desc
    offset (v_page - 1) * v_per limit v_per
  ) p;
  return jsonb_build_object('total', v_total, 'page', v_page, 'per_page', v_per, 'posts', v_posts);
end;
$$;
revoke execute on function public.shop_blog(text, integer, integer) from public;
grant execute on function public.shop_blog(text, integer, integer) to anon, authenticated, service_role;

/** One visible post with every photo, or null. */
create or replace function public.shop_blog_post(p_slug text, p_post_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'slug', p.slug, 'title', p.title, 'body', p.body, 'source', p.source, 'publish_at', p.publish_at,
           'modified_at', greatest(p.publish_at, coalesce(p.edited_at, p.publish_at)), 'fb_permalink', p.fb_permalink,
           'links', p.links, 'photos', public.blog_photo_list(p.id))
  from public.shops s, public.blog_visible_posts(s.id) p
  where s.slug = p_slug and s.is_active and p.slug = p_post_slug
$$;
revoke execute on function public.shop_blog_post(text, text) from public;
grant execute on function public.shop_blog_post(text, text) to anon, authenticated, service_role;

/** How many posts the shop shows (the "Novinky" link only with at least one). */
create or replace function public.shop_blog_count(p_slug text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.shops s, public.blog_visible_posts(s.id) v where s.slug = p_slug and s.is_active
$$;
revoke execute on function public.shop_blog_count(text) from public;
grant execute on function public.shop_blog_count(text) to anon, authenticated, service_role;

/** Every visible post of every active shop (the sitemaps): shop, post, last change. */
create or replace function public.blog_index(p_slug text default null, p_limit integer default 45000)
returns table (shop_slug text, post_slug text, title text, publish_at timestamptz, modified_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.slug, p.slug, p.title, p.publish_at, greatest(p.publish_at, coalesce(p.edited_at, p.publish_at))
  from public.blog_visible_posts(case when p_slug is null then null
                                      else (select x.id from public.shops x where x.slug = p_slug) end) p
  join public.shops s on s.id = p.shop_id
  where p_slug is null or s.slug = p_slug
  order by s.slug, p.publish_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 45000), 1), 50000)
$$;
revoke execute on function public.blog_index(text, integer) from public;
grant execute on function public.blog_index(text, integer) to anon, authenticated, service_role;

/**
 * The shop assistant (paid plan): the shop's visible posts whose title or text has every word of the query
 * (accents and case ignored), newest first.
 */
create or replace function public.search_shop_blog(p_slug text, p_query text, p_limit integer default 4)
returns table (post_slug text, title text, publish_at timestamptz, body text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.slug, p.title, p.publish_at, p.body
  from public.shops s, public.blog_visible_posts(s.id) p
  where s.slug = p_slug and s.is_active and coalesce(btrim(p_query), '') <> ''
    and public.matches_all_words(p.search, p_query)
  order by p.publish_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 4), 1), 10)
$$;
revoke execute on function public.search_shop_blog(text, text, integer) from public;
grant execute on function public.search_shop_blog(text, text, integer) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ owners (Môj obchod → Novinky / Blog)

create or replace function public.blog_member_post(p_post_id uuid)
returns public.blog_posts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts;
begin
  select * into v_post from public.blog_posts where id = p_post_id;
  if v_post.id is null or not public.is_shop_member(v_post.shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return v_post;
end;
$$;
revoke execute on function public.blog_member_post(uuid) from public, anon, authenticated;

/** The dashboard's list: every post with its state, whether it is visible now and its first photo. */
create or replace function public.owner_blog_posts(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  select l.max_posts into v_limit from public.blog_limits l
  where l.plan = case when public.shop_has_plan(p_shop_id) then 'pro' else 'free' end;
  return jsonb_build_object(
    'limit', v_limit,
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'slug', p.slug, 'title', p.title, 'source', p.source, 'status', p.status,
               'publish_at', p.publish_at, 'edited_at', p.edited_at, 'created_at', p.created_at,
               'fb_choice', p.fb_choice, 'fb_status', p.fb_status, 'fb_error', p.fb_error, 'fb_permalink', p.fb_permalink,
               'fb_deleted_at', p.fb_deleted_at, 'visible', p.id in (select v.id from public.blog_visible_posts(p_shop_id) v),
               'photos', (select count(*) from public.blog_photos f where f.post_id = p.id and f.status = 'ready'),
               'photos_waiting', (select count(*) from public.blog_photos f where f.post_id = p.id and f.status = 'pending'),
               'photo', (select coalesce(f.path_small, f.path_large) from public.blog_photos f
                         where f.post_id = p.id and f.status = 'ready' order by f.position, f.created_at limit 1))
             order by coalesce(p.publish_at, p.created_at) desc, p.id desc)
      from public.blog_posts p where p.shop_id = p_shop_id), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_blog_posts(uuid) from public, anon;
grant execute on function public.owner_blog_posts(uuid) to authenticated, service_role;

/** One post for the editor (with every photo, also those still converting). */
create or replace function public.owner_blog_post(p_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
begin
  return to_jsonb(v_post) - 'search' - 'indexnow_at' - 'indexnow_sent_at' || jsonb_build_object(
    'visible', public.blog_post_visible(v_post.id),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'status', f.status, 'large', f.path_large,
               'small', coalesce(f.path_small, f.path_large), 'width', f.width, 'height', f.height, 'link', f.link_url)
             order by f.position, f.created_at)
      from public.blog_photos f where f.post_id = v_post.id and f.status <> 'uploading'), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_blog_post(uuid) from public, anon;
grant execute on function public.owner_blog_post(uuid) to authenticated, service_role;

/**
 * "Nový článok" / "Uložiť": a new draft (p_post_id null) or the post's title and text, as written. The address
 * follows the title until the post is first published, then stays. An imported post's text stays Facebook's; only
 * its title changes (and Facebook's edits then keep the owner's title). Errors: title, imported_text.
 */
create or replace function public.owner_blog_save(p_shop_id uuid, p_post_id uuid, p_title text, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := coalesce(p_body, '');
  v_post public.blog_posts;
  v_id uuid;
begin
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'title' using errcode = '22023';
  end if;
  if char_length(v_body) > 70000 then
    raise exception 'body' using errcode = '22023';
  end if;
  if p_post_id is null then
    if not public.is_shop_member(p_shop_id) then
      raise exception 'Not your shop' using errcode = '42501';
    end if;
    insert into public.blog_posts (shop_id, slug, title, body, source, status, created_by)
    values (p_shop_id, public.blog_slug(p_shop_id, v_title), v_title, v_body, 'cacaduu', 'draft', auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  v_post := public.blog_member_post(p_post_id);
  if v_post.shop_id <> p_shop_id then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if v_post.source = 'facebook' then
    if v_body <> '' and v_body <> v_post.body then
      raise exception 'imported_text' using errcode = '22023';
    end if;
    update public.blog_posts
    set title = v_title, title_by_owner = title_by_owner or v_title <> v_post.title
    where id = v_post.id;
    return v_post.id;
  end if;
  update public.blog_posts
  set title = v_title, body = v_body,
      slug = case when v_post.status = 'draft' then public.blog_slug(v_post.shop_id, v_title, v_post.id) else slug end
  where id = v_post.id;
  return v_post.id;
end;
$$;
revoke execute on function public.owner_blog_save(uuid, uuid, text, text) from public, anon;
grant execute on function public.owner_blog_save(uuid, uuid, text, text) to authenticated;

/**
 * "Zverejniť" / "Naplánovať" after the publish dialog: live now (p_publish_at null or past) or at p_publish_at (at most
 * a year ahead), "Web + Facebook" or "Len web" (remembered for the next dialog). A scheduled post can be published
 * again until its time (new time or choice). Errors: published (already live: edits never go to Facebook), choice,
 * no_facebook, when.
 * Returns {publish_at, scheduled, facebook_now}: facebook_now = the function posts it to the Page right away.
 */
create or replace function public.owner_blog_publish(p_post_id uuid, p_publish_at timestamptz, p_fb_choice text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
  v_at timestamptz := greatest(coalesce(p_publish_at, now()), now());
begin
  if p_fb_choice is null or p_fb_choice not in ('web', 'web_fb') then
    raise exception 'choice' using errcode = '22023';
  end if;
  if v_post.source <> 'cacaduu' or v_post.status not in ('draft', 'published')
     or (v_post.status = 'published' and v_post.publish_at <= now()) or v_post.fb_status in ('posting', 'posted') then
    raise exception 'published' using errcode = '55000';
  end if;
  if p_publish_at is not null and p_publish_at > now() + interval '366 days' then
    raise exception 'when' using errcode = '22023';
  end if;
  if p_fb_choice = 'web_fb' and not exists (
    select 1 from public.facebook_connections c where c.shop_id = v_post.shop_id and c.status = 'ok') then
    raise exception 'no_facebook' using errcode = '55000';
  end if;
  update public.blog_posts
  set status = 'published', publish_at = v_at, fb_choice = p_fb_choice,
      fb_status = case when p_fb_choice = 'web_fb' then 'waiting' else null end, fb_error = null, fb_tries = 0
  where id = v_post.id;
  insert into public.shop_blog_settings (shop_id, last_choice) values (v_post.shop_id, p_fb_choice)
  on conflict (shop_id) do update set last_choice = excluded.last_choice, updated_at = now();
  return jsonb_build_object('publish_at', v_at, 'scheduled', v_at > now(),
                            'facebook_now', p_fb_choice = 'web_fb' and v_at <= now());
end;
$$;
revoke execute on function public.owner_blog_publish(uuid, timestamptz, text) from public, anon;
grant execute on function public.owner_blog_publish(uuid, timestamptz, text) to authenticated;

/** A scheduled post's "Web + Facebook" / "Len web", changeable until its time. */
create or replace function public.owner_blog_set_choice(p_post_id uuid, p_fb_choice text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
begin
  if p_fb_choice is null or p_fb_choice not in ('web', 'web_fb') then
    raise exception 'choice' using errcode = '22023';
  end if;
  if v_post.status <> 'published' or v_post.publish_at <= now() or v_post.fb_status in ('posting', 'posted') then
    raise exception 'published' using errcode = '55000';
  end if;
  if p_fb_choice = 'web_fb' and not exists (
    select 1 from public.facebook_connections c where c.shop_id = v_post.shop_id and c.status = 'ok') then
    raise exception 'no_facebook' using errcode = '55000';
  end if;
  update public.blog_posts
  set fb_choice = p_fb_choice, fb_status = case when p_fb_choice = 'web_fb' then 'waiting' else null end, fb_error = null
  where id = v_post.id;
end;
$$;
revoke execute on function public.owner_blog_set_choice(uuid, text) from public, anon;
grant execute on function public.owner_blog_set_choice(uuid, text) to authenticated;

/**
 * "Skryť" / "Zobraziť" (and "Zverejniť" of an imported post waiting for approval). Hiding a scheduled post also
 * cancels its Facebook copy; showing a post again never sends it to Facebook.
 */
create or replace function public.owner_blog_set_hidden(p_post_id uuid, p_hidden boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts := public.blog_member_post(p_post_id);
begin
  if v_post.status = 'draft' then
    raise exception 'draft' using errcode = '55000';
  end if;
  if coalesce(p_hidden, true) then
    update public.blog_posts
    set status = 'hidden', fb_status = case when fb_status = 'waiting' then null else fb_status end
    where id = v_post.id;
  else
    update public.blog_posts
    set status = 'published', publish_at = coalesce(publish_at, now()),
        fb_status = case when fb_status = 'waiting' and publish_at <= now() then null else fb_status end
    where id = v_post.id;
  end if;
end;
$$;
revoke execute on function public.owner_blog_set_hidden(uuid, boolean) from public, anon;
grant execute on function public.owner_blog_set_hidden(uuid, boolean) to authenticated;

/** "Publikovať importované príspevky automaticky" (true, default) or "Schvaľovať pred zverejnením" (false). */
create or replace function public.owner_blog_settings(p_shop_id uuid, p_auto_publish boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  insert into public.shop_blog_settings (shop_id, auto_publish) values (p_shop_id, coalesce(p_auto_publish, true))
  on conflict (shop_id) do update set auto_publish = excluded.auto_publish, updated_at = now();
end;
$$;
revoke execute on function public.owner_blog_settings(uuid, boolean) from public, anon;
grant execute on function public.owner_blog_settings(uuid, boolean) to authenticated;

/** The photos' order (ids in the new order; others keep theirs after them). */
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
  update public.blog_photos f
  set position = x.n - 1
  from unnest(p_ids) with ordinality as x(id, n)
  where f.id = x.id and f.post_id = v_post.id and x.n <= 100;
end;
$$;
revoke execute on function public.owner_blog_photo_order(uuid, uuid[]) from public, anon;
grant execute on function public.owner_blog_photo_order(uuid, uuid[]) to authenticated;

/** The admin's "Limity blogu": visible posts per plan (null = unlimited). */
create or replace function public.admin_save_blog_limits(p_plan text, p_max_posts integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_plan not in ('free', 'pro') or (p_max_posts is not null and p_max_posts not between 0 and 10000) then
    raise exception 'limits' using errcode = '22023';
  end if;
  update public.blog_limits set max_posts = p_max_posts, updated_at = now() where plan = p_plan;
end;
$$;
revoke execute on function public.admin_save_blog_limits(text, integer) from public, anon;
grant execute on function public.admin_save_blog_limits(text, integer) to authenticated;

-- ------------------------------------------------------------------ photos (service role: the shop-blog function)

/**
 * A new photo of a post: the owner's upload (status uploading: the files follow) or an import (pending: the
 * function converts it). A Cacaduu post has at most 10 photos (error photo_limit).
 */
create or replace function public.blog_photo_add(
  p_post_id uuid, p_status text, p_kind text default 'photo', p_fb_media_id text default null,
  p_source_url text default null, p_link_url text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts;
  v_count integer;
  v_id uuid;
begin
  select * into v_post from public.blog_posts where id = p_post_id for update;
  if v_post.id is null then
    raise exception 'post' using errcode = '22023';
  end if;
  select count(*) into v_count from public.blog_photos where post_id = p_post_id;
  if (v_post.source = 'cacaduu' and v_count >= 10) or v_count >= 100 then
    raise exception 'photo_limit' using errcode = '55000';
  end if;
  insert into public.blog_photos (post_id, shop_id, position, kind, status, fb_media_id, source_url, link_url, next_try_at)
  values (p_post_id, v_post.shop_id, v_count, coalesce(p_kind, 'photo'), p_status, p_fb_media_id, p_source_url,
          p_link_url, case when p_status = 'pending' then now() end)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.blog_photo_add(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.blog_photo_add(uuid, text, text, text, text, text) to service_role;

/** One stored size of a photo; ready once the large one is there (and the small one, or the picture is small). */
create or replace function public.blog_photo_stored(p_photo_id uuid, p_size integer, p_path text, p_ext text,
                                                    p_width integer, p_height integer, p_last boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.blog_photos
  set path_large = case when p_size = 1600 then p_path else path_large end,
      width = case when p_size = 1600 then p_width else width end,
      height = case when p_size = 1600 then p_height else height end,
      path_small = case when p_size = 800 then p_path else path_small end,
      small_width = case when p_size = 800 then p_width else small_width end,
      small_height = case when p_size = 800 then p_height else small_height end,
      ext = p_ext, last_error = null
  where id = p_photo_id;
  update public.blog_photos
  set status = 'ready', source_url = null, next_try_at = null
  where id = p_photo_id and path_large is not null and (path_small is not null or coalesce(p_last, false));
end;
$$;
revoke execute on function public.blog_photo_stored(uuid, integer, text, text, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.blog_photo_stored(uuid, integer, text, text, integer, integer, boolean) to service_role;

/** A conversion that failed: tried again (5 minutes, doubling) up to 6 times, then failed. */
create or replace function public.blog_photo_failed(p_photo_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.blog_photos
  set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 300),
      status = case when attempts + 1 >= 6 then 'failed' else 'pending' end,
      next_try_at = case when attempts + 1 >= 6 then null else now() + make_interval(mins => 5 * (2 ^ attempts)::integer) end
  where id = p_photo_id and status = 'pending'
$$;
revoke execute on function public.blog_photo_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.blog_photo_failed(uuid, text) to service_role;

/** Imported photos to convert now (oldest first); each is taken for 10 minutes. */
create or replace function public.blog_photos_due(p_limit integer default 5)
returns table (id uuid, post_id uuid, shop_id uuid, fb_media_id text, source_url text, kind text,
               path_large text, path_small text)
language sql
volatile
security definer
set search_path = ''
as $$
  with due as (
    select f.id from public.blog_photos f
    where f.status = 'pending' and f.next_try_at <= now()
    order by f.next_try_at, f.id
    limit least(greatest(coalesce(p_limit, 5), 1), 50)
    for update of f skip locked
  )
  update public.blog_photos f set next_try_at = now() + interval '10 minutes'
  from due where f.id = due.id
  returning f.id, f.post_id, f.shop_id, f.fb_media_id, f.source_url, f.kind, f.path_large, f.path_small
$$;
revoke execute on function public.blog_photos_due(integer) from public, anon, authenticated;
grant execute on function public.blog_photos_due(integer) to service_role;

/** A photo's files (to remove them first) and the photo's row, for the owner's "Odstrániť". */
create or replace function public.blog_photo_delete(p_photo_id uuid)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_paths text[];
begin
  delete from public.blog_photos where id = p_photo_id
  returning array_remove(array[path_large, path_small], null) into v_paths;
  return coalesce(v_paths, '{}');
end;
$$;
revoke execute on function public.blog_photo_delete(uuid) from public, anon, authenticated;
grant execute on function public.blog_photo_delete(uuid) to service_role;

/** Every file of a post (the function removes them, then the post goes). */
create or replace function public.blog_post_files(p_post_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct x.path), '{}')
  from public.blog_photos f, unnest(array[f.path_large, f.path_small]) as x(path)
  where f.post_id = p_post_id and x.path is not null
$$;
revoke execute on function public.blog_post_files(uuid) from public, anon, authenticated;
grant execute on function public.blog_post_files(uuid) to service_role;

/** Uploads the owner's browser began and never finished (an hour old): their rows go, their files with the next sweep. */
create or replace function public.blog_stale_uploads()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.blog_photos where status = 'uploading' and created_at < now() - interval '1 hour' returning 1
  )
  select count(*)::integer from gone
$$;
revoke execute on function public.blog_stale_uploads() from public, anon, authenticated;
grant execute on function public.blog_stale_uploads() to service_role;

/** Files in "blog-photos" that no photo uses any more (a deleted shop or post, a broken upload): an hour old. */
create or replace function public.blog_orphan_files(p_limit integer default 100)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'objects') then
    return;
  end if;
  return query execute
    'select o.name from storage.objects o
     where o.bucket_id = ''blog-photos'' and o.created_at < now() - interval ''1 hour''
       and not exists (select 1 from public.blog_photos f where f.path_large = o.name or f.path_small = o.name)
     order by o.created_at limit $1'
    using least(greatest(coalesce(p_limit, 100), 1), 1000);
end;
$$;
revoke execute on function public.blog_orphan_files(integer) from public, anon, authenticated;
grant execute on function public.blog_orphan_files(integer) to service_role;

/** Deletes a post (after its files). */
create or replace function public.blog_post_remove(p_post_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (delete from public.blog_posts where id = p_post_id returning 1) select exists (select 1 from gone)
$$;
revoke execute on function public.blog_post_remove(uuid) from public, anon, authenticated;
grant execute on function public.blog_post_remove(uuid) to service_role;

-- ------------------------------------------------------------------ Facebook: connecting (service role)

create or replace function public.facebook_state_save(p_state_hash text, p_shop_id uuid, p_user_id uuid, p_return_url text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.facebook_oauth_states where expires_at < now();
  delete from public.facebook_pending_pages where expires_at < now();
  insert into public.facebook_oauth_states (state_hash, shop_id, user_id, return_url, expires_at)
  values (p_state_hash, p_shop_id, p_user_id, p_return_url, now() + interval '10 minutes');
end;
$$;
revoke execute on function public.facebook_state_save(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.facebook_state_save(text, uuid, uuid, text) to service_role;

/** Takes a state once: the row when it exists and has not expired, else null. */
create or replace function public.facebook_state_take(p_state_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.facebook_oauth_states%rowtype;
begin
  delete from public.facebook_oauth_states where state_hash = p_state_hash returning * into v_row;
  if not found or v_row.expires_at < now() then
    return null;
  end if;
  return jsonb_build_object('shop_id', v_row.shop_id, 'user_id', v_row.user_id, 'return_url', v_row.return_url);
end;
$$;
revoke execute on function public.facebook_state_take(text) from public, anon, authenticated;
grant execute on function public.facebook_state_take(text) to service_role;

create or replace function public.facebook_pending_save(p_id uuid, p_shop_id uuid, p_user_id uuid, p_pages_enc text,
                                                        p_return_url text, p_scopes text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.facebook_pending_pages where expires_at < now() or (shop_id = p_shop_id and user_id = p_user_id);
  insert into public.facebook_pending_pages (id, shop_id, user_id, pages_enc, return_url, scopes, expires_at)
  values (p_id, p_shop_id, p_user_id, p_pages_enc, p_return_url, left(p_scopes, 500), now() + interval '10 minutes');
end;
$$;
revoke execute on function public.facebook_pending_save(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.facebook_pending_save(uuid, uuid, uuid, text, text, text) to service_role;

/** The Pages to choose from: only for the owner who logged in, within 10 minutes; p_take removes them. */
create or replace function public.facebook_pending_get(p_id uuid, p_user_id uuid, p_take boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.facebook_pending_pages%rowtype;
begin
  select * into v_row from public.facebook_pending_pages where id = p_id and user_id = p_user_id and expires_at > now();
  if v_row.id is null then
    return null;
  end if;
  if coalesce(p_take, false) then
    delete from public.facebook_pending_pages where id = p_id;
  end if;
  return jsonb_build_object('shop_id', v_row.shop_id, 'pages_enc', v_row.pages_enc, 'return_url', v_row.return_url,
                            'scopes', v_row.scopes);
end;
$$;
revoke execute on function public.facebook_pending_get(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.facebook_pending_get(uuid, uuid, boolean) to service_role;

/** The chosen Page (one per shop; another Page replaces it). The first sync runs within minutes. */
create or replace function public.facebook_connection_save(p_shop_id uuid, p_page_id text, p_page_name text,
                                                           p_page_picture text, p_token_enc text, p_scopes text,
                                                           p_user_id uuid, p_site_url text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.facebook_connections (shop_id, page_id, page_name, page_picture, page_token_enc, scopes, site_url,
                                           connected_by, next_sync_at)
  values (p_shop_id, p_page_id, left(p_page_name, 200), left(p_page_picture, 2000), p_token_enc, left(p_scopes, 500),
          p_site_url, p_user_id, now() + interval '1 day')
  on conflict (shop_id) do update
    set page_id = excluded.page_id, page_name = excluded.page_name, page_picture = excluded.page_picture,
        page_token_enc = excluded.page_token_enc, scopes = excluded.scopes,
        site_url = coalesce(excluded.site_url, public.facebook_connections.site_url),
        connected_by = excluded.connected_by, connected_at = now(), status = 'ok', last_error = null,
        failing_since = null, alert_sent_at = null,
        import_state = case when public.facebook_connections.page_id = excluded.page_id
                            then public.facebook_connections.import_state else 'idle' end,
        import_cursor = null, updated_at = now();
end;
$$;
revoke execute on function public.facebook_connection_save(uuid, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.facebook_connection_save(uuid, text, text, text, text, text, uuid, text) to service_role;

/**
 * "Odpojiť": the token is deleted; imported posts stay. Posts still waiting for Facebook fail with a reason
 * (the owner connects again and uses "Skúsiť znova na Facebook").
 */
create or replace function public.facebook_disconnect(p_shop_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  delete from public.facebook_connections where shop_id = p_shop_id;
  v_found := found;
  update public.blog_posts set fb_status = 'failed', fb_error = 'Facebook bol odpojený.'
  where shop_id = p_shop_id and fb_status = 'waiting';
  delete from public.facebook_pending_pages where shop_id = p_shop_id;
  return v_found;
end;
$$;
revoke execute on function public.facebook_disconnect(uuid) from public, anon, authenticated;
grant execute on function public.facebook_disconnect(uuid) to service_role;

/** The connection after a call: ok (clears the error) or expired (Facebook refused the token; e-mail once). */
create or replace function public.facebook_connection_result(p_shop_id uuid, p_error text, p_expired boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce(p_expired, false) then
    update public.facebook_connections
    set status = 'expired', last_error = left(p_error, 300), failing_since = coalesce(failing_since, now()),
        sync_running_at = null, updated_at = now()
    where shop_id = p_shop_id;
  elsif p_error is null then
    update public.facebook_connections
    set status = 'ok', last_error = null, failing_since = null, updated_at = now()
    where shop_id = p_shop_id and (status <> 'ok' or last_error is not null);
  else
    update public.facebook_connections set last_error = left(p_error, 300), updated_at = now() where shop_id = p_shop_id;
  end if;
end;
$$;
revoke execute on function public.facebook_connection_result(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.facebook_connection_result(uuid, text, boolean) to service_role;

/** A connection with its token for the function's work. */
create or replace function public.facebook_connection_of(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('shop_id', c.shop_id, 'page_id', c.page_id, 'page_name', c.page_name,
                            'page_token_enc', c.page_token_enc, 'status', c.status, 'connected_at', c.connected_at,
                            'import_state', c.import_state,
                            'import_cursor', c.import_cursor, 'shop_slug', s.slug, 'shop_country', s.country)
  from public.facebook_connections c join public.shops s on s.id = c.shop_id
  where c.shop_id = p_shop_id
$$;
revoke execute on function public.facebook_connection_of(uuid) from public, anon, authenticated;
grant execute on function public.facebook_connection_of(uuid) to service_role;

-- ------------------------------------------------------------------ Facebook: import and sync (service role)

/** "Stiahnuť všetky príspevky": starts (again) from the newest post. False while one is running. */
create or replace function public.facebook_import_start(p_shop_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with started as (
    update public.facebook_connections
    set import_state = 'running', import_cursor = null, import_count = 0, import_started_at = now(),
        import_finished_at = null, import_error = null, updated_at = now()
    where shop_id = p_shop_id and status = 'ok'
      and (import_state <> 'running' or import_started_at < now() - interval '30 minutes')
    returning 1
  )
  select exists (select 1 from started)
$$;
revoke execute on function public.facebook_import_start(uuid) from public, anon, authenticated;
grant execute on function public.facebook_import_start(uuid) to service_role;

/**
 * Takes the next page of a running import for one call (2 minutes): {cursor} ("" = the first page), or null when
 * no import runs or another call has it.
 */
create or replace function public.facebook_import_take(p_shop_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update public.facebook_connections
  set import_lease_at = now(), updated_at = now()
  where shop_id = p_shop_id and status = 'ok' and import_state = 'running'
    and (import_lease_at is null or import_lease_at < now() - interval '2 minutes')
  returning jsonb_build_object('cursor', coalesce(import_cursor, ''))
$$;
revoke execute on function public.facebook_import_take(uuid) from public, anon, authenticated;
grant execute on function public.facebook_import_take(uuid) to service_role;

/** One page of the import done: the next cursor (null = finished) and how many posts it brought. */
create or replace function public.facebook_import_step(p_shop_id uuid, p_cursor text, p_count integer, p_error text default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.facebook_connections
  set import_cursor = case when p_error is null then p_cursor else import_cursor end,
      import_count = import_count + greatest(coalesce(p_count, 0), 0),
      import_state = case when p_error is not null then 'failed' when p_cursor is null then 'done' else 'running' end,
      import_finished_at = case when p_error is not null or p_cursor is null then now() else import_finished_at end,
      import_error = left(p_error, 300),
      import_started_at = case when p_error is null and p_cursor is not null then now() else import_started_at end,
      import_lease_at = null,
      last_sync_at = case when p_error is null and p_cursor is null then now() else last_sync_at end,
      updated_at = now()
  where shop_id = p_shop_id
$$;
revoke execute on function public.facebook_import_step(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.facebook_import_step(uuid, text, integer, text) to service_role;

/** Imports whose chain of calls broke off (no call for 2 minutes): the job goes on with them. */
create or replace function public.facebook_imports_stalled(p_limit integer default 3)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.shop_id from public.facebook_connections c
  where c.status = 'ok' and c.import_state = 'running'
    and (c.import_lease_at is null or c.import_lease_at < now() - interval '2 minutes')
    and c.updated_at < now() - interval '2 minutes'
  order by c.updated_at
  limit least(greatest(coalesce(p_limit, 3), 1), 20)
$$;
revoke execute on function public.facebook_imports_stalled(integer) from public, anon, authenticated;
grant execute on function public.facebook_imports_stalled(integer) to service_role;

/** Connections whose daily sync is due (or a Page webhook asked for one): each taken for 15 minutes. */
create or replace function public.facebook_sync_due(p_limit integer default 3)
returns setof uuid
language sql
volatile
security definer
set search_path = ''
as $$
  with due as (
    select c.shop_id from public.facebook_connections c
    where c.status = 'ok' and c.import_state <> 'running' and coalesce(c.next_sync_at, now()) <= now()
      and (c.sync_running_at is null or c.sync_running_at < now() - interval '15 minutes')
    order by c.next_sync_at nulls first
    limit least(greatest(coalesce(p_limit, 3), 1), 20)
    for update skip locked
  )
  update public.facebook_connections c set sync_running_at = now()
  from due where c.shop_id = due.shop_id
  returning c.shop_id
$$;
revoke execute on function public.facebook_sync_due(integer) from public, anon, authenticated;
grant execute on function public.facebook_sync_due(integer) to service_role;

/**
 * A sync done: the next one in about a day; the Page's name and picture as Facebook says now. With p_error (Facebook
 * did not answer, not an expired token): tried again in an hour.
 */
create or replace function public.facebook_sync_done(p_shop_id uuid, p_page_name text, p_page_picture text,
                                                     p_error text default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.facebook_connections
  set last_sync_at = case when p_error is null then now() else last_sync_at end, sync_running_at = null,
      next_sync_at = case when p_error is null then now() + interval '1 day' + make_interval(mins => (random() * 30)::integer)
                          else now() + interval '1 hour' end,
      last_error = case when p_error is null then null else left(p_error, 300) end,
      page_name = coalesce(nullif(left(p_page_name, 200), ''), page_name),
      page_picture = coalesce(left(p_page_picture, 2000), page_picture), updated_at = now()
  where shop_id = p_shop_id
$$;
revoke execute on function public.facebook_sync_done(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.facebook_sync_done(uuid, text, text, text) to service_role;

/** A Page webhook (feed changed): that Page's shops sync with the next job (within 5 minutes). */
create or replace function public.facebook_sync_page_soon(p_page_id text)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with soon as (
    update public.facebook_connections set next_sync_at = least(coalesce(next_sync_at, now()), now())
    where page_id = p_page_id and status = 'ok'
    returning 1
  )
  select count(*)::integer from soon
$$;
revoke execute on function public.facebook_sync_page_soon(text) from public, anon, authenticated;
grant execute on function public.facebook_sync_page_soon(text) to service_role;

/** The newest imported post's time (the daily sync reads Facebook back to it). */
create or replace function public.facebook_newest_import(p_shop_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(publish_at) from public.blog_posts where shop_id = p_shop_id and fb_post_id is not null
$$;
revoke execute on function public.facebook_newest_import(uuid) from public, anon, authenticated;
grant execute on function public.facebook_newest_import(uuid) to service_role;

/**
 * One post read from the Page (import or sync), as Facebook says (text as written; never comments, reactions or other
 * people's names: the function never asks for them). Answers {result, post_id, removed}:
 *   own     — a post Cacaduu published there (its id is known): nothing imported;
 *   linked  — Cacaduu's post whose "Čítať na webe" link it carries (p_own_slug), now linked to it;
 *   same    — already imported and unchanged;
 *   updated — imported, and changed on Facebook since (text, links, photos; the owner's title stays);
 *   new     — a new post: live at once, or waiting for the owner (Schvaľovať pred zverejnením).
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
    -- Facebook's updated_time also moves when people comment: only a different text, title, link or photo is an edit.
    if v_post.body = coalesce(p_message, '') and v_post.links = v_links and v_old_media is not distinct from v_new_media
       and (v_post.title_by_owner or v_post.title = v_title) then
      update public.blog_posts
      set fb_checked_at = now(), fb_updated_at = coalesce(p_updated, fb_updated_at),
          fb_permalink = coalesce(p_permalink, fb_permalink)
      where id = v_post.id;
      return jsonb_build_object('result', 'same', 'post_id', v_post.id, 'removed', '[]'::jsonb);
    end if;
    update public.blog_posts
    set body = coalesce(p_message, ''), links = v_links, fb_updated_at = p_updated, fb_checked_at = now(),
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

/** Imported posts to look at again on Facebook (edited or deleted?), least recently checked first. */
create or replace function public.blog_posts_to_check(p_shop_id uuid, p_limit integer default 200)
returns table (post_id uuid, fb_post_id text, fb_updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.fb_post_id, p.fb_updated_at
  from public.blog_posts p
  where p.shop_id = p_shop_id and p.source = 'facebook' and p.fb_post_id is not null and p.fb_deleted_at is null
  order by p.fb_checked_at nulls first, p.publish_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;
revoke execute on function public.blog_posts_to_check(uuid, integer) from public, anon, authenticated;
grant execute on function public.blog_posts_to_check(uuid, integer) to service_role;

/** Checked and still there, unchanged. */
create or replace function public.blog_posts_checked(p_shop_id uuid, p_fb_post_ids text[])
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.blog_posts set fb_checked_at = now() where shop_id = p_shop_id and fb_post_id = any(p_fb_post_ids)
$$;
revoke execute on function public.blog_posts_checked(uuid, text[]) from public, anon, authenticated;
grant execute on function public.blog_posts_checked(uuid, text[]) to service_role;

/** Deleted on Facebook → hidden here (the owner may show it again). Imported posts only. */
create or replace function public.blog_posts_deleted_on_facebook(p_shop_id uuid, p_fb_post_ids text[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    update public.blog_posts
    set fb_deleted_at = now(), fb_checked_at = now(), status = case when status = 'draft' then status else 'hidden' end
    where shop_id = p_shop_id and source = 'facebook' and fb_post_id = any(p_fb_post_ids) and fb_deleted_at is null
    returning 1
  )
  select count(*)::integer from gone
$$;
revoke execute on function public.blog_posts_deleted_on_facebook(uuid, text[]) from public, anon, authenticated;
grant execute on function public.blog_posts_deleted_on_facebook(uuid, text[]) to service_role;

-- ------------------------------------------------------------------ Facebook: publishing (service role)

/** Cacaduu posts whose Facebook copy is due now ("Web + Facebook", live, Page connected). */
create or replace function public.blog_fb_due(p_limit integer default 5)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.blog_posts p
  join public.facebook_connections c on c.shop_id = p.shop_id and c.status = 'ok'
  where p.fb_status = 'waiting' and p.fb_choice = 'web_fb' and p.status = 'published' and p.publish_at <= now()
  order by p.publish_at, p.id
  limit least(greatest(coalesce(p_limit, 5), 1), 20)
$$;
revoke execute on function public.blog_fb_due(integer) from public, anon, authenticated;
grant execute on function public.blog_fb_due(integer) to service_role;

/**
 * Takes a post for posting to Facebook (waiting, or failed for "Skúsiť znova na Facebook"): its text, photos and
 * Page. Null when it is not live, is being posted (a stuck attempt counts as failed after 10 minutes: Facebook may
 * have it, so it is never sent twice by itself) or is already on Facebook.
 */
create or replace function public.blog_fb_claim(p_post_id uuid, p_retry boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_post public.blog_posts;
  v_shop public.shops;
begin
  update public.blog_posts
  set fb_status = 'failed', fb_error = 'Facebook neodpovedal. Skontrolujte stránku, či tam príspevok nie je, a skúste znova.'
  where id = p_post_id and fb_status = 'posting' and fb_posting_at < now() - interval '10 minutes';
  update public.blog_posts
  set fb_status = 'posting', fb_posting_at = now(), fb_tries = fb_tries + 1, fb_choice = 'web_fb'
  where id = p_post_id and source = 'cacaduu' and fb_post_id is null and status = 'published' and publish_at <= now()
    and (fb_status = 'waiting' or (coalesce(p_retry, false) and fb_status = 'failed'))
  returning * into v_post;
  if v_post.id is null then
    return null;
  end if;
  select * into v_shop from public.shops where id = v_post.shop_id;
  return jsonb_build_object(
    'post_id', v_post.id, 'shop_id', v_post.shop_id, 'shop_slug', v_shop.slug, 'shop_country', v_shop.country,
    'slug', v_post.slug, 'title', v_post.title, 'body', v_post.body,
    'photos', coalesce((select jsonb_agg(f.path_large order by f.position, f.created_at) from public.blog_photos f
                        where f.post_id = v_post.id and f.status = 'ready' and f.kind = 'photo' and f.path_large is not null), '[]'::jsonb));
end;
$$;
revoke execute on function public.blog_fb_claim(uuid, boolean) from public, anon, authenticated;
grant execute on function public.blog_fb_claim(uuid, boolean) to service_role;

/** Facebook's answer: the post's id and address, or why it failed (the web post stays either way). */
create or replace function public.blog_fb_result(p_post_id uuid, p_fb_post_id text, p_permalink text, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.blog_posts
  set fb_status = case when p_fb_post_id is not null then 'posted' else 'failed' end,
      fb_post_id = coalesce(p_fb_post_id, fb_post_id), fb_permalink = coalesce(p_permalink, fb_permalink),
      fb_error = case when p_fb_post_id is not null then null else left(coalesce(p_error, 'Facebook'), 300) end
  where id = p_post_id and fb_status = 'posting'
$$;
revoke execute on function public.blog_fb_result(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.blog_fb_result(uuid, text, text, text) to service_role;

-- ------------------------------------------------------------------ the e-mail when the connection expires

drop function if exists public.facebook_alerts_due();
create function public.facebook_alerts_due()
returns table (shop_id uuid, shop_name text, shop_slug text, page_name text, site_url text, emails text[])
language sql
stable
security definer
set search_path = ''
as $$
  select c.shop_id, s.name, s.slug, c.page_name, c.site_url,
         coalesce((select array_agg(u.email::text order by u.email) from public.shop_members m
                   join auth.users u on u.id = m.user_id
                   where m.shop_id = c.shop_id and u.email is not null), '{}')
  from public.facebook_connections c
  join public.shops s on s.id = c.shop_id
  where c.status = 'expired' and (c.alert_sent_at is null or c.alert_sent_at < c.failing_since)
$$;
revoke execute on function public.facebook_alerts_due() from public, anon, authenticated;
grant execute on function public.facebook_alerts_due() to service_role;

create or replace function public.facebook_alert_sent(p_shop_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.facebook_connections set alert_sent_at = now() where shop_id = p_shop_id
$$;
revoke execute on function public.facebook_alert_sent(uuid) from public, anon, authenticated;
grant execute on function public.facebook_alert_sent(uuid) to service_role;

-- ------------------------------------------------------------------ IndexNow for posts (service role)

/**
 * A host whose post addresses changed and were not sent yet (new, edited, shown, hidden; a scheduled post once its
 * time has come): the shop's live own domain, else the main Cacaduu host (p_main_host; active shops without a live
 * own domain). At most once an hour per host, shared with the stock's pings (update 36). Answers null (nothing to do)
 * or {host, kind, at, posts: [{id, shop_slug, slug, country}]} (≤ p_max posts; the claim counts as the hour's ping).
 */
create or replace function public.blog_indexnow_claim(p_main_host text, p_max integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_main text := lower(btrim(coalesce(p_main_host, '')));
  v_limit integer := least(greatest(coalesce(p_max, 500), 1), 2000);
  v_host text;
  v_kind text;
  v_posts jsonb;
begin
  if v_main !~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' or v_main !~ '\.' then
    v_main := null;
  end if;
  if to_regclass('pg_temp.blog_indexnow_pending') is null then
    create temporary table blog_indexnow_pending (
      id uuid, slug text, shop_slug text, country text, at timestamptz, host text, kind text
    ) on commit drop;
  end if;
  truncate blog_indexnow_pending;
  -- changed and not sent: the visible posts, and the hidden ones (their address now answers 404)
  insert into blog_indexnow_pending
  select p.id, p.slug, s.slug, s.country, greatest(p.indexnow_at, p.publish_at),
         coalesce(site.host, v_main), case when site.host is null then 'main' else 'site' end
  from public.blog_posts p
  join public.shops s on s.id = p.shop_id
  left join lateral (
    select o.site_host as host from public.domain_orders o
    where o.shop_id = s.id and o.status = 'live' and o.site_host is not null and public.shop_has_plan(s.id)
    limit 1
  ) site on true
  where p.indexnow_at is not null and s.is_active
    and greatest(p.indexnow_at, p.publish_at) <= now()
    and greatest(p.indexnow_at, p.publish_at) > coalesce(p.indexnow_sent_at, '-infinity'::timestamptz)
    and (p.status = 'hidden' or p.id in (select v.id from public.blog_visible_posts(null) v));
  for v_host, v_kind in
    select x.host, x.kind from blog_indexnow_pending x where x.host is not null group by 1, 2 order by min(x.at)
  loop
    insert into public.indexnow_hosts (host, sent_upto) values (v_host, now() - interval '1 hour') on conflict (host) do nothing;
    if exists (select 1 from public.indexnow_hosts h where h.host = v_host and h.last_ping_at > now() - interval '1 hour') then
      continue;
    end if;
    select jsonb_agg(jsonb_build_object('id', y.id, 'shop_slug', y.shop_slug, 'slug', y.slug, 'country', y.country)
                     order by y.at, y.id)
    into v_posts
    from (select * from blog_indexnow_pending x where x.host = v_host order by x.at, x.id limit v_limit) y;
    update public.indexnow_hosts set last_ping_at = now(), updated_at = now() where host = v_host;
    return jsonb_build_object('host', v_host, 'kind', v_kind, 'at', now(), 'posts', v_posts);
  end loop;
  return null;
end;
$$;
revoke execute on function public.blog_indexnow_claim(text, integer) from public, anon, authenticated;
grant execute on function public.blog_indexnow_claim(text, integer) to service_role;

/** The ping's answer: logged with the stock's pings; answered (2xx) → those posts are sent. */
create or replace function public.blog_indexnow_done(p_host text, p_kind text, p_at timestamptz, p_ids uuid[],
                                                     p_urls integer, p_status integer, p_result text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result text := left(regexp_replace(coalesce(p_result, ''), '[\x01-\x1f]', ' ', 'g'), 200);
begin
  insert into public.indexnow_pings (host, kind, urls, status, result, upto)
  values (lower(p_host), case when p_kind = 'site' then 'site' else 'main' end, greatest(coalesce(p_urls, 0), 0), p_status,
          'blog: ' || left(v_result, 190), p_at);
  update public.indexnow_hosts
  set last_status = p_status, last_result = left('blog: ' || v_result, 200), last_urls = greatest(coalesce(p_urls, 0), 0),
      updated_at = now()
  where host = lower(p_host);
  if coalesce(p_status between 200 and 299, false) then
    update public.blog_posts set indexnow_sent_at = p_at where id = any(p_ids) and indexnow_at <= p_at;
  end if;
end;
$$;
revoke execute on function public.blog_indexnow_done(text, text, timestamptz, uuid[], integer, integer, text) from public, anon, authenticated;
grant execute on function public.blog_indexnow_done(text, text, timestamptz, uuid[], integer, integer, text) to service_role;

-- ------------------------------------------------------------------ storage

-- Public: the photos of posts (random names, never listed). No policies: only the service role (the shop-blog
-- function) writes; the owner's browser sends its photos through the function, which checks every file.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('blog-photos', 'blog-photos', true, 5242880, array['image/webp', 'image/jpeg'])
    on conflict (id) do update
      set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ------------------------------------------------------------------ the job (pg_cron + pg_net)

-- Every 5 minutes: scheduled Facebook copies, the import page by page, the daily sync, imported photos, IndexNow
-- for posts, the expiry e-mail, unused files. Uses the Vault secrets ppi_project_url and ppi_assistant_cron (update 22).
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/shop-blog',
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
  perform cron.schedule('ppi-blog-tick', '3-59/5 * * * *', v_call);
end;
$$;

notify pgrst, 'reload schema';
