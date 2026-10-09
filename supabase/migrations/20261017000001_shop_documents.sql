-- PPI · 20 · Documents and pictures for the shop assistant (a paid feature).
--  - shop_folders: every shop has one Public folder (anyone may ask about it) and may
--    have private folders, opened only with an access key (folder_keys → folder_sessions)
--  - shop_documents (PDFs) and shop_pictures (the owner's own pictures, pictures taken
--    out of PDFs, and rendered scan pages): files in the private bucket "shop-docs"
--  - shop_document_chunks: their text as written (never translated or corrected) and
--    the AI description of each picture, searchable; read only through
--    search_shop_docs(), which itself decides which folders a caller may see
--  - none of this is ever a product: items, prices and stock come only from the stock file
-- Safe to run again.

alter table public.shops add column if not exists docs_terms_accepted_at timestamptz;

-- ------------------------------------------------------------------ tables

create table if not exists public.shop_folders (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  is_public  boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists shop_folders_public_idx on public.shop_folders (shop_id) where is_public;
create unique index if not exists shop_folders_name_idx on public.shop_folders (shop_id, lower(name));

create table if not exists public.shop_documents (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops (id) on delete cascade,
  folder_id         uuid not null references public.shop_folders (id),
  name              text not null check (length(btrim(name)) between 1 and 200),
  description       text check (description is null or length(description) <= 500),
  storage_path      text not null unique,
  bytes             bigint not null check (bytes between 1 and 20971520),
  pages             integer not null check (pages between 1 and 5000),
  lang              text check (lang is null or lang ~ '^[a-z]{2}$'),
  status            text not null default 'uploading'
                    check (status in ('uploading', 'processing', 'ready', 'error')),
  error             text,
  assistant_enabled boolean not null default true,
  downloadable      boolean not null default false,
  -- the owner's browser has sent all text and pictures of the file (doc-ingest "done")
  extracted         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists shop_documents_shop_idx on public.shop_documents (shop_id);

create table if not exists public.shop_pictures (
  id                   uuid primary key default gen_random_uuid(),
  shop_id              uuid not null references public.shops (id) on delete cascade,
  folder_id            uuid not null references public.shop_folders (id),
  document_id          uuid references public.shop_documents (id) on delete cascade,
  page                 integer check (page is null or page >= 1),
  -- 'picture': shown to shoppers when show is on; 'scan': a PDF page without a text
  -- layer, rendered only so that the AI can read its text (never shown)
  kind                 text not null default 'picture' check (kind in ('picture', 'scan')),
  -- the owner's own words (own pictures): never changed by PPI
  title                text not null default '' check (length(title) <= 200),
  caption              text check (caption is null or length(caption) <= 500),
  -- what the AI saw in the picture, written once; the owner may correct it (then it is theirs)
  description          text check (description is null or length(description) <= 2000),
  description_by_owner boolean not null default false,
  show                 boolean not null default true,
  storage_path         text not null unique,
  bytes                integer not null check (bytes between 1 and 10485760),
  lang                 text check (lang is null or lang ~ '^[a-z]{2}$'),
  status               text not null default 'uploading'
                       check (status in ('uploading', 'pending', 'working', 'ready', 'error')),
  attempts             integer not null default 0,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (kind = 'picture' or (document_id is not null and page is not null and not show))
);
create index if not exists shop_pictures_shop_idx on public.shop_pictures (shop_id, status);
create index if not exists shop_pictures_document_idx on public.shop_pictures (document_id);

create table if not exists public.shop_document_chunks (
  id          bigint generated always as identity primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  folder_id   uuid not null references public.shop_folders (id),
  document_id uuid references public.shop_documents (id) on delete cascade,
  picture_id  uuid references public.shop_pictures (id) on delete cascade,
  page        integer,
  type        text not null check (type in ('text', 'picture')),
  text        text not null check (length(text) between 1 and 20000),
  lang        text,
  search      tsvector generated always as (to_tsvector('simple'::regconfig, public.search_text(text))) stored,
  created_at  timestamptz not null default now(),
  check (document_id is not null or picture_id is not null)
);
create index if not exists shop_document_chunks_shop_idx on public.shop_document_chunks (shop_id, folder_id);
create index if not exists shop_document_chunks_document_idx on public.shop_document_chunks (document_id);
create index if not exists shop_document_chunks_picture_idx on public.shop_document_chunks (picture_id);
create index if not exists shop_document_chunks_search_idx on public.shop_document_chunks using gin (search);
create index if not exists shop_document_chunks_trgm_idx
  on public.shop_document_chunks using gin (public.search_text(text) extensions.gin_trgm_ops);

create table if not exists public.folder_keys (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops (id) on delete cascade,
  label        text not null check (length(btrim(label)) between 1 and 80),
  key_hash     text not null unique,
  folder_ids   uuid[] not null check (cardinality(folder_ids) >= 1),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  use_count    integer not null default 0
);
create index if not exists folder_keys_shop_idx on public.folder_keys (shop_id);

create table if not exists public.folder_sessions (
  token_hash text primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  key_id     uuid references public.folder_keys (id) on delete cascade,
  folder_ids uuid[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists folder_sessions_shop_idx on public.folder_sessions (shop_id, expires_at);

-- Every shop has its Public folder (shown as "Public" in the page language).
create or replace function public.add_public_folder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.shop_folders (shop_id, name, is_public) values (new.id, 'Public', true) on conflict do nothing;
  return new;
end;
$$;
revoke execute on function public.add_public_folder() from public, anon, authenticated;
drop trigger if exists shops_public_folder on public.shops;
create trigger shops_public_folder after insert on public.shops
  for each row execute function public.add_public_folder();
insert into public.shop_folders (shop_id, name, is_public)
select s.id, 'Public', true from public.shops s
where not exists (select 1 from public.shop_folders f where f.shop_id = s.id and f.is_public);

-- ------------------------------------------------------------------ privileges and RLS

alter table public.shop_folders enable row level security;
alter table public.shop_documents enable row level security;
alter table public.shop_pictures enable row level security;
alter table public.shop_document_chunks enable row level security;
alter table public.folder_keys enable row level security;
alter table public.folder_sessions enable row level security;

revoke all on public.shop_folders, public.shop_documents, public.shop_pictures, public.shop_document_chunks,
              public.folder_keys, public.folder_sessions
  from public, anon, authenticated;
grant all on public.shop_folders, public.shop_documents, public.shop_pictures, public.shop_document_chunks,
             public.folder_keys, public.folder_sessions
  to service_role;
-- Owners read their own folders, documents, pictures and keys (never a key's hash);
-- every change goes through the owner_* functions below.
grant select on public.shop_folders, public.shop_documents, public.shop_pictures to authenticated;
grant select (id, shop_id, label, folder_ids, expires_at, revoked_at, created_at, last_used_at, use_count)
  on public.folder_keys to authenticated;

drop policy if exists "shop_folders: members read" on public.shop_folders;
create policy "shop_folders: members read" on public.shop_folders
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "shop_documents: members read" on public.shop_documents;
create policy "shop_documents: members read" on public.shop_documents
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "shop_pictures: members read" on public.shop_pictures;
create policy "shop_pictures: members read" on public.shop_pictures
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "folder_keys: members read" on public.folder_keys;
create policy "folder_keys: members read" on public.folder_keys
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ helpers

/** Access keys and session tokens are stored only as their SHA-256. */
create or replace function public.docs_hash(p_secret text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(upper(regexp_replace(coalesce(p_secret, ''), '[^A-Za-z0-9]', '', 'g')), 'UTF8')), 'hex')
$$;
revoke execute on function public.docs_hash(text) from public, anon, authenticated;

/** n random characters from an alphabet without look-alikes (0/O, 1/I/L). */
create or replace function public.docs_random(p_length integer)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := ''::bytea;
  v_out text := '';
  i integer;
begin
  while length(v_bytes) < p_length loop
    v_bytes := v_bytes || decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  end loop;
  for i in 0 .. p_length - 1 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.docs_random(integer) from public, anon, authenticated;

/** An active shop with the paid plan, by its page address. */
create or replace function public.docs_shop(p_slug text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from public.shops s
  where s.slug = p_slug and s.is_active and public.shop_has_plan(s.id)
$$;
revoke execute on function public.docs_shop(text) from public, anon, authenticated;

/**
 * The private folders a session token opens in this shop: the session must exist, be
 * this shop's and not expired, and its key must not be revoked or expired.
 */
create or replace function public.docs_session_folders(p_shop_id uuid, p_token text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select array_agg(distinct f.id)
    from public.folder_sessions s
    join public.folder_keys k on k.id = s.key_id
    join public.shop_folders f on f.id = any (s.folder_ids) and f.shop_id = p_shop_id and not f.is_public
    where p_token is not null and length(p_token) >= 32
      and s.token_hash = public.docs_hash(p_token)
      and s.shop_id = p_shop_id
      and s.expires_at > now()
      and k.revoked_at is null
      and (k.expires_at is null or k.expires_at > now())
  ), '{}'::uuid[])
$$;
revoke execute on function public.docs_session_folders(uuid, text) from public, anon, authenticated;

/** The folders a caller may see: the shop's Public folder plus the ones the token opens. */
create or replace function public.docs_visible_folders(p_shop_id uuid, p_token text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select array(select f.id from public.shop_folders f where f.shop_id = p_shop_id and f.is_public)
         || public.docs_session_folders(p_shop_id, p_token)
$$;
revoke execute on function public.docs_visible_folders(uuid, text) from public, anon, authenticated;

/**
 * A picture's searchable text: its title, the owner's caption and the AI's (or the owner's
 * corrected) description, in its folder. Scan pages have none (their text is document text).
 */
create or replace function public.docs_picture_chunk(p_picture_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pic public.shop_pictures;
  v_text text;
begin
  delete from public.shop_document_chunks where picture_id = p_picture_id;
  select * into v_pic from public.shop_pictures where id = p_picture_id;
  if not found or v_pic.kind <> 'picture' then
    return;
  end if;
  v_text := left(concat_ws(E'\n', nullif(btrim(v_pic.title), ''), nullif(btrim(v_pic.caption), ''),
                           nullif(btrim(v_pic.description), '')), 20000);
  if coalesce(v_text, '') <> '' then
    insert into public.shop_document_chunks (shop_id, folder_id, document_id, picture_id, page, type, text, lang)
    values (v_pic.shop_id, v_pic.folder_id, v_pic.document_id, p_picture_id, v_pic.page, 'picture', v_text, v_pic.lang);
  end if;
end;
$$;
revoke execute on function public.docs_picture_chunk(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ owner functions

create or replace function public.owner_accept_docs_terms(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.shops set docs_terms_accepted_at = coalesce(docs_terms_accepted_at, now()) where id = p_shop_id;
end;
$$;

/** New private folder (p_folder_id null) or a new name for a private one. */
create or replace function public.owner_save_folder(p_shop_id uuid, p_folder_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if length(v_name) not between 1 and 60 then
    raise exception 'Folder name: 1 to 60 characters' using errcode = '22023';
  end if;
  if exists (select 1 from public.shop_folders where shop_id = p_shop_id and lower(name) = lower(v_name)
             and id is distinct from p_folder_id) then
    raise exception 'A folder with this name exists' using errcode = '23505';
  end if;
  if p_folder_id is null then
    if (select count(*) from public.shop_folders where shop_id = p_shop_id) >= 20 then
      raise exception 'At most 20 folders' using errcode = '54000';
    end if;
    insert into public.shop_folders (shop_id, name) values (p_shop_id, v_name) returning id into v_id;
    return v_id;
  end if;
  update public.shop_folders set name = v_name
  where id = p_folder_id and shop_id = p_shop_id and not is_public
  returning id into v_id;
  if v_id is null then
    raise exception 'Not a private folder of this shop' using errcode = '42501';
  end if;
  return v_id;
end;
$$;

/** Deletes an empty private folder; keys lose it (a key left with no folder is deleted). */
create or replace function public.owner_delete_folder(p_folder_id uuid)
returns void
language plpgsql
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
    raise exception 'The Public folder cannot be deleted' using errcode = '22023';
  end if;
  if exists (select 1 from public.shop_documents where folder_id = p_folder_id)
     or exists (select 1 from public.shop_pictures where folder_id = p_folder_id) then
    raise exception 'Move or delete its documents and pictures first' using errcode = '55006';
  end if;
  update public.folder_keys set folder_ids = array_remove(folder_ids, p_folder_id)
  where shop_id = v_folder.shop_id and p_folder_id = any (folder_ids) and cardinality(folder_ids) > 1;
  delete from public.folder_keys where shop_id = v_folder.shop_id and folder_ids = array[p_folder_id];
  update public.folder_sessions set folder_ids = array_remove(folder_ids, p_folder_id)
  where shop_id = v_folder.shop_id;
  delete from public.shop_folders where id = p_folder_id;
end;
$$;

/** A document's name, description, folder and switches; its pictures and text move along. */
create or replace function public.owner_update_document(
  p_document_id uuid,
  p_name text,
  p_description text,
  p_folder_id uuid,
  p_assistant_enabled boolean,
  p_downloadable boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.shop_documents;
begin
  select * into v_doc from public.shop_documents where id = p_document_id;
  if not found or not public.is_shop_member(v_doc.shop_id) then
    raise exception 'Not your document' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shop_folders where id = p_folder_id and shop_id = v_doc.shop_id) then
    raise exception 'Not a folder of this shop' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 200 or length(coalesce(p_description, '')) > 500 then
    raise exception 'Name 1 to 200 characters, description up to 500' using errcode = '22023';
  end if;
  update public.shop_documents
  set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), folder_id = p_folder_id,
      assistant_enabled = coalesce(p_assistant_enabled, assistant_enabled),
      downloadable = coalesce(p_downloadable, downloadable), updated_at = now()
  where id = p_document_id;
  if p_folder_id <> v_doc.folder_id then
    update public.shop_pictures set folder_id = p_folder_id, updated_at = now() where document_id = p_document_id;
    update public.shop_document_chunks set folder_id = p_folder_id
    where document_id = p_document_id
       or picture_id in (select id from public.shop_pictures where document_id = p_document_id);
  end if;
end;
$$;

/**
 * A picture's title and caption (the owner's own words), folder (own pictures only;
 * pictures from a PDF stay with it), "Assistant may show it" and description. The
 * description is the AI's until the owner changes it; then it is the owner's and never
 * written by the AI again. The owner is the only one who can correct it.
 */
create or replace function public.owner_update_picture(
  p_picture_id uuid,
  p_title text,
  p_caption text,
  p_description text,
  p_folder_id uuid,
  p_show boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pic public.shop_pictures;
  v_title text := btrim(coalesce(p_title, ''));
  v_caption text := nullif(btrim(coalesce(p_caption, '')), '');
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_folder uuid;
begin
  select * into v_pic from public.shop_pictures where id = p_picture_id;
  if not found or not public.is_shop_member(v_pic.shop_id) or v_pic.kind <> 'picture' then
    raise exception 'Not your picture' using errcode = '42501';
  end if;
  if length(v_title) > 200 or length(coalesce(v_caption, '')) > 500 or length(coalesce(v_description, '')) > 2000 then
    raise exception 'Title up to 200 characters, caption up to 500, description up to 2000' using errcode = '22023';
  end if;
  v_folder := case when v_pic.document_id is null then coalesce(p_folder_id, v_pic.folder_id) else v_pic.folder_id end;
  if not exists (select 1 from public.shop_folders where id = v_folder and shop_id = v_pic.shop_id) then
    raise exception 'Not a folder of this shop' using errcode = '42501';
  end if;
  update public.shop_pictures
  set title = v_title,
      caption = v_caption,
      description = v_description,
      description_by_owner = description_by_owner or v_description is distinct from v_pic.description,
      folder_id = v_folder,
      show = coalesce(p_show, show),
      updated_at = now()
  where id = p_picture_id;
  perform public.docs_picture_chunk(p_picture_id);
end;
$$;

/** A new access key for one or more private folders. Returns the key once; only its hash is kept. */
create or replace function public.owner_create_folder_key(
  p_shop_id uuid,
  p_label text,
  p_folder_ids uuid[],
  p_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_folders uuid[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_label, ''))) not between 1 and 80 then
    raise exception 'Label: 1 to 80 characters' using errcode = '22023';
  end if;
  select array_agg(distinct f.id) into v_folders
  from public.shop_folders f where f.id = any (p_folder_ids) and f.shop_id = p_shop_id and not f.is_public;
  if v_folders is null or cardinality(v_folders) <> cardinality(array(select distinct unnest(p_folder_ids))) then
    raise exception 'Choose private folders of this shop' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The expiry date has passed' using errcode = '22023';
  end if;
  if (select count(*) from public.folder_keys where shop_id = p_shop_id and revoked_at is null) >= 100 then
    raise exception 'At most 100 keys' using errcode = '54000';
  end if;
  v_key := public.docs_random(20);
  insert into public.folder_keys (shop_id, label, key_hash, folder_ids, expires_at)
  values (p_shop_id, btrim(p_label), public.docs_hash(v_key), v_folders, p_expires_at);
  return substr(v_key, 1, 4) || '-' || substr(v_key, 5, 4) || '-' || substr(v_key, 9, 4) || '-' ||
         substr(v_key, 13, 4) || '-' || substr(v_key, 17, 4);
end;
$$;

/** Revokes a key; whoever unlocked folders with it loses them at once. */
create or replace function public.owner_revoke_folder_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select shop_id into v_shop from public.folder_keys where id = p_key_id;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your key' using errcode = '42501';
  end if;
  update public.folder_keys set revoked_at = coalesce(revoked_at, now()) where id = p_key_id;
  delete from public.folder_sessions where key_id = p_key_id;
end;
$$;

/** Storage paths of an owner's own pictures (for thumbnails on the dashboard). */
create or replace function public.owner_picture_paths(p_shop_id uuid, p_ids uuid[])
returns table (id uuid, storage_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.storage_path from public.shop_pictures p
  where public.is_shop_member(p_shop_id) and p.shop_id = p_shop_id and p.id = any (p_ids) and p.status <> 'uploading'
$$;

/** The files of a document (with its pictures) or of one picture, for deleting them. */
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
                 union all select storage_path from public.shop_pictures where document_id = p_id);
  end if;
  return array(select storage_path from public.shop_pictures where id = p_id);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'owner_accept_docs_terms(uuid)', 'owner_save_folder(uuid, uuid, text)', 'owner_delete_folder(uuid)',
    'owner_update_document(uuid, text, text, uuid, boolean, boolean)',
    'owner_update_picture(uuid, text, text, text, uuid, boolean)',
    'owner_create_folder_key(uuid, text, uuid[], timestamptz)', 'owner_revoke_folder_key(uuid)',
    'owner_picture_paths(uuid, uuid[])', 'owner_docs_files(text, uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ service functions (doc-ingest)

/**
 * Registers a PDF before its upload (doc-ingest, after checking the owner's login):
 * paid plan, accepted terms, a folder of this shop, and the shop's limits.
 */
create or replace function public.docs_register_document(
  p_shop_id uuid,
  p_folder_id uuid,
  p_name text,
  p_description text,
  p_pages integer,
  p_bytes bigint,
  p_max_files integer,
  p_max_pages integer
)
returns table (document_id uuid, storage_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  if (select docs_terms_accepted_at from public.shops where id = p_shop_id) is null then
    raise exception 'terms' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.shop_folders where id = p_folder_id and shop_id = p_shop_id) then
    raise exception 'folder' using errcode = 'P0001';
  end if;
  if (select count(*) from public.shop_documents where shop_id = p_shop_id) >= p_max_files then
    raise exception 'limit_files' using errcode = 'P0001';
  end if;
  if coalesce((select sum(pages) from public.shop_documents where shop_id = p_shop_id), 0) + p_pages > p_max_pages then
    raise exception 'limit_pages' using errcode = 'P0001';
  end if;
  v_path := p_shop_id || '/docs/' || v_id || '.pdf';
  insert into public.shop_documents (id, shop_id, folder_id, name, description, storage_path, bytes, pages)
  values (v_id, p_shop_id, p_folder_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), v_path, p_bytes, p_pages);
  return query select v_id, v_path;
end;
$$;

/**
 * Registers pictures before their upload: the owner's own (no document; title and caption
 * are the owner's words) or taken out of a PDF (its folder; scan pages are never shown).
 * Own and PDF pictures count towards the shop's picture limit; pictures over it are
 * refused (null path).
 */
create or replace function public.docs_register_pictures(
  p_shop_id uuid,
  p_folder_id uuid,
  p_document_id uuid,
  p_items jsonb,
  p_lang text,
  p_max_pictures integer
)
returns table (idx integer, picture_id uuid, storage_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder uuid := p_folder_id;
  v_lang text := case when p_lang ~ '^[a-z]{2}$' then p_lang end;
  v_count integer;
  v_item jsonb;
  v_i integer := 0;
  v_id uuid;
  v_kind text;
  v_path text;
begin
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  if (select docs_terms_accepted_at from public.shops where id = p_shop_id) is null then
    raise exception 'terms' using errcode = 'P0001';
  end if;
  if p_document_id is not null then
    select d.folder_id, coalesce(d.lang, v_lang) into v_folder, v_lang
    from public.shop_documents d where d.id = p_document_id and d.shop_id = p_shop_id and not d.extracted;
    if v_folder is null then
      raise exception 'document' using errcode = 'P0001';
    end if;
  elsif not exists (select 1 from public.shop_folders where id = p_folder_id and shop_id = p_shop_id) then
    raise exception 'folder' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.shop_pictures where shop_id = p_shop_id and kind = 'picture';
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_kind := case when v_item ->> 'kind' = 'scan' and p_document_id is not null then 'scan' else 'picture' end;
    idx := v_i;
    if v_kind = 'picture' and v_count >= p_max_pictures then
      picture_id := null;
      storage_path := null;
    else
      v_id := gen_random_uuid();
      v_path := p_shop_id || '/pictures/' || v_id || '.' ||
                case v_item ->> 'type' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end;
      insert into public.shop_pictures (id, shop_id, folder_id, document_id, page, kind, title, caption, show,
                                        storage_path, bytes, lang)
      values (v_id, p_shop_id, v_folder, p_document_id,
              case when p_document_id is not null then greatest(1, (v_item ->> 'page')::integer) end, v_kind,
              left(btrim(coalesce(v_item ->> 'title', '')), 200),
              nullif(left(btrim(coalesce(v_item ->> 'caption', '')), 500), ''),
              v_kind = 'picture', v_path, greatest(1, least((v_item ->> 'bytes')::bigint, 10485760))::integer, v_lang);
      if v_kind = 'picture' then
        v_count := v_count + 1;
      end if;
      picture_id := v_id;
      storage_path := v_path;
    end if;
    return next;
    v_i := v_i + 1;
  end loop;
end;
$$;

/** The PDF is in storage: its text and pictures may follow. */
create or replace function public.docs_document_uploaded(p_document_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with done as (
    update public.shop_documents set status = 'processing', updated_at = now()
    where id = p_document_id and status = 'uploading'
    returning 1
  )
  select exists (select 1 from done)
$$;

/** These pictures are in storage: the AI may look at them. */
create or replace function public.docs_pictures_uploaded(p_shop_id uuid, p_picture_ids uuid[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with done as (
    update public.shop_pictures set status = 'pending', updated_at = now()
    where shop_id = p_shop_id and id = any (p_picture_ids) and status = 'uploading'
    returning 1
  )
  select count(*)::integer from done
$$;

/**
 * Text of some pages of a PDF, as written (chunks made by doc-ingest): replaces whatever
 * those pages had. The document's language is the first one found.
 */
create or replace function public.docs_save_text(p_document_id uuid, p_chunks jsonb, p_lang text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc public.shop_documents;
  v_count integer;
begin
  select * into v_doc from public.shop_documents where id = p_document_id;
  if not found or v_doc.status <> 'processing' or v_doc.extracted then
    raise exception 'document' using errcode = 'P0001';
  end if;
  if v_doc.lang is null and p_lang ~ '^[a-z]{2}$' then
    update public.shop_documents set lang = p_lang where id = p_document_id;
    v_doc.lang := p_lang;
  end if;
  delete from public.shop_document_chunks
  where document_id = p_document_id and picture_id is null
    and page in (select (c ->> 'page')::integer from jsonb_array_elements(p_chunks) c);
  insert into public.shop_document_chunks (shop_id, folder_id, document_id, page, type, text, lang)
  select v_doc.shop_id, v_doc.folder_id, p_document_id, (c ->> 'page')::integer, 'text', left(c ->> 'text', 20000), v_doc.lang
  from jsonb_array_elements(p_chunks) c
  where (c ->> 'page')::integer between 1 and v_doc.pages and length(btrim(coalesce(c ->> 'text', ''))) > 0;
  get diagnostics v_count = row_count;
  update public.shop_documents set updated_at = now() where id = p_document_id;
  return v_count;
end;
$$;

/** The owner's browser has sent everything of the PDF. */
create or replace function public.docs_document_extracted(p_document_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with done as (
    update public.shop_documents set extracted = true, updated_at = now()
    where id = p_document_id and status = 'processing' and not extracted
    returning 1
  )
  select exists (select 1 from done)
$$;

/** The next pictures and scan pages for the AI (claimed so two runs never take the same one). */
create or replace function public.docs_claim_work(p_shop_id uuid, p_limit integer)
returns setof public.shop_pictures
language sql
volatile
security definer
set search_path = ''
as $$
  update public.shop_pictures p set status = 'working', attempts = p.attempts + 1, updated_at = now()
  where p.id in (
    select q.id from public.shop_pictures q
    where q.shop_id = p_shop_id and q.attempts < 3
      and (q.status = 'pending' or (q.status = 'working' and q.updated_at < now() - interval '10 minutes'))
    order by q.created_at
    limit greatest(coalesce(p_limit, 1), 1)
    for update skip locked
  )
  returning p.*
$$;

/**
 * What the AI saw: a picture's description (never over the owner's correction) or the
 * text of a scan page (document text of that page). p_error: the AI could not do it;
 * after 3 attempts the picture stays without (its title and caption still count).
 */
create or replace function public.docs_save_work(p_picture_id uuid, p_description text, p_chunks text[], p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pic public.shop_pictures;
begin
  select * into v_pic from public.shop_pictures where id = p_picture_id and status = 'working';
  if not found then
    return;
  end if;
  if p_error is not null then
    update public.shop_pictures
    set status = case when attempts >= 3 then 'error' else 'pending' end, error = left(p_error, 500), updated_at = now()
    where id = p_picture_id;
    if v_pic.attempts >= 3 then
      perform public.docs_picture_chunk(p_picture_id);
    end if;
    return;
  end if;
  if v_pic.kind = 'scan' then
    delete from public.shop_document_chunks where document_id = v_pic.document_id and picture_id is null and page = v_pic.page;
    insert into public.shop_document_chunks (shop_id, folder_id, document_id, page, type, text, lang)
    select v_pic.shop_id, v_pic.folder_id, v_pic.document_id, v_pic.page, 'text', left(t, 20000), v_pic.lang
    from unnest(coalesce(p_chunks, '{}'::text[])) t
    where length(btrim(t)) > 0;
  elsif not v_pic.description_by_owner then
    update public.shop_pictures set description = nullif(left(btrim(coalesce(p_description, '')), 2000), '')
    where id = p_picture_id;
  end if;
  update public.shop_pictures set status = 'ready', error = null, updated_at = now() where id = p_picture_id;
  perform public.docs_picture_chunk(p_picture_id);
end;
$$;

/**
 * Documents are ready when everything was sent and nothing waits for the AI (error when a
 * scanned page could not be read); an upload left unfinished for an hour is an error.
 * Returns how many pictures still wait for the AI.
 */
create or replace function public.docs_finish(p_shop_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.shop_pictures set status = 'error', error = 'Upload interrupted', updated_at = now()
  where shop_id = p_shop_id and status = 'uploading' and updated_at < now() - interval '1 hour';
  update public.shop_pictures set status = 'error', updated_at = now()
  where shop_id = p_shop_id and status = 'working' and attempts >= 3 and updated_at < now() - interval '10 minutes';
  update public.shop_documents
  set status = 'error', error = 'Upload interrupted: delete it and upload it again', updated_at = now()
  where shop_id = p_shop_id and not extracted and status in ('uploading', 'processing')
    and updated_at < now() - interval '1 hour';
  update public.shop_documents d
  set status = case when exists (select 1 from public.shop_pictures p
                                 where p.document_id = d.id and p.kind = 'scan' and p.status = 'error')
                    then 'error' else 'ready' end,
      error = case when exists (select 1 from public.shop_pictures p
                                where p.document_id = d.id and p.kind = 'scan' and p.status = 'error')
                   then 'Some scanned pages could not be read' end,
      updated_at = now()
  where d.shop_id = p_shop_id and d.status = 'processing' and d.extracted
    and not exists (select 1 from public.shop_pictures p where p.document_id = d.id
                    and p.status in ('uploading', 'pending', 'working'));
  return (select count(*)::integer from public.shop_pictures
          where shop_id = p_shop_id and status in ('pending', 'working') and attempts < 3);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'docs_register_document(uuid, uuid, text, text, integer, bigint, integer, integer)',
    'docs_register_pictures(uuid, uuid, uuid, jsonb, text, integer)',
    'docs_document_uploaded(uuid)', 'docs_pictures_uploaded(uuid, uuid[])',
    'docs_save_text(uuid, jsonb, text)', 'docs_document_extracted(uuid)',
    'docs_claim_work(uuid, integer)', 'docs_save_work(uuid, text, text[], text)', 'docs_finish(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ storage

/** Uploads into "shop-docs" only for a file the shop's owner registered and not yet uploaded. */
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
$$;
revoke execute on function public.shop_docs_upload_allowed(text) from public, anon;
grant execute on function public.shop_docs_upload_allowed(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('shop-docs', 'shop-docs', false, 20971520,
            array['application/pdf', 'image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do nothing;
    execute 'drop policy if exists "shop-docs: owners upload registered files" on storage.objects';
    execute $p$
      create policy "shop-docs: owners upload registered files" on storage.objects for insert to authenticated
      with check (bucket_id = 'shop-docs' and public.shop_docs_upload_allowed(name))$p$;
    -- No select, update or delete for anyone but the service role.
  end if;
end;
$$;

-- ------------------------------------------------------------------ shoppers: keys and sessions

/**
 * "I have an access key" in the shop's AI box. Checks the key (hash, expiry, revocation)
 * and, on success, opens its folders for 12 hours: returns a random session token whose
 * hash is stored. At most 5 wrong keys per caller per shop in 15 minutes (api_usage).
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
  v_expires timestamptz := now() + interval '12 hours';
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
  end if;
  v_token := public.docs_random(40);
  insert into public.folder_sessions (token_hash, shop_id, key_id, folder_ids, expires_at)
  values (public.docs_hash(v_token), v_shop, v_key.id, v_folders, v_expires);
  update public.folder_keys set last_used_at = now(), use_count = use_count + 1 where id = v_key.id;
  return jsonb_build_object(
    'status', 'ok', 'token', v_token, 'expires_at', v_expires,
    'folders', (select jsonb_agg(f.name order by f.name) from public.shop_folders f where f.id = any (v_folders)));
end;
$$;

/** "Lock again": the session is deleted. */
create or replace function public.lock_shop_folders(p_slug text, p_token text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.folder_sessions s
    using public.shops sh
    where sh.slug = p_slug and s.shop_id = sh.id and s.token_hash = public.docs_hash(p_token)
    returning 1
  )
  select exists (select 1 from gone)
$$;

/** Which private folders this token opens now (names only), for the AI box. */
create or replace function public.shop_folder_session(p_slug text, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when cardinality(v.folders) = 0 then null else jsonb_build_object(
    'folders', (select jsonb_agg(f.name order by f.name) from public.shop_folders f where f.id = any (v.folders)),
    'expires_at', (select s.expires_at from public.folder_sessions s where s.token_hash = public.docs_hash(p_token)))
  end
  from (select public.docs_session_folders(public.docs_shop(p_slug), p_token) as folders) v
$$;

revoke execute on function public.unlock_shop_folders(text, text, text) from public;
revoke execute on function public.lock_shop_folders(text, text) from public;
revoke execute on function public.shop_folder_session(text, text) from public;
grant execute on function public.unlock_shop_folders(text, text, text) to anon, authenticated, service_role;
grant execute on function public.lock_shop_folders(text, text) to anon, authenticated, service_role;
grant execute on function public.shop_folder_session(text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the assistant's search

/**
 * The only way the assistant reads documents: excerpts from the shop's Public folder plus
 * the folders a valid session token of this shop opens — never a list of folders from the
 * caller. Only documents with "Assistant may use it" and pictures with "Assistant may show
 * it" (and their document allowed), only for active shops with the paid plan. Words match
 * by their start (inflected forms) and by trigram similarity; an empty query lists the
 * first excerpt of each document and the pictures.
 */
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
  with allowed as (
    select c.*,
           -- the source a shopper is shown: the document (also for its pictures) or the picture's title
           coalesce(case when c.picture_id is null then d.name when p.document_id is not null then pd.name
                         else nullif(p.title, '') end, '') as src,
           f.name as folder_name, f.is_public as pub,
           coalesce(d.downloadable, false) as dl
    from public.shop_document_chunks c
    join public.shop_folders f on f.id = c.folder_id
    left join public.shop_documents d on d.id = c.document_id and c.picture_id is null
    left join public.shop_pictures p on p.id = c.picture_id
    left join public.shop_documents pd on pd.id = p.document_id
    where c.shop_id = v_shop
      and c.folder_id = any (v_folders)
      and (c.picture_id is null or (p.kind = 'picture' and p.show and p.status <> 'uploading'))
      and (case when c.picture_id is null then d.assistant_enabled else coalesce(pd.assistant_enabled, true) end)
  )
  select a.id, a.type, case when a.picture_id is null then a.document_id else p2.document_id end, a.picture_id,
         a.src, a.page, a.folder_name, a.pub, a.lang, left(a.text, 4000), a.dl,
         s.score::real
  from allowed a
  left join public.shop_pictures p2 on p2.id = a.picture_id
  cross join lateral (
    select case
      when v_q = '' then (case when a.type = 'picture' then 0.5 else 1.0 / greatest(coalesce(a.page, 1), 1) end)
      else greatest(
        case when v_tsquery is not null and a.search @@ v_tsquery then ts_rank_cd(a.search, v_tsquery) + 0.5 else 0 end,
        extensions.word_similarity(v_q, public.search_text(a.text)))
    end as score
  ) s
  where v_q = '' or (v_tsquery is not null and a.search @@ v_tsquery)
     or extensions.word_similarity(v_q, public.search_text(a.text)) >= 0.5
  order by s.score desc, a.page nulls last, a.id
  limit v_limit;
end;
$$;
revoke execute on function public.search_shop_docs(text, text, text, integer) from public;
grant execute on function public.search_shop_docs(text, text, text, integer) to anon, authenticated, service_role;

/** What the assistant may know exists: the documents a caller may see (names, pages, language). */
create or replace function public.shop_docs_list(p_slug text, p_session_token text)
returns table (name text, pages integer, lang text, folder text, is_public boolean, downloadable boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select d.name, d.pages, d.lang, f.name, f.is_public, d.downloadable
  from public.shop_documents d
  join public.shop_folders f on f.id = d.folder_id
  where d.shop_id = public.docs_shop(p_slug)
    and d.folder_id = any (public.docs_visible_folders(d.shop_id, p_session_token))
    and d.assistant_enabled
    and exists (select 1 from public.shop_document_chunks c where c.document_id = d.id)
  order by f.is_public desc, d.name
  limit 50
$$;
revoke execute on function public.shop_docs_list(text, text) from public;
grant execute on function public.shop_docs_list(text, text) to anon, authenticated, service_role;

/**
 * shop-files: the storage path of a file a shopper may open, or null. Pictures only with
 * "Assistant may show it" (and their document allowed), documents only with "Shoppers may
 * download it"; only in the Public folder or folders a valid session opens; only active
 * shops with the paid plan. Service role only (the function then signs a 10-minute URL).
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
      select d.storage_path from public.shop_documents d, shop, visible
      where d.id = p_id and d.shop_id = shop.id and d.folder_id = any (visible.folders)
        and d.downloadable and d.status <> 'uploading')
    when p_kind = 'picture' then (
      select p.storage_path from public.shop_pictures p
      left join public.shop_documents d on d.id = p.document_id, shop, visible
      where p.id = p_id and p.shop_id = shop.id and p.folder_id = any (visible.folders)
        and p.kind = 'picture' and p.show and p.status <> 'uploading' and coalesce(d.assistant_enabled, true))
  end
$$;
revoke execute on function public.shop_file_path(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.shop_file_path(text, text, uuid, text) to service_role;

-- ------------------------------------------------------------------ deleting a shop

-- A shop with documents or pictures cannot be deleted until they are deleted (their files
-- would otherwise stay in storage); a shop whose paid plan still renews neither.
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
  delete from public.shops where id = p_shop_id;
end;
$$;
revoke execute on function public.owner_delete_shop(uuid) from public, anon;
grant execute on function public.owner_delete_shop(uuid) to authenticated;
