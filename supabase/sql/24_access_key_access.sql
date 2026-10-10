-- PPI · 24 · Access keys: shoppers view or download a private folder's files (paid plan). Paste the whole file into the Supabase SQL Editor and Run.
--  Needs updates 20, 22 and 23. A shopper who types a valid access key in the shop's assistant
--  opens that private folder for 24 hours (or until the chat closes): the assistant may use
--  its documents, and the shopper sees its files with "Otvoriť" — PDFs as page pictures with
--  a watermark, never the original file. Each private folder has a "Režim prístupu":
--  "Len zobraziť" (default) or "Zobraziť a stiahnuť"; every file can override it. Downloads
--  (one file or the folder as a ZIP of the downloadable files) are counted: at most 20 per
--  unlocked session. Each folder can have its own key ("Kľúč priečinka", shown once) and
--  shows how often it was unlocked, viewed and downloaded (no shopper data). Shoppers may
--  download the PDF of their own conversation unless the owner turns it off.
--  Keys and session tokens stay stored only as SHA-256; nothing here is ever public.
-- Safe to run again.

-- ------------------------------------------------------------------ tables and columns

do $$
begin
  -- the first run only: private-folder documents the owner allowed to download keep that
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'shop_documents' and column_name = 'access') then
    alter table public.shop_documents add column access text;
    update public.shop_documents d set access = 'download'
    where d.downloadable and exists (select 1 from public.shop_folders f where f.id = d.folder_id and not f.is_public);
  end if;
end;
$$;

alter table public.shop_folders
  add column if not exists access_mode text not null default 'view',
  add column if not exists unlocks integer not null default 0,
  add column if not exists views integer not null default 0,
  add column if not exists downloads integer not null default 0;
