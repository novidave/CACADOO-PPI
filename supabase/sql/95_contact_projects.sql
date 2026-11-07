-- PPI update 95: a verified customer's own project folder (2026-11-07, at the owner's request and with his OK for the
-- new SMS-verification path).
--
-- CRM → a contact → "Projekt" (only for a contact whose number was checked with an SMS code): the owner links a folder
-- on the shop's PC whose files go to the private bucket "contact-docs/<shop>/<contact>/", writes "Stav projektu" and
-- switches "Zákazník sa môže pýtať asistenta na svoj projekt" (default off). In the shop assistant the customer asks
-- about the project → the page's own form: the number → an SMS code → this conversation (only) may read that one
-- contact's status and file excerpts for 24 hours, or until the chat closes, "Nová konverzácia" or the page is left.
--
--   1. contact_projects / contact_project_docs / contact_project_chunks / contact_project_sessions (no grants)
--   2. the owner: owner_project, owner_project_save, owner_project_toggle, owner_project_link,
--      owner_project_synced, owner_project_remove_doc, owner_projects_detached, owner_project_purge
--   3. the owner checks a contact's number ("Poslať zákazníkovi overovací kód"): project_verify_code_start (service),
--      owner_contact_verify (the code the customer reads out)
--   4. the files (doc-ingest, service role): project_doc_register, project_doc_text, project_doc_delete,
--      project_delete
--   5. the customer: shop_has_projects, project_code_start (service; an unknown or not enabled number gets the SAME
--      answer and NO SMS), project_code_claim, project_unlock, search_contact_project, project_lock
--   6. "Vymazať moje údaje" / a deleted contact: the project is switched off and its sessions closed; the files stay
--      until the owner's "Odstrániť"
--
-- Never: a phone number, a code, a file name or a file's text in a log; a contact's files in pages, JSON-LD, sitemap,
-- llms.txt, the public API / MCP, the main AI search or another contact's conversation; the AI seeing a code, a phone
-- number or a session token. Safe to run again.

-- ------------------------------------------------------------------ 0. the code purposes, the activity log, the bucket

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.sms_codes'::regclass and c.conname = 'sms_codes_purpose_check');
begin
  if v_def is not null and position('''project''' in v_def) = 0 then
    alter table public.sms_codes drop constraint sms_codes_purpose_check;
    execute 'alter table public.sms_codes add constraint sms_codes_purpose_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''project''::text, ''verify''::text, ');
  end if;