alter table public.shop_pictures add column if not exists access text;
-- the key set in a folder's own settings ("Kľúč priečinka"): one per folder, replaced on change
alter table public.folder_keys add column if not exists folder_key boolean not null default false;
alter table public.folder_sessions add column if not exists downloads integer not null default 0;
alter table public.shop_assistant_settings add column if not exists shopper_pdf boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_folders_access_mode_check') then
    alter table public.shop_folders add constraint shop_folders_access_mode_check check (access_mode in ('view', 'download'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_documents_access_check') then
    alter table public.shop_documents add constraint shop_documents_access_check check (access is null or access in ('view', 'download'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_pictures_access_check') then
    alter table public.shop_pictures add constraint shop_pictures_access_check check (access is null or access in ('view', 'download'));
  end if;
end;
$$;

-- Each PDF page as a picture (made in the owner's browser at upload), for the viewer: shoppers
-- never get the PDF itself unless it may be downloaded.
create table if not exists public.shop_document_pages (
  document_id  uuid not null references public.shop_documents (id) on delete cascade,
  page         integer not null check (page between 1 and 5000),
  shop_id      uuid not null references public.shops (id) on delete cascade,
  storage_path text not null unique,
  bytes        integer not null check (bytes between 1 and 5242880),
  width        integer check (width between 1 and 10000),
  height       integer check (height between 1 and 10000),
  uploaded     boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (document_id, page)
);
create index if not exists shop_document_pages_shop_idx on public.shop_document_pages (shop_id);

-- "Stiahnuť celý priečinok (ZIP)": a single-use ticket for 10 minutes (only its hash is kept).
create table if not exists public.folder_zip_tickets (
  ticket_hash  text primary key,
  shop_id      uuid not null references public.shops (id) on delete cascade,
  folder_id    uuid not null references public.shop_folders (id) on delete cascade,
  session_hash text not null,
  expires_at   timestamptz not null,
  used_at      timestamptz
);

alter table public.shop_document_pages enable row level security;
alter table public.folder_zip_tickets enable row level security;
revoke all on public.shop_document_pages, public.folder_zip_tickets from public, anon, authenticated;
grant all on public.shop_document_pages, public.folder_zip_tickets to service_role;
-- Owners see whether a document is ready for the viewer (never more than that).
grant select (document_id, page, shop_id, uploaded) on public.shop_document_pages to authenticated;
drop policy if exists "shop_document_pages: members read" on public.shop_document_pages;
create policy "shop_document_pages: members read" on public.shop_document_pages
  for select to authenticated using (public.is_shop_member(shop_id));
-- The new folder columns are readable like the rest of the folder (members only, RLS of update 20).
grant select (shopper_pdf) on public.shop_assistant_settings to authenticated;
-- Owners see which key is a folder's own key (never a key's hash).
grant select (folder_key) on public.folder_keys to authenticated;

-- ------------------------------------------------------------------ helpers

/** What a shopper with the key may do with a file: its own setting, else its folder's mode. */
create or replace function public.docs_file_access(p_folder_mode text, p_file_access text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_file_access, p_folder_mode, 'view')
$$;
revoke execute on function public.docs_file_access(text, text) from public, anon, authenticated;

/** The shopper's open session in this shop (valid, its key still valid), or nothing. */
create or replace function public.docs_open_session(p_shop_id uuid, p_token text)
returns public.folder_sessions
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from public.folder_sessions s
  join public.folder_keys k on k.id = s.key_id
  where p_token is not null and length(p_token) >= 32
    and s.token_hash = public.docs_hash(p_token) and s.shop_id = p_shop_id and s.expires_at > now()
    and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())
$$;
revoke execute on function public.docs_open_session(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ shoppers: unlocking

/**
 * "Mám prístupový kľúč": as in update 20, but a session lasts 24 hours (the website also
 * locks it when the chat closes) and every opened folder counts one unlock. At most 5
 * wrong keys per caller and shop in 15 minutes; keys are found by their SHA-256 only.
 */
create or replace function public.unlock_shop_folders(p_slug text, p_key text, p_ip_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := public.docs_shop(p_slug);
  v_fails text;
  v_key public.folder_keys;
  v_folders uuid[];
  v_token text;
  v_expires timestamptz := now() + interval '24 hours';
begin
  if p_ip_hash is null or length(p_ip_hash) < 16 or length(p_ip_hash) > 128 then
    raise exception 'Invalid caller hash' using errcode = '22023';
  end if;
  if v_shop is null then
    return jsonb_build_object('status', 'unavailable');
  end if;
  v_fails := 'folder-key-fail:' || v_shop;
  if (select count(*) from public.api_usage
      where ip_hash = p_ip_hash and endpoint = v_fails and created_at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('status', 'too_many');
  end if;

  select * into v_key from public.folder_keys
  where shop_id = v_shop and key_hash = public.docs_hash(p_key)
    and revoked_at is null and (expires_at is null or expires_at > now());
  if found then
    select array_agg(f.id) into v_folders from public.shop_folders f
    where f.id = any (v_key.folder_ids) and f.shop_id = v_shop and not f.is_public;
  end if;
  if v_folders is null then
    insert into public.api_usage (ip_hash, endpoint) values (p_ip_hash, v_fails);
    return jsonb_build_object('status', 'wrong');
  end if;

  if random() < 0.05 then
    delete from public.folder_sessions where expires_at < now();
    delete from public.folder_zip_tickets where expires_at < now() - interval '1 day';
  end if;
  v_token := public.docs_random(40);
  insert into public.folder_sessions (token_hash, shop_id, key_id, folder_ids, expires_at)
  values (public.docs_hash(v_token), v_shop, v_key.id, v_folders, v_expires);
  update public.folder_keys set last_used_at = now(), use_count = use_count + 1 where id = v_key.id;
  update public.shop_folders set unlocks = unlocks + 1 where id = any (v_folders);
  return jsonb_build_object(
    'status', 'ok', 'token', v_token, 'expires_at', v_expires,
    'folders', (select jsonb_agg(f.name order by f.name) from public.shop_folders f where f.id = any (v_folders)));
end;
$$;

/** Which private folders this token opens now (names), until when, and downloads left (of 20). */
create or replace function public.shop_folder_session(p_slug text, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when cardinality(v.folders) = 0 then null else jsonb_build_object(
    'folders', (select jsonb_agg(f.name order by f.name) from public.shop_folders f where f.id = any (v.folders)),
    'expires_at', (select s.expires_at from public.folder_sessions s where s.token_hash = public.docs_hash(p_token)),
    'downloads_left', greatest(0, 20 - coalesce((select s.downloads from public.folder_sessions s
                                                  where s.token_hash = public.docs_hash(p_token)), 0)))
  end
  from (select public.docs_session_folders(public.docs_shop(p_slug), p_token) as folders) v
$$;

/**
 * The files of the private folders this token opens (never another shop's, never a folder
 * the token does not open): documents with their pages for the viewer and the shopper's
 * own pictures, with what the shopper may do (view or also download).
 */
create or replace function public.shop_folder_files(p_slug text, p_token text)
returns table (
  folder_id uuid,
  folder text,
  access_mode text,
  kind text,
  id uuid,
  name text,
  pages integer,
  bytes bigint,
  can_download boolean,
  viewable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with shop as (select public.docs_shop(p_slug) as id),
       opened as (select public.docs_session_folders(shop.id, p_token) as folders from shop)
  select f.id, f.name, f.access_mode, 'document', d.id, d.name, d.pages, d.bytes,
         public.docs_file_access(f.access_mode, d.access) = 'download',
         (select count(*) from public.shop_document_pages pg where pg.document_id = d.id and pg.uploaded) >= d.pages
  from shop, opened, public.shop_documents d
  join public.shop_folders f on f.id = d.folder_id
  where d.shop_id = shop.id and d.folder_id = any (opened.folders) and d.status in ('processing', 'ready')
  union all
  select f.id, f.name, f.access_mode, 'picture', p.id, p.title, 1, p.bytes::bigint,
         public.docs_file_access(f.access_mode, p.access) = 'download', true
  from shop, opened, public.shop_pictures p
  join public.shop_folders f on f.id = p.folder_id
  where p.shop_id = shop.id and p.folder_id = any (opened.folders) and p.kind = 'picture' and p.document_id is null
    and p.status <> 'uploading'
  order by 2, 4, 6
$$;

revoke execute on function public.unlock_shop_folders(text, text, text) from public;
revoke execute on function public.shop_folder_session(text, text) from public;
revoke execute on function public.shop_folder_files(text, text) from public;
grant execute on function public.unlock_shop_folders(text, text, text) to anon, authenticated, service_role;
grant execute on function public.shop_folder_session(text, text) to anon, authenticated, service_role;
grant execute on function public.shop_folder_files(text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ shoppers: viewing and downloading (shop-files)

/**
 * The viewer's pictures of one file in a folder this token opens: a document's page pictures
 * (only when all are uploaded) or the picture itself, with the shop's name and time zone
 * for the watermark. p_count: an "Otvoriť" (counted once per opening). Service role only.
 */
create or replace function public.shop_view_file(p_slug text, p_kind text, p_id uuid, p_token text, p_count boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := public.docs_shop(p_slug);
  v_folders uuid[];
  v_folder uuid;
  v_name text;
  v_pages jsonb;
  v_can boolean;
begin
  if v_shop is null then
    return null;
  end if;
  v_folders := public.docs_session_folders(v_shop, p_token);
  if p_kind = 'document' then
    select d.folder_id, d.name, public.docs_file_access(f.access_mode, d.access) = 'download'
      into v_folder, v_name, v_can
    from public.shop_documents d join public.shop_folders f on f.id = d.folder_id
    where d.id = p_id and d.shop_id = v_shop and d.folder_id = any (v_folders) and d.status in ('processing', 'ready')
      and (select count(*) from public.shop_document_pages pg where pg.document_id = d.id and pg.uploaded) >= d.pages;
    if v_folder is null then
      return null;
    end if;
    select jsonb_agg(jsonb_build_object('page', pg.page, 'path', pg.storage_path, 'width', pg.width, 'height', pg.height)
                     order by pg.page)
      into v_pages
    from public.shop_document_pages pg
    join public.shop_documents d on d.id = pg.document_id
    where pg.document_id = p_id and pg.uploaded and pg.page <= d.pages;
  elsif p_kind = 'picture' then
    -- the folder's own pictures, and pictures of its PDFs the assistant shows in an answer
    select p.folder_id, p.title, public.docs_file_access(f.access_mode, coalesce(p.access, d.access)) = 'download',
           jsonb_build_array(jsonb_build_object('page', 1, 'path', p.storage_path, 'width', null, 'height', null))
      into v_folder, v_name, v_can, v_pages
    from public.shop_pictures p
    join public.shop_folders f on f.id = p.folder_id
    left join public.shop_documents d on d.id = p.document_id
    where p.id = p_id and p.shop_id = v_shop and p.folder_id = any (v_folders) and p.kind = 'picture'
      and p.status <> 'uploading' and (p.document_id is null or (p.show and d.assistant_enabled));
    if v_folder is null then
      return null;
    end if;
  else
    return null;
  end if;
  if coalesce(p_count, false) then
    update public.shop_folders set views = views + 1 where id = v_folder;
  end if;
  return jsonb_build_object(
    'name', v_name, 'can_download', v_can, 'pages', coalesce(v_pages, '[]'::jsonb),
    'shop', (select jsonb_build_object('name', s.name, 'timezone', s.timezone) from public.shops s where s.id = v_shop));
end;
$$;

/**
 * "Stiahnuť": the original file when it may be downloaded (its setting, else its folder's
 * mode) and the session has downloads left (20). Counts one download for the session and
 * the folder. Returns {status: ok | not_found | limit, path, name}. Service role only.
 */
create or replace function public.shop_download_file(p_slug text, p_kind text, p_id uuid, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := public.docs_shop(p_slug);
  v_session public.folder_sessions;
  v_folders uuid[];
  v_folder uuid;
  v_path text;
  v_name text;
begin
  if v_shop is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  v_session := public.docs_open_session(v_shop, p_token);
  v_folders := public.docs_session_folders(v_shop, p_token);
  if p_kind = 'document' then
    select d.folder_id, d.storage_path, d.name || '.pdf' into v_folder, v_path, v_name
    from public.shop_documents d join public.shop_folders f on f.id = d.folder_id
    where d.id = p_id and d.shop_id = v_shop and d.folder_id = any (v_folders) and d.status in ('processing', 'ready')
      and public.docs_file_access(f.access_mode, d.access) = 'download';
  elsif p_kind = 'picture' then
    select p.folder_id, p.storage_path,
           coalesce(nullif(p.title, ''), 'obrazok') || '.' || coalesce(substring(p.storage_path from '\.([a-z]+)$'), 'jpg')
      into v_folder, v_path, v_name
    from public.shop_pictures p join public.shop_folders f on f.id = p.folder_id
    where p.id = p_id and p.shop_id = v_shop and p.folder_id = any (v_folders) and p.kind = 'picture'
      and p.document_id is null and p.status <> 'uploading'
      and public.docs_file_access(f.access_mode, p.access) = 'download';
  end if;
  if v_folder is null or v_session.token_hash is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  update public.folder_sessions set downloads = downloads + 1
  where token_hash = v_session.token_hash and downloads < 20;
  if not found then
    return jsonb_build_object('status', 'limit');
  end if;
  update public.shop_folders set downloads = downloads + 1 where id = v_folder;
  return jsonb_build_object('status', 'ok', 'path', v_path, 'name', v_name);
end;
$$;

/**
 * "Stiahnuť celý priečinok (ZIP)": a single-use ticket for 10 minutes when the session opens
 * the folder, it has downloadable files, at most 100 MB together, and the session has
 * downloads left (the ZIP counts as one). Returns {status: ok | not_found | empty |
 * too_big | limit, ticket}. Service role only.
 */
create or replace function public.shop_zip_ticket(p_slug text, p_folder_id uuid, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := public.docs_shop(p_slug);
  v_session public.folder_sessions;
  v_count integer;
  v_bytes bigint;
  v_ticket text;
begin
  if v_shop is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  v_session := public.docs_open_session(v_shop, p_token);
  if v_session.token_hash is null or not (p_folder_id = any (public.docs_session_folders(v_shop, p_token))) then
    return jsonb_build_object('status', 'not_found');
  end if;
  select count(*), coalesce(sum(x.bytes), 0) into v_count, v_bytes
  from public.shop_folder_files(p_slug, p_token) x
  where x.folder_id = p_folder_id and x.can_download;
  if v_count = 0 then
    return jsonb_build_object('status', 'empty');
  end if;
  if v_bytes > 104857600 then
    return jsonb_build_object('status', 'too_big');
  end if;
  update public.folder_sessions set downloads = downloads + 1
  where token_hash = v_session.token_hash and downloads < 20;
  if not found then
    return jsonb_build_object('status', 'limit');
  end if;
  update public.shop_folders set downloads = downloads + 1 where id = p_folder_id;
  v_ticket := public.docs_random(40);
  insert into public.folder_zip_tickets (ticket_hash, shop_id, folder_id, session_hash, expires_at)
  values (public.docs_hash(v_ticket), v_shop, p_folder_id, v_session.token_hash, now() + interval '10 minutes');
  return jsonb_build_object('status', 'ok', 'ticket', v_ticket);
end;
$$;

/**
 * The ZIP ticket is used (once, within 10 minutes, while its session and the folder are still
 * open): the folder's name and its downloadable files now. Service role only.
 */
create or replace function public.shop_zip_take(p_ticket text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_t public.folder_zip_tickets;
begin
  update public.folder_zip_tickets set used_at = now()
  where ticket_hash = public.docs_hash(p_ticket) and used_at is null and expires_at > now()
  returning * into v_t;
  if not found then
    return null;
  end if;
  if not exists (
    select 1 from public.folder_sessions s join public.folder_keys k on k.id = s.key_id
    where s.token_hash = v_t.session_hash and s.expires_at > now() and v_t.folder_id = any (s.folder_ids)
      and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())
  ) then
    return null;
  end if;
  return jsonb_build_object(
    'folder', (select f.name from public.shop_folders f where f.id = v_t.folder_id),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object('path', x.path, 'name', x.name, 'bytes', x.bytes) order by x.name)
      from (
        select d.storage_path as path, d.name || '.pdf' as name, d.bytes
        from public.shop_documents d join public.shop_folders f on f.id = d.folder_id
        where d.folder_id = v_t.folder_id and d.shop_id = v_t.shop_id and d.status in ('processing', 'ready')
          and public.docs_file_access(f.access_mode, d.access) = 'download'
        union all
        select p.storage_path, coalesce(nullif(p.title, ''), 'obrazok') || '.' ||
               coalesce(substring(p.storage_path from '\.([a-z]+)$'), 'jpg'), p.bytes::bigint
        from public.shop_pictures p join public.shop_folders f on f.id = p.folder_id
        where p.folder_id = v_t.folder_id and p.shop_id = v_t.shop_id and p.kind = 'picture' and p.document_id is null
          and p.status <> 'uploading' and public.docs_file_access(f.access_mode, p.access) = 'download'
      ) x), '[]'::jsonb));
end;
$$;

/**
 * As in update 20, but a private folder's files follow the new access rule: a document opens
 * as the original only when it may be downloaded; a picture the assistant shows from a
 * private folder only when it may be downloaded (otherwise the chat shows it through the
 * viewer, with the watermark). Public folder: unchanged.
 */
create or replace function public.shop_file_path(p_slug text, p_kind text, p_id uuid, p_session_token text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with shop as (select public.docs_shop(p_slug) as id),
       visible as (select public.docs_visible_folders(shop.id, p_session_token) as folders from shop)
  select case
    when p_kind = 'document' then (
      select d.storage_path from public.shop_documents d
      join public.shop_folders f on f.id = d.folder_id, shop, visible
      where d.id = p_id and d.shop_id = shop.id and d.folder_id = any (visible.folders) and d.status <> 'uploading'
        and case when f.is_public then d.downloadable
                 else public.docs_file_access(f.access_mode, d.access) = 'download' end)
    when p_kind = 'picture' then (
      select p.storage_path from public.shop_pictures p
      join public.shop_folders f on f.id = p.folder_id
      left join public.shop_documents d on d.id = p.document_id, shop, visible
      where p.id = p_id and p.shop_id = shop.id and p.folder_id = any (visible.folders)
        and p.kind = 'picture' and p.show and p.status <> 'uploading' and coalesce(d.assistant_enabled, true)
        and (f.is_public or public.docs_file_access(f.access_mode, coalesce(p.access, d.access)) = 'download'))
  end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'shop_view_file(text, text, uuid, text, boolean)', 'shop_download_file(text, text, uuid, text)',
    'shop_zip_ticket(text, uuid, text)', 'shop_zip_take(text)', 'shop_file_path(text, text, uuid, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ page pictures (doc-ingest, the owner's browser)

/** Registers a PDF's page pictures before they are uploaded (doc-ingest, after the owner's login). */
create or replace function public.docs_register_pages(p_document_id uuid, p_pages jsonb)
returns table (page integer, storage_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_doc public.shop_documents;
  v_item jsonb;
  v_page integer;
  v_ext text;
begin
  select * into v_doc from public.shop_documents where id = p_document_id;
  if not found or v_doc.status not in ('processing', 'ready') then
    raise exception 'document' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) > 100 then
    raise exception 'Send at most 100 pages at once' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_pages) loop
    v_page := (v_item ->> 'page')::integer;
    v_ext := case v_item ->> 'type' when 'image/webp' then 'webp' when 'image/jpeg' then 'jpg' else null end;
    if v_page is null or v_page < 1 or v_page > v_doc.pages or v_ext is null
       or coalesce((v_item ->> 'bytes')::integer, 0) not between 1 and 5242880 then
      raise exception 'Each page needs its number, size (at most 5 MB) and type (WebP or JPEG)' using errcode = '22023';
    end if;
    insert into public.shop_document_pages (document_id, page, shop_id, storage_path, bytes, width, height, uploaded)
    values (v_doc.id, v_page, v_doc.shop_id,
            v_doc.shop_id || '/' || v_doc.id || '/pages/' || v_page || '-' || substr(md5(random()::text), 1, 8) || '.' || v_ext,
            (v_item ->> 'bytes')::integer,
            nullif(least(greatest(coalesce((v_item ->> 'width')::integer, 0), 0), 10000), 0),
            nullif(least(greatest(coalesce((v_item ->> 'height')::integer, 0), 0), 10000), 0),
            false)
    on conflict on constraint shop_document_pages_pkey do update
      set storage_path = excluded.storage_path, bytes = excluded.bytes, width = excluded.width,
          height = excluded.height, uploaded = false, created_at = now()
      where public.shop_document_pages.uploaded = false;
  end loop;
  return query
  select pg.page, pg.storage_path from public.shop_document_pages pg
  where pg.document_id = v_doc.id and not pg.uploaded
    and pg.page in (select (value ->> 'page')::integer from jsonb_array_elements(p_pages))
  order by pg.page;
end;
$$;

/** The page pictures are in storage (doc-ingest checked each file). Returns how many are ready now. */
create or replace function public.docs_pages_uploaded(p_document_id uuid, p_pages integer[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with done as (
    update public.shop_document_pages set uploaded = true
    where document_id = p_document_id and page = any (p_pages)
    returning 1
  )
  select (select count(*)::integer from done)
$$;

/** As in update 20, and page pictures the owner registered and has not uploaded yet. */
create or replace function public.shop_docs_upload_allowed(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.shop_documents d
                 where d.storage_path = p_name and d.status = 'uploading' and public.is_shop_member(d.shop_id))
      or exists (select 1 from public.shop_pictures p
                 where p.storage_path = p_name and p.status = 'uploading' and public.is_shop_member(p.shop_id))
      or exists (select 1 from public.shop_document_pages pg
                 where pg.storage_path = p_name and not pg.uploaded and public.is_shop_member(pg.shop_id))
$$;

/** As in update 20, and a document's page pictures go with it. */
create or replace function public.owner_docs_files(p_kind text, p_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  if p_kind = 'document' then
    select shop_id into v_shop from public.shop_documents where id = p_id;
  elsif p_kind = 'picture' then
    select shop_id into v_shop from public.shop_pictures where id = p_id and kind = 'picture';
  end if;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your file' using errcode = '42501';
  end if;
  if p_kind = 'document' then
    return array(select storage_path from public.shop_documents where id = p_id
                 union all select storage_path from public.shop_pictures where document_id = p_id
                 union all select storage_path from public.shop_document_pages where document_id = p_id);
  end if;
  return array(select storage_path from public.shop_pictures where id = p_id);
end;
$$;

revoke execute on function public.docs_register_pages(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.docs_pages_uploaded(uuid, integer[]) from public, anon, authenticated;
grant execute on function public.docs_register_pages(uuid, jsonb) to service_role;
grant execute on function public.docs_pages_uploaded(uuid, integer[]) to service_role;
revoke execute on function public.shop_docs_upload_allowed(text) from public, anon;
grant execute on function public.shop_docs_upload_allowed(text) to authenticated;
revoke execute on function public.owner_docs_files(text, uuid) from public, anon;
grant execute on function public.owner_docs_files(text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ owners

/** "Režim prístupu" of a private folder: 'view' (Len zobraziť) or 'download' (Zobraziť a stiahnuť). */
create or replace function public.owner_set_folder_access(p_folder_id uuid, p_mode text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder public.shop_folders;
begin
  select * into v_folder from public.shop_folders where id = p_folder_id;
  if not found or not public.is_shop_member(v_folder.shop_id) then
    raise exception 'Not your folder' using errcode = '42501';
  end if;
  if v_folder.is_public then
    raise exception 'The Public folder has no access mode' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('view', 'download') then
    raise exception 'Mode: view or download' using errcode = '22023';
  end if;
  update public.shop_folders set access_mode = p_mode where id = p_folder_id;
end;
$$;

/** A file's own setting in a private folder: null = as its folder, 'view' or 'download'. */
create or replace function public.owner_set_file_access(p_kind text, p_id uuid, p_access text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  if p_access is not null and p_access not in ('view', 'download') then
    raise exception 'Access: null, view or download' using errcode = '22023';
  end if;
  if p_kind = 'document' then
    select shop_id into v_shop from public.shop_documents where id = p_id;
  elsif p_kind = 'picture' then
    select shop_id into v_shop from public.shop_pictures where id = p_id and kind = 'picture' and document_id is null;
  end if;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your file' using errcode = '42501';
  end if;
  if p_kind = 'document' then
    update public.shop_documents set access = p_access, updated_at = now() where id = p_id;
  else
    update public.shop_pictures set access = p_access, updated_at = now() where id = p_id;
  end if;
end;
$$;

/**
 * "Nastaviť kľúč" / "Zmeniť kľúč" of a private folder: a new key that opens only this folder;
 * the folder's previous key stops at once (whoever unlocked with it loses access). Returns
 * the key once; only its hash is kept. Keys made under "Prístupové kľúče" are not touched.
 */
create or replace function public.owner_set_folder_key(p_folder_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder public.shop_folders;
  v_old uuid[];
  v_key text;
begin
  select * into v_folder from public.shop_folders where id = p_folder_id;
  if not found or not public.is_shop_member(v_folder.shop_id) then
    raise exception 'Not your folder' using errcode = '42501';
  end if;
  if v_folder.is_public then
    raise exception 'The Public folder needs no key' using errcode = '22023';
  end if;
  select array_agg(id) into v_old from public.folder_keys
  where shop_id = v_folder.shop_id and folder_key and folder_ids = array[p_folder_id] and revoked_at is null;
  if v_old is not null then
    update public.folder_keys set revoked_at = now() where id = any (v_old);
    delete from public.folder_sessions where key_id = any (v_old);
  end if;
  v_key := public.docs_random(20);
  insert into public.folder_keys (shop_id, label, key_hash, folder_ids, folder_key)
  values (v_folder.shop_id, left(v_folder.name, 80), public.docs_hash(v_key), array[p_folder_id], true);
  return substr(v_key, 1, 4) || '-' || substr(v_key, 5, 4) || '-' || substr(v_key, 9, 4) || '-' ||
         substr(v_key, 13, 4) || '-' || substr(v_key, 17, 4);
end;
$$;

/** "Zákazník si môže stiahnuť svoju konverzáciu (PDF)": on or off for the shop. */
create or replace function public.owner_set_shopper_pdf(p_shop_id uuid, p_on boolean)
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
  insert into public.shop_assistant_settings (shop_id, shopper_pdf) values (p_shop_id, coalesce(p_on, true))
  on conflict (shop_id) do update set shopper_pdf = coalesce(p_on, true), updated_at = now();
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'owner_set_folder_access(uuid, text)', 'owner_set_file_access(text, uuid, text)', 'owner_set_folder_key(uuid)',
    'owner_set_shopper_pdf(uuid, boolean)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ the shopper's own conversation PDF

/** Whether shoppers of this shop may download their own conversation (paid plan; on unless the owner turned it off). */
create or replace function public.shopper_pdf_allowed(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select coalesce(st.shopper_pdf, true)
    from public.shops s left join public.shop_assistant_settings st on st.shop_id = s.id
    where s.slug = p_slug and s.is_active and public.shop_has_plan(s.id)), false)
$$;
revoke execute on function public.shopper_pdf_allowed(text) from public;
grant execute on function public.shopper_pdf_allowed(text) to anon, authenticated, service_role;

/**
 * The data of the shopper's own conversation for "Stiahnuť túto konverzáciu (PDF)": only with
 * the conversation's own token, only when the shop allows it and it has messages. Service
 * role only (assistant-archive).
 */
create or replace function public.assistant_shopper_pdf_data(p_id uuid, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.assistant_pdf_data(c.id)
  from public.assistant_conversations c
  join public.shops s on s.id = c.shop_id
  where c.id = p_id and c.token_hash = public.assistant_token_hash(p_token) and c.message_count > 0
    and c.shopper_deleted_at is null and public.shopper_pdf_allowed(s.slug)
$$;
revoke execute on function public.assistant_shopper_pdf_data(uuid, text) from public, anon, authenticated;
grant execute on function public.assistant_shopper_pdf_data(uuid, text) to service_role;