end;
$$;

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
begin
  if v_def is not null and position('''project_saved''' in v_def) = 0 then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''project_saved''::text, ''project_enabled''::text, '
                                        '''project_disabled''::text, ''project_linked''::text, ''project_synced''::text, '
                                        '''project_doc_removed''::text, ''project_viewed''::text, ''project_removed''::text, '
                                        '''contact_verified''::text, ');
  end if;
end;
$$;

-- The private bucket: only the service role (doc-ingest) writes, reads or deletes; no storage policies.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('contact-docs', 'contact-docs', false, 20971520)
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
  end if;
end;
$$;

-- ------------------------------------------------------------------ 1. the tables

create table if not exists public.contact_projects (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  -- null after the contact was deleted ("Vymazať moje údaje" or the owner): the files wait for the owner's "Odstrániť"
  contact_id       uuid references public.shop_contacts (id) on delete set null,
  status_text      text check (status_text is null or char_length(status_text) <= 1000),
  enabled          boolean not null default false,
  folder_linked_at timestamptz,
  synced_at        timestamptz,
  files            integer not null default 0 check (files between 0 and 100000),
  forgotten_at     timestamptz,
  forgotten_reason text check (forgotten_reason is null or forgotten_reason in ('forget_all', 'contact_deleted')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists contact_projects_contact_key on public.contact_projects (contact_id) where contact_id is not null;
create index if not exists contact_projects_shop_idx on public.contact_projects (shop_id);

create table if not exists public.contact_project_docs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.contact_projects (id) on delete cascade,
  shop_id       uuid not null references public.shops (id) on delete cascade,
  kind          text not null check (kind in ('pdf', 'picture', 'text')),
  name          text not null check (char_length(name) between 1 and 255),
  hash          text not null check (hash ~ '^[0-9a-f]{64}$'),
  bytes         bigint not null check (bytes between 1 and 20971520),
  pages         integer not null default 0 check (pages between 0 and 5000),
  storage_path  text not null unique,
  status        text not null default 'uploading' check (status in ('uploading', 'ready', 'error')),
  missing_since timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists contact_project_docs_project_idx on public.contact_project_docs (project_id);

create table if not exists public.contact_project_chunks (
  id         bigint generated always as identity primary key,
  doc_id     uuid not null references public.contact_project_docs (id) on delete cascade,
  project_id uuid not null references public.contact_projects (id) on delete cascade,
  page       integer,
  text       text not null check (char_length(text) between 1 and 20000),
  search     tsvector generated always as (to_tsvector('simple'::regconfig, public.search_text(text))) stored
);
create index if not exists contact_project_chunks_project_idx on public.contact_project_chunks (project_id);
create index if not exists contact_project_chunks_search_idx on public.contact_project_chunks using gin (search);

create table if not exists public.contact_project_sessions (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.contact_projects (id) on delete cascade,
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  token_hash      text not null unique,
  expires_at      timestamptz not null,
  ended_at        timestamptz,
  viewed_at       timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists contact_project_sessions_project_idx on public.contact_project_sessions (project_id);

alter table public.contact_projects enable row level security;
alter table public.contact_project_docs enable row level security;
alter table public.contact_project_chunks enable row level security;
alter table public.contact_project_sessions enable row level security;
revoke all on public.contact_projects, public.contact_project_docs, public.contact_project_chunks,
              public.contact_project_sessions from public, anon, authenticated;
grant all on public.contact_projects, public.contact_project_docs, public.contact_project_chunks,
             public.contact_project_sessions to service_role;

/** Limits per contact: at most 200 files and 50 MB together. */
create or replace function public.project_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $$ select jsonb_build_object('files', 200, 'bytes', 52428800) $$;
grant execute on function public.project_limits() to authenticated, service_role;

-- ------------------------------------------------------------------ 2. the owner

/** The contact of a shop the caller is a member of (raises "Not your shop" otherwise). */
create or replace function public.project_member_contact(p_contact_id uuid)
returns public.shop_contacts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.shop_contacts;
begin
  select * into c from public.shop_contacts where id = p_contact_id;
  if not found or not public.is_shop_member(c.shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return c;
end;
$$;
revoke execute on function public.project_member_contact(uuid) from public, anon, authenticated;

/** A project as the owner's tab shows it (members; the plan only decides what may change). */
create or replace function public.project_json(p_project_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'contact_id', p.contact_id, 'status_text', p.status_text, 'enabled', p.enabled,
    'folder_linked_at', p.folder_linked_at, 'synced_at', p.synced_at, 'files', p.files,
    'forgotten_at', p.forgotten_at, 'forgotten_reason', p.forgotten_reason, 'updated_at', p.updated_at,
    'bytes', coalesce((select sum(d.bytes) from public.contact_project_docs d where d.project_id = p.id), 0),
    'docs', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', d.id, 'kind', d.kind, 'name', d.name, 'hash', d.hash, 'bytes', d.bytes, 'pages', d.pages,
                        'status', d.status, 'missing_since', d.missing_since, 'updated_at', d.updated_at)
                        order by d.name, d.created_at)
                      from public.contact_project_docs d where d.project_id = p.id), '[]'::jsonb),
    'sessions_open', (select count(*) from public.contact_project_sessions s
                      where s.project_id = p.id and s.ended_at is null and s.expires_at > now()))
  from public.contact_projects p
  where p.id = p_project_id
$$;
revoke execute on function public.project_json(uuid) from public, anon, authenticated;

/**
 * The "Projekt" tab: {verified, phone_masked, plan, limits, project (or null)}. Members only (reading needs no plan).
 */
create or replace function public.owner_project(p_contact_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.shop_contacts := public.project_member_contact(p_contact_id);
  v_project uuid;
begin
  select id into v_project from public.contact_projects where contact_id = c.id;
  return jsonb_build_object(
    'contact_id', c.id, 'shop_id', c.shop_id, 'has_phone', c.phone is not null,
    'verified', c.phone is not null and c.phone_verified_at is not null,
    'phone_masked', public.crm_phone_masked(c.phone, (select country from public.shops where id = c.shop_id)),
    'plan', public.shop_has_plan(c.shop_id), 'limits', public.project_limits(),
    'project', case when v_project is null then null else public.project_json(v_project) end);
end;
$$;
revoke execute on function public.owner_project(uuid) from public, anon;
grant execute on function public.owner_project(uuid) to authenticated;

/** The contact's project, made when missing — only for a verified number (raises not_verified). Members + plan. */
create or replace function public.project_for_owner(p_contact_id uuid)
returns public.contact_projects
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.shop_contacts := public.project_member_contact(p_contact_id);
  p public.contact_projects;
begin
  perform public.crm_owner_check(c.shop_id);
  select * into p from public.contact_projects where contact_id = c.id for update;
  if found then return p; end if;
  if c.phone is null or c.phone_verified_at is null then raise exception 'not_verified' using errcode = 'P0001'; end if;
  insert into public.contact_projects (shop_id, contact_id) values (c.shop_id, c.id) returning * into p;
  return p;
end;
$$;
revoke execute on function public.project_for_owner(uuid) from public, anon, authenticated;

/** "Stav projektu" (plain text, ≤ 1000; empty clears). Members + plan, a verified contact. */
create or replace function public.owner_project_save(p_contact_id uuid, p_status_text text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.contact_projects := public.project_for_owner(p_contact_id);
  v_text text := public.plain_text(p_status_text, 1000);
begin
  if p_status_text is not null and char_length(btrim(p_status_text)) > 1000 then
    raise exception 'status_text' using errcode = '22023';
  end if;
  if v_text is distinct from p.status_text then
    update public.contact_projects set status_text = v_text, updated_at = now() where id = p.id;
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p.shop_id, auth.uid(), 'project_saved', jsonb_build_object('contact', p.contact_id));
  end if;
  return public.owner_project(p_contact_id);
end;
$$;
revoke execute on function public.owner_project_save(uuid, text) from public, anon;
grant execute on function public.owner_project_save(uuid, text) to authenticated;

/**
 * "Zákazník sa môže pýtať asistenta na svoj projekt". On only for a verified contact; off closes every open session
 * at once. Members + plan.
 */
create or replace function public.owner_project_toggle(p_contact_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.contact_projects := public.project_for_owner(p_contact_id);
begin
  if coalesce(p_enabled, false) is distinct from p.enabled then
    update public.contact_projects set enabled = coalesce(p_enabled, false), updated_at = now() where id = p.id;
    if not coalesce(p_enabled, false) then
      update public.contact_project_sessions set ended_at = now() where project_id = p.id and ended_at is null;
    end if;
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p.shop_id, auth.uid(), case when p_enabled then 'project_enabled' else 'project_disabled' end,
            jsonb_build_object('contact', p.contact_id));
  end if;
  return public.owner_project(p_contact_id);
end;
$$;
revoke execute on function public.owner_project_toggle(uuid, boolean) from public, anon;
grant execute on function public.owner_project_toggle(uuid, boolean) to authenticated;

/** "Prepojiť priečinok na počítači" / "Odpojiť priečinok" (only the link: the files stay). Members + plan. */
create or replace function public.owner_project_link(p_contact_id uuid, p_linked boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.contact_projects := public.project_for_owner(p_contact_id);
begin
  if coalesce(p_linked, false) <> (p.folder_linked_at is not null) then
    update public.contact_projects
    set folder_linked_at = case when p_linked then now() end,
        synced_at = case when p_linked then synced_at end, updated_at = now()
    where id = p.id;
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p.shop_id, auth.uid(), 'project_linked', jsonb_build_object('contact', p.contact_id, 'linked', coalesce(p_linked, false)));
  end if;
  return public.owner_project(p_contact_id);
end;
$$;
revoke execute on function public.owner_project_link(uuid, boolean) from public, anon;
grant execute on function public.owner_project_link(uuid, boolean) to authenticated;

/**
 * After a check of the PC folder: the files there now (names), how many. A file of the project no longer there gets
 * missing_since (shown "Chýba v priečinku"), back = cleared. Logged only when something changed. Members + plan.
 */
create or replace function public.owner_project_synced(p_contact_id uuid, p_present text[], p_files integer, p_changed integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.contact_projects := public.project_for_owner(p_contact_id);
  v_missing integer;
begin
  if p.folder_linked_at is null then raise exception 'not_linked' using errcode = 'P0001'; end if;
  update public.contact_project_docs set missing_since = null, updated_at = now()
  where project_id = p.id and missing_since is not null and name = any (coalesce(p_present, '{}'));
  update public.contact_project_docs set missing_since = now(), updated_at = now()
  where project_id = p.id and missing_since is null and not (name = any (coalesce(p_present, '{}')));
  get diagnostics v_missing = row_count;
  update public.contact_projects
  set synced_at = now(), files = least(greatest(coalesce(p_files, 0), 0), 100000), updated_at = now()
  where id = p.id;
  if coalesce(p_changed, 0) > 0 or v_missing > 0 then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p.shop_id, auth.uid(), 'project_synced',
            jsonb_build_object('contact', p.contact_id, 'changed', least(greatest(coalesce(p_changed, 0), 0), 100000),
                               'missing', v_missing));
  end if;
  return public.owner_project(p_contact_id);
end;
$$;
revoke execute on function public.owner_project_synced(uuid, text[], integer, integer) from public, anon;
grant execute on function public.owner_project_synced(uuid, text[], integer, integer) to authenticated;

/**
 * "Odstrániť" a file (after the owner's confirmation) or a replaced one: members (no plan needed to delete). Returns
 * {path} for doc-ingest, which deletes the stored file first and then the row (project_doc_delete). Reason owner |
 * replaced; logged with the count only, never the name.
 */
create or replace function public.owner_project_remove_doc(p_doc_id uuid, p_reason text default 'owner')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.contact_project_docs;
begin
  select * into d from public.contact_project_docs where id = p_doc_id;
  if not found or not public.is_shop_member(d.shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (d.shop_id, auth.uid(), 'project_doc_removed',
          jsonb_build_object('project', d.project_id, 'count', 1,
                             'reason', case when p_reason = 'replaced' then 'replaced' else 'owner' end));
  return jsonb_build_object('path', d.storage_path, 'project_id', d.project_id);
end;
$$;
revoke execute on function public.owner_project_remove_doc(uuid, text) from public, anon;
grant execute on function public.owner_project_remove_doc(uuid, text) to authenticated;

/** CRM → Kontakty: the projects whose contact was deleted (the customer's "Vymazať moje údaje" or the owner). Members. */
create or replace function public.owner_projects_detached(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
                     'id', p.id, 'forgotten_at', p.forgotten_at, 'forgotten_reason', p.forgotten_reason,
                     'created_at', p.created_at,
                     'files', (select count(*) from public.contact_project_docs d where d.project_id = p.id),
                     'bytes', coalesce((select sum(d.bytes) from public.contact_project_docs d where d.project_id = p.id), 0))
                     order by p.forgotten_at desc nulls last)
                   from public.contact_projects p where p.shop_id = p_shop_id and p.contact_id is null), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_projects_detached(uuid) from public, anon;
grant execute on function public.owner_projects_detached(uuid) to authenticated;

/**
 * "Odstrániť projekt" (a detached project, after the owner's confirmation): members. Returns {paths} for doc-ingest,
 * which deletes the stored files first and then the project (project_delete).
 */
create or replace function public.owner_project_purge(p_project_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.contact_projects;
begin
  select * into p from public.contact_projects where id = p_project_id;
  if not found or not public.is_shop_member(p.shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  if p.contact_id is not null then raise exception 'not_detached' using errcode = 'P0001'; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p.shop_id, auth.uid(), 'project_removed',
          jsonb_build_object('project', p.id,
                             'count', (select count(*) from public.contact_project_docs d where d.project_id = p.id)));
  return jsonb_build_object('paths', coalesce((select jsonb_agg(d.storage_path) from public.contact_project_docs d
                                               where d.project_id = p.id), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_project_purge(uuid) from public, anon;
grant execute on function public.owner_project_purge(uuid) to authenticated;

-- ------------------------------------------------------------------ 3. the owner checks a contact's number

/**
 * "Poslať zákazníkovi overovací kód" (bookings function, the owner's login checked there AND here): a code to the
 * contact's number (purpose verify, update 63's limits, the owner quota). The code goes only into the SMS; the owner
 * types what the customer reads out (owner_contact_verify). Refusals: Not your shop, no_plan, phone, too_many,
 * sms_failed, sms_quota. Service role only.
 */
create or replace function public.project_verify_code_start(p_contact_id uuid, p_user_id uuid, p_caller_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.shop_contacts;
  sh public.shops;
  v_hash text;
  v_code text := public.booking_new_code();
  v_id uuid := gen_random_uuid();
begin
  select * into c from public.shop_contacts where id = p_contact_id;
  if not found or p_user_id is null
     or not exists (select 1 from public.shop_members m where m.shop_id = c.shop_id and m.user_id = p_user_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.shop_has_plan(c.shop_id) then raise exception 'no_plan' using errcode = 'P0001'; end if;
  if c.phone is null then raise exception 'phone' using errcode = '22023'; end if;
  if p_caller_hash is null or length(p_caller_hash) < 16 then raise exception 'Invalid caller hash' using errcode = '22023'; end if;
  select * into sh from public.shops where id = c.shop_id;
  v_hash := public.booking_hash(c.phone);
  perform pg_advisory_xact_lock(hashtextextended('ppi-sms-code:' || v_hash, 0));
  if public.sms_codes_counted(v_hash, null) >= 3 or public.sms_codes_counted(null, p_caller_hash) >= 10 then
    raise exception '%', case when public.sms_code_last_failed(v_hash) then 'sms_failed' else 'too_many' end using errcode = '54000';
  end if;
  if public.sms_quota_left(c.shop_id, 'owner') < 1 then raise exception 'sms_quota' using errcode = '54000'; end if;
  insert into public.sms_codes (id, shop_id, purpose, phone_hash, phone, code_hash, caller_hash, expires_at)
  values (v_id, c.shop_id, 'verify', v_hash, c.phone, public.booking_hash(v_id::text || ':' || v_code), p_caller_hash,
          now() + interval '10 minutes');
  return jsonb_build_object('id', v_id, 'send', true, 'code', v_code, 'phone', c.phone, 'shop_name', sh.name,
                            'expires_at', now() + interval '10 minutes');
end;
$$;
revoke execute on function public.project_verify_code_start(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.project_verify_code_start(uuid, uuid, text) to service_role;

/**
 * The SMS of a project or verify code into the message log (kind phone_code, the code masked) and its parts of the
 * OWNER quota; the code keeps its message's id (a failed SMS does not count, update 85). Service role only.
 */
create or replace function public.project_code_claim(p_code_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.sms_codes%rowtype;
  v_parts integer := public.crm_sms_parts(left(p_body, 480));
  v_id uuid;
begin
  select * into v from public.sms_codes where id = p_code_id and purpose in ('project', 'verify');
  if not found or v.phone is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.sms_quota_take(v.shop_id, 'owner', v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, parts)
  values (v.shop_id, (select id from public.shop_contacts where shop_id = v.shop_id and phone = v.phone), 'sms', v.phone,
          regexp_replace(left(p_body, 480), '\d{6}', '••••••', 'g'), 'queued', 'phone_code', v_parts)
  returning id into v_id;
  update public.sms_codes set message_id = v_id where id = p_code_id;
  return v_id;
end;
$$;
revoke execute on function public.project_code_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.project_code_claim(uuid, text) to service_role;

/**
 * The code the customer read out → the contact's number is checked (phone_verified_at; the one other place besides
 * update 63's codes). {ok: false, reason: not_found | expired | too_many_attempts | wrong_code, attempts_left} or
 * {ok: true}. Members of the code's shop.
 */
create or replace function public.owner_contact_verify(p_contact_id uuid, p_code_id uuid, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.shop_contacts := public.project_member_contact(p_contact_id);
  v public.sms_codes%rowtype;
begin
  select * into v from public.sms_codes where id = p_code_id and purpose = 'verify' and shop_id = c.shop_id for update;
  if not found or v.used_at is not null or v.code_hash is null or v.phone is distinct from c.phone then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  if public.booking_hash(v.id::text || ':' || btrim(coalesce(p_code, ''))) is distinct from v.code_hash then
    update public.sms_codes set attempts = attempts + 1 where id = p_code_id returning * into v;
    if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 5 - v.attempts);
  end if;
  update public.sms_codes set verified_at = now(), used_at = now(), code_hash = null, phone = null where id = p_code_id;
  update public.shop_contacts set phone_verified_at = now(), updated_at = now() where id = c.id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (c.shop_id, auth.uid(), 'contact_verified', jsonb_build_object('contact', c.id));
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.owner_contact_verify(uuid, uuid, text) from public, anon;
grant execute on function public.owner_contact_verify(uuid, uuid, text) to authenticated;

-- ------------------------------------------------------------------ 4. the files (doc-ingest, service role)

/**
 * A file of the PC folder to store: the caller (p_user_id, checked by doc-ingest with the caller's own login too) is
 * a member, the shop has the plan, the contact's project exists. ≤ 200 files and 50 MB per contact (a replaced file
 * counts until it is deleted). Returns {doc_id, path}. Refusals: Not your shop, no_plan, no_project, limit_files,
 * limit_bytes, kind, name, hash. Service role only.
 */
create or replace function public.project_doc_register(p_contact_id uuid, p_user_id uuid, p_kind text, p_name text,
                                                       p_hash text, p_bytes bigint, p_pages integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.shop_contacts;
  p public.contact_projects;
  v_id uuid := gen_random_uuid();
  v_ext text := case p_kind when 'pdf' then 'pdf' when 'text' then 'txt' else 'jpg' end;
  v_path text;
begin
  select * into c from public.shop_contacts where id = p_contact_id;
  if not found or p_user_id is null
     or not exists (select 1 from public.shop_members m where m.shop_id = c.shop_id and m.user_id = p_user_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.shop_has_plan(c.shop_id) then raise exception 'no_plan' using errcode = 'P0001'; end if;
  select * into p from public.contact_projects where contact_id = c.id for update;
  if not found or p.folder_linked_at is null then raise exception 'no_project' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('pdf', 'picture', 'text') then raise exception 'kind' using errcode = '22023'; end if;
  if p_name is null or char_length(p_name) not between 1 and 255 or p_name ~ '[/\\[:cntrl:]]' then
    raise exception 'name' using errcode = '22023';
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'hash' using errcode = '22023'; end if;
  if p_bytes is null or p_bytes < 1 or p_bytes > 20971520 then raise exception 'limit_bytes' using errcode = 'P0001'; end if;
  if (select count(*) from public.contact_project_docs where project_id = p.id) >= (public.project_limits() ->> 'files')::integer then
    raise exception 'limit_files' using errcode = 'P0001';
  end if;
  if coalesce((select sum(bytes) from public.contact_project_docs where project_id = p.id), 0) + p_bytes
     > (public.project_limits() ->> 'bytes')::bigint then
    raise exception 'limit_bytes' using errcode = 'P0001';
  end if;
  v_path := c.shop_id::text || '/' || c.id::text || '/' || v_id::text || '.' || v_ext;
  insert into public.contact_project_docs (id, project_id, shop_id, kind, name, hash, bytes, pages, storage_path)
  values (v_id, p.id, c.shop_id, p_kind, p_name, p_hash, p_bytes, least(greatest(coalesce(p_pages, 0), 0), 5000), v_path);
  return jsonb_build_object('doc_id', v_id, 'path', v_path, 'project_id', p.id);
end;
$$;
revoke execute on function public.project_doc_register(uuid, uuid, text, text, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.project_doc_register(uuid, uuid, text, text, text, bigint, integer) to service_role;

/** The stored file's text as excerpts ([{page, text}], as written) → ready. Once per file. Service role only. */
create or replace function public.project_doc_text(p_doc_id uuid, p_chunks jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.contact_project_docs;
  v_count integer;
begin
  select * into d from public.contact_project_docs where id = p_doc_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if d.status <> 'uploading' then raise exception 'done' using errcode = 'P0001'; end if;
  insert into public.contact_project_chunks (doc_id, project_id, page, text)
  select d.id, d.project_id, nullif((x ->> 'page'), '')::integer, left(x ->> 'text', 20000)
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) x
  where btrim(coalesce(x ->> 'text', '')) <> '';
  get diagnostics v_count = row_count;
  update public.contact_project_docs set status = 'ready', updated_at = now() where id = d.id;
  update public.contact_projects set updated_at = now() where id = d.project_id;
  return v_count;
end;
$$;
revoke execute on function public.project_doc_text(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.project_doc_text(uuid, jsonb) to service_role;

/** The row of a file whose stored file doc-ingest already deleted (its excerpts go with it). Service role only. */
create or replace function public.project_doc_delete(p_doc_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (delete from public.contact_project_docs where id = p_doc_id returning 1)
  select exists (select 1 from gone)
$$;
revoke execute on function public.project_doc_delete(uuid) from public, anon, authenticated;
grant execute on function public.project_doc_delete(uuid) to service_role;

/** A detached project whose files doc-ingest already deleted. Service role only. */
create or replace function public.project_delete(p_project_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (delete from public.contact_projects where id = p_project_id and contact_id is null returning 1)
  select exists (select 1 from gone)
$$;
revoke execute on function public.project_delete(uuid) from public, anon, authenticated;
grant execute on function public.project_delete(uuid) to service_role;

-- ------------------------------------------------------------------ 5. the customer

/** Whether the shop's assistant offers my_project: an active shop with the plan and one enabled, verified project. */
create or replace function public.shop_has_projects(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.shops sh
    join public.contact_projects p on p.shop_id = sh.id and p.enabled
    join public.shop_contacts c on c.id = p.contact_id and c.phone_verified_at is not null
    where sh.slug = p_slug and sh.is_active and public.shop_has_plan(sh.id))
$$;
revoke execute on function public.shop_has_projects(text) from public;
grant execute on function public.shop_has_projects(text) to anon, authenticated, service_role;

/**
 * The customer's number on the assistant's project form → a code (the bookings function sends it). Only a contact of
 * this shop with a checked number and an enabled project gets an SMS; any other number gets the SAME answer, a row
 * that can never be right and no SMS (send: false). The conversation must be the caller's own (its token). Limits as
 * update 63/85 (3 per number, 10 per caller an hour); the owner quota. Refusals: not_available, phone, conversation,
 * too_many, sms_failed, sms_quota. Service role only.
 */
create or replace function public.project_code_start(p_slug text, p_phone text, p_caller_hash text,
                                                     p_conversation_id uuid, p_conversation_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  sh public.shops;
  v_phone text;
  v_hash text;
  v_conv uuid;
  v_ok boolean;
  v_code text := public.booking_new_code();
  v_id uuid := gen_random_uuid();
begin
  select * into sh from public.shops where slug = p_slug and is_active;
  if not found or not public.shop_has_plan(sh.id) then raise exception 'not_available' using errcode = 'P0001'; end if;
  v_phone := public.crm_phone(p_phone, sh.country);
  if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  if p_caller_hash is null or length(p_caller_hash) < 16 then raise exception 'Invalid caller hash' using errcode = '22023'; end if;
  select c.id into v_conv from public.assistant_conversations c
  where c.id = p_conversation_id and c.shop_id = sh.id and c.token_hash = public.assistant_token_hash(p_conversation_token);
  if v_conv is null then raise exception 'conversation' using errcode = '22023'; end if;
  v_hash := public.booking_hash(v_phone);
  perform pg_advisory_xact_lock(hashtextextended('ppi-sms-code:' || v_hash, 0));
  if public.sms_codes_counted(v_hash, null) >= 3 or public.sms_codes_counted(null, p_caller_hash) >= 10 then
    raise exception '%', case when public.sms_code_last_failed(v_hash) then 'sms_failed' else 'too_many' end using errcode = '54000';
  end if;
  if public.sms_quota_left(sh.id, 'owner') < 1 then raise exception 'sms_quota' using errcode = '54000'; end if;
  v_ok := exists (select 1 from public.shop_contacts c
                  join public.contact_projects p on p.contact_id = c.id and p.enabled
                  where c.shop_id = sh.id and c.phone = v_phone and c.phone_verified_at is not null);
  if not v_ok then
    -- the same answer for any other number: a row that counts for the limits but can never be right
    insert into public.sms_codes (id, shop_id, purpose, phone_hash, caller_hash, conversation_id, expires_at)
    values (v_id, sh.id, 'project', v_hash, p_caller_hash, v_conv, now() + interval '10 minutes');
    return jsonb_build_object('id', v_id, 'send', false, 'phone', v_phone, 'shop_name', sh.name,
                              'expires_at', now() + interval '10 minutes');
  end if;
  insert into public.sms_codes (id, shop_id, purpose, phone_hash, phone, code_hash, caller_hash, conversation_id, expires_at)
  values (v_id, sh.id, 'project', v_hash, v_phone, public.booking_hash(v_id::text || ':' || v_code), p_caller_hash, v_conv,
          now() + interval '10 minutes');
  return jsonb_build_object('id', v_id, 'send', true, 'code', v_code, 'phone', v_phone, 'shop_name', sh.name,
                            'expires_at', now() + interval '10 minutes');
end;
$$;
revoke execute on function public.project_code_start(text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.project_code_start(text, text, text, uuid, text) to service_role;

/**
 * The code on the assistant's project form → a session for THIS conversation (24 h; its token returned once, the
 * database keeps the hash) and the conversation linked to the contact. Checked again: the contact's number still
 * checked, the project enabled, the plan. {ok: false, reason} or {ok: true, token, expires_at}. anon may call it (the
 * website keeps the token in its signed HttpOnly cookie; the AI never sees it).
 */
create or replace function public.project_unlock(p_code_id uuid, p_code text, p_conversation_id uuid, p_conversation_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.sms_codes%rowtype;
  c public.shop_contacts;
  p public.contact_projects;
  v_token text := public.mcp_random('cps_');
  v_expires timestamptz := now() + interval '24 hours';
begin
  select * into v from public.sms_codes where id = p_code_id and purpose = 'project' for update;
  if not found or v.used_at is not null or v.conversation_id is distinct from p_conversation_id
     or not exists (select 1 from public.assistant_conversations a where a.id = p_conversation_id
                    and a.token_hash = public.assistant_token_hash(p_conversation_token)) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  if v.code_hash is null
     or public.booking_hash(v.id::text || ':' || btrim(coalesce(p_code, ''))) is distinct from v.code_hash then
    update public.sms_codes set attempts = attempts + 1 where id = p_code_id returning * into v;
    if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 5 - v.attempts);
  end if;
  select * into c from public.shop_contacts where shop_id = v.shop_id and phone = v.phone and phone_verified_at is not null;
  select * into p from public.contact_projects where contact_id = c.id and enabled;
  update public.sms_codes set verified_at = now(), used_at = now(), code_hash = null, phone = null where id = p_code_id;
  if c.id is null or p.id is null or not public.shop_has_plan(v.shop_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  -- one open session per conversation
  update public.contact_project_sessions set ended_at = now() where conversation_id = p_conversation_id and ended_at is null;
  insert into public.contact_project_sessions (project_id, conversation_id, token_hash, expires_at)
  values (p.id, p_conversation_id, public.booking_hash(v_token), v_expires);
  update public.assistant_conversations
  set contact_id = c.id, shopper_phone = c.phone, contact_verified_at = now()
  where id = p_conversation_id;
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires);
end;
$$;
revoke execute on function public.project_unlock(uuid, text, uuid, text) from public;
grant execute on function public.project_unlock(uuid, text, uuid, text) to anon, authenticated, service_role;

/** The open session of a token in this conversation (not ended, not expired, project enabled, plan), or null. */
create or replace function public.project_session_of(p_token text, p_conversation_id uuid)
returns public.contact_project_sessions
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
  from public.contact_project_sessions s
  join public.contact_projects p on p.id = s.project_id and p.enabled and p.contact_id is not null
  join public.shop_contacts c on c.id = p.contact_id and c.phone_verified_at is not null
  where s.token_hash = public.booking_hash(coalesce(p_token, ''))
    and s.conversation_id = p_conversation_id
    and s.ended_at is null and s.expires_at > now()
    and public.shop_has_plan(p.shop_id)
$$;
revoke execute on function public.project_session_of(text, uuid) from public, anon, authenticated;

/**
 * my_project: {ok: false} without an open session; else {ok: true, status, excerpts: [{source, page, text}]} of THAT
 * contact's project only — never takes a contact or project id. The first read of a session is logged
 * (project_viewed, never the question). anon may call it (the website passes the cookie's token).
 */
create or replace function public.search_contact_project(p_token text, p_conversation_id uuid, p_query text, p_limit integer default 6)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.contact_project_sessions := public.project_session_of(p_token, p_conversation_id);
  p public.contact_projects;
  v_q text := btrim(public.search_text(left(coalesce(p_query, ''), 300)));
  v_tsquery tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 6), 1), 10);
begin
  if s.id is null then return jsonb_build_object('ok', false); end if;
  select * into p from public.contact_projects where id = s.project_id;
  if s.viewed_at is null then
    update public.contact_project_sessions set viewed_at = now() where id = s.id;
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p.shop_id, null, 'project_viewed', jsonb_build_object('contact', p.contact_id));
  end if;
  if v_q <> '' then
    select to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' | ')) into v_tsquery
    from (
      select distinct case when length(w) <= 4 then w else left(w, greatest(4, length(w) - 2)) end as w
      from regexp_split_to_table(regexp_replace(v_q, '[^a-z0-9]+', ' ', 'g'), '\s+') as w
      where length(w) >= 2
      limit 12
    ) words;
  end if;
  return jsonb_build_object(
    'ok', true, 'status', p.status_text, 'updated_at', p.updated_at,
    'files', (select count(*) from public.contact_project_docs d where d.project_id = p.id and d.status = 'ready'),
    'excerpts', coalesce((
      select jsonb_agg(jsonb_build_object('source', x.name, 'page', x.page, 'text', left(x.text, 3000)) order by x.score desc)
      from (
        select d.name, ch.page, ch.text,
               case when v_q = '' then 1.0 / greatest(coalesce(ch.page, 1), 1)
                    else greatest(case when v_tsquery is not null and ch.search @@ v_tsquery
                                       then ts_rank_cd(ch.search, v_tsquery) + 0.5 else 0 end,
                                  extensions.word_similarity(v_q, public.search_text(ch.text))) end as score
        from public.contact_project_chunks ch
        join public.contact_project_docs d on d.id = ch.doc_id and d.status = 'ready'
        where ch.project_id = p.id
          and (v_q = '' or (v_tsquery is not null and ch.search @@ v_tsquery)
               or extensions.word_similarity(v_q, public.search_text(ch.text)) >= 0.5)
        order by 4 desc, ch.page nulls last, ch.id
        limit v_limit
      ) x), '[]'::jsonb));
end;
$$;
revoke execute on function public.search_contact_project(text, uuid, text, integer) from public;
grant execute on function public.search_contact_project(text, uuid, text, integer) to anon, authenticated, service_role;

/** Ends a project session (the chat closes, "Nová konverzácia", the page is left). anon may call it. */
create or replace function public.project_lock(p_token text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with ended as (
    update public.contact_project_sessions set ended_at = now()
    where token_hash = public.booking_hash(coalesce(p_token, '')) and ended_at is null
    returning 1)
  select exists (select 1 from ended)
$$;
revoke execute on function public.project_lock(text) from public;
grant execute on function public.project_lock(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 6. a deleted contact

/**
 * Before a contact is deleted ("Vymazať moje údaje" → shopper_forget_all_finish, or the owner's delete): its project is
 * switched off, its sessions closed and it is marked (forget_all when a delete_all code of that number was checked in
 * the last 15 minutes, else contact_deleted); then the foreign key sets contact_id null. The files stay until the
 * owner's "Odstrániť".
 */
create or replace function public.contact_projects_forget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.contact_project_sessions s set ended_at = now()
  from public.contact_projects p
  where p.contact_id = old.id and s.project_id = p.id and s.ended_at is null;
  update public.contact_projects
  set enabled = false, forgotten_at = now(), updated_at = now(),
      forgotten_reason = case when old.phone is not null and exists (
                           select 1 from public.sms_codes k
                           where k.purpose = 'delete_all' and k.shop_id = old.shop_id
                             and k.phone_hash = public.booking_hash(old.phone)
                             and k.verified_at > now() - interval '15 minutes') then 'forget_all'
                         else 'contact_deleted' end
  where contact_id = old.id;
  return old;
end;
$$;
revoke execute on function public.contact_projects_forget() from public, anon, authenticated;
drop trigger if exists contact_projects_forget on public.shop_contacts;
create trigger contact_projects_forget before delete on public.shop_contacts
  for each row execute function public.contact_projects_forget();

/** A changed number is no longer checked (update 56): the project's sessions end with it. */
create or replace function public.contact_projects_phone_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.phone is distinct from new.phone or (old.phone_verified_at is not null and new.phone_verified_at is null) then
    update public.contact_project_sessions s set ended_at = now()
    from public.contact_projects p
    where p.contact_id = new.id and s.project_id = p.id and s.ended_at is null;
  end if;
  return new;
end;
$$;
revoke execute on function public.contact_projects_phone_changed() from public, anon, authenticated;
drop trigger if exists contact_projects_phone_changed on public.shop_contacts;
create trigger contact_projects_phone_changed after update of phone, phone_verified_at on public.shop_contacts
  for each row execute function public.contact_projects_phone_changed();
