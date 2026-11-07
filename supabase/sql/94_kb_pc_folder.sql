-- PPI · database update 94 — the assistant's documents from a folder on the shop's PC (2026-11-07, at the owner's
-- request: "Knowledge base from PC folders", phase A). Paid (shop_has_plan).
--
-- AI asistent → Dokumenty: each documents folder (Public and private) can be linked to a folder on the shop's PC. The
-- owner's browser (Edge / Chrome, File System Access, read only) checks that folder every 15 minutes, on start and on
-- "Skontrolovať teraz", and sends new or changed files through the usual upload (doc-ingest). A changed file replaces
-- its own document (the same file name in that folder); a file gone from the PC is marked "Chýba v priečinku" and
-- stays until the owner removes it — or, with the switch "Odstrániť z asistenta aj súbory zmazané v priečinku" (off by
-- default, asked before it is switched on), the browser removes it on the next check.
--
--   shop_folders.pc_linked_at / pc_synced_at / pc_files / pc_remove_missing
--   shop_documents / shop_pictures.source ('upload' | 'pc_folder'), source_name, source_hash, missing_since
--   owner_kb_folder_link(folder, linked)            members + plan; activity kb_folder_linked {folder_id, linked}
--   owner_kb_folder_settings(folder, remove_missing) members + plan
--   owner_kb_folder_files(folder)                    members: the folder's PC files (kind, id, name, hash, missing)
--   owner_kb_mark_source(kind, id, name, hash)       members + plan: a just-uploaded document / picture came from the PC
--   owner_kb_folder_synced(folder, present, files, changed)  members + plan: missing_since for the PC files no longer
--                                                    there, cleared for those that are; activity kb_folder_synced only
--                                                    when something changed
--   owner_kb_removed(folder, count, reason)          members + plan: activity kb_doc_removed (no file names)
-- A file name or a file's text is never written to the activity log. Nothing is deleted by this file.

alter table public.shop_folders add column if not exists pc_linked_at timestamptz;
alter table public.shop_folders add column if not exists pc_synced_at timestamptz;
alter table public.shop_folders add column if not exists pc_files integer;
alter table public.shop_folders add column if not exists pc_remove_missing boolean not null default false;

alter table public.shop_documents add column if not exists source text not null default 'upload';
alter table public.shop_documents add column if not exists source_name text;
alter table public.shop_documents add column if not exists source_hash text;
alter table public.shop_documents add column if not exists missing_since timestamptz;
alter table public.shop_pictures add column if not exists source text not null default 'upload';
alter table public.shop_pictures add column if not exists source_name text;
alter table public.shop_pictures add column if not exists source_hash text;
alter table public.shop_pictures add column if not exists missing_since timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_documents_source_check') then
    alter table public.shop_documents add constraint shop_documents_source_check
      check (source in ('upload', 'pc_folder') and (source_name is null or length(source_name) between 1 and 255)
             and (source_hash is null or source_hash ~ '^[0-9a-f]{64}$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_pictures_source_check') then
    alter table public.shop_pictures add constraint shop_pictures_source_check
      check (source in ('upload', 'pc_folder') and (source_name is null or length(source_name) between 1 and 255)
             and (source_hash is null or source_hash ~ '^[0-9a-f]{64}$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_folders_pc_files_check') then
    alter table public.shop_folders add constraint shop_folders_pc_files_check check (pc_files is null or pc_files between 0 and 100000);
  end if;
end;
$$;
create index if not exists shop_documents_pc_idx on public.shop_documents (folder_id) where source = 'pc_folder';
create index if not exists shop_pictures_pc_idx on public.shop_pictures (folder_id) where source = 'pc_folder';

-- the activity log: the new actions
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
begin
  if v_def is not null and position('''kb_folder_linked''' in v_def) = 0 then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''kb_folder_linked''::text, ''kb_folder_synced''::text, ''kb_doc_removed''::text, ');
  end if;
end;
$$;

/** The folder of a shop the caller is a member of (raises "Not your shop" otherwise). */
create or replace function public.kb_member_folder(p_folder_id uuid)
returns public.shop_folders
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_folder public.shop_folders;
begin
  select * into v_folder from public.shop_folders where id = p_folder_id;
  if v_folder.id is null or not public.is_shop_member(v_folder.shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return v_folder;
end;
$$;
revoke execute on function public.kb_member_folder(uuid) from public, anon;
grant execute on function public.kb_member_folder(uuid) to authenticated, service_role;

/** "Prepojiť priečinok na počítači" / "Odpojiť priečinok": only the link changes; documents stay. */
create or replace function public.owner_kb_folder_link(p_folder_id uuid, p_linked boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder public.shop_folders := public.kb_member_folder(p_folder_id);
begin
  perform public.crm_owner_check(v_folder.shop_id);
  update public.shop_folders
  set pc_linked_at = case when coalesce(p_linked, false) then coalesce(pc_linked_at, now()) end,
      pc_synced_at = case when coalesce(p_linked, false) then pc_synced_at end,
      pc_files = case when coalesce(p_linked, false) then pc_files end,
      pc_remove_missing = case when coalesce(p_linked, false) then pc_remove_missing else false end
  where id = v_folder.id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_folder.shop_id, auth.uid(), 'kb_folder_linked', jsonb_build_object('folder_id', v_folder.id, 'linked', coalesce(p_linked, false)));
  return jsonb_build_object('linked', coalesce(p_linked, false));
end;
$$;
revoke execute on function public.owner_kb_folder_link(uuid, boolean) from public, anon;
grant execute on function public.owner_kb_folder_link(uuid, boolean) to authenticated;

/** The switch "Odstrániť z asistenta aj súbory zmazané v priečinku" (off by default; the page asks before it is on). */
create or replace function public.owner_kb_folder_settings(p_folder_id uuid, p_remove_missing boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder public.shop_folders := public.kb_member_folder(p_folder_id);
begin
  perform public.crm_owner_check(v_folder.shop_id);
  if v_folder.pc_linked_at is null then raise exception 'not_linked' using errcode = 'P0001'; end if;
  update public.shop_folders set pc_remove_missing = coalesce(p_remove_missing, false) where id = v_folder.id;
  return jsonb_build_object('remove_missing', coalesce(p_remove_missing, false));
end;
$$;
revoke execute on function public.owner_kb_folder_settings(uuid, boolean) from public, anon;
grant execute on function public.owner_kb_folder_settings(uuid, boolean) to authenticated;

/** The folder's link and its files that came from the PC (members; for the browser's check and the page's list). */
create or replace function public.owner_kb_folder_files(p_folder_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with f as (select * from public.kb_member_folder(p_folder_id))
  select jsonb_build_object(
    'folder_id', f.id,
    'linked', f.pc_linked_at is not null,
    'linked_at', f.pc_linked_at,
    'synced_at', f.pc_synced_at,
    'files', f.pc_files,
    'remove_missing', f.pc_remove_missing,
    'items', coalesce((
      select jsonb_agg(x order by x ->> 'name')
      from (
        select jsonb_build_object('kind', 'document', 'id', d.id, 'name', d.source_name, 'hash', d.source_hash,
                                  'status', d.status, 'missing_since', d.missing_since) as x
        from public.shop_documents d
        where d.folder_id = f.id and d.source = 'pc_folder'
        union all
        select jsonb_build_object('kind', 'picture', 'id', p.id, 'name', p.source_name, 'hash', p.source_hash,
                                  'status', p.status, 'missing_since', p.missing_since)
        from public.shop_pictures p
        where p.folder_id = f.id and p.source = 'pc_folder' and p.document_id is null
      ) rows), '[]'::jsonb))
  from f
$$;
revoke execute on function public.owner_kb_folder_files(uuid) from public, anon;
grant execute on function public.owner_kb_folder_files(uuid) to authenticated;

/** A document or picture just uploaded by the PC folder's check: its file name and SHA-256 (the folder must be linked). */
create or replace function public.owner_kb_mark_source(p_kind text, p_id uuid, p_name text, p_hash text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder_id uuid;
  v_shop_id uuid;
begin
  if p_kind = 'document' then
    select folder_id, shop_id into v_folder_id, v_shop_id from public.shop_documents where id = p_id;
  elsif p_kind = 'picture' then
    select folder_id, shop_id into v_folder_id, v_shop_id from public.shop_pictures where id = p_id and document_id is null;
  else
    raise exception 'kind' using errcode = '22023';
  end if;
  if v_folder_id is null then raise exception 'Not your shop' using errcode = '42501'; end if;
  perform public.crm_owner_check(v_shop_id);
  if not exists (select 1 from public.shop_folders where id = v_folder_id and pc_linked_at is not null) then
    raise exception 'not_linked' using errcode = 'P0001';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 255 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'file' using errcode = '22023';
  end if;
  if p_kind = 'document' then
    update public.shop_documents set source = 'pc_folder', source_name = btrim(p_name), source_hash = p_hash, missing_since = null
    where id = p_id;
  else
    update public.shop_pictures set source = 'pc_folder', source_name = btrim(p_name), source_hash = p_hash, missing_since = null
    where id = p_id;
  end if;
  return true;
end;
$$;
revoke execute on function public.owner_kb_mark_source(text, uuid, text, text) from public, anon;
grant execute on function public.owner_kb_mark_source(text, uuid, text, text) to authenticated;

/**
 * One check of the PC folder is done: p_present = the supported file names in it now. PC files no longer there get
 * missing_since (kept from the first time), those there again lose it. Returns {missing: [{kind, id}],
 * remove_missing}. The activity log gets kb_folder_synced only when something changed (p_changed > 0 or newly missing).
 */
create or replace function public.owner_kb_folder_synced(p_folder_id uuid, p_present text[], p_files integer, p_changed integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder public.shop_folders := public.kb_member_folder(p_folder_id);
  v_present text[] := coalesce((select array_agg(btrim(n)) from unnest(coalesce(p_present, '{}')) n where n is not null), '{}');
  v_new integer := 0;
  v_count integer;
begin
  perform public.crm_owner_check(v_folder.shop_id);
  if v_folder.pc_linked_at is null then raise exception 'not_linked' using errcode = 'P0001'; end if;
  update public.shop_documents set missing_since = now()
  where folder_id = v_folder.id and source = 'pc_folder' and missing_since is null and not (source_name = any (v_present));
  get diagnostics v_count = row_count;
  v_new := v_new + v_count;
  update public.shop_pictures set missing_since = now()
  where folder_id = v_folder.id and source = 'pc_folder' and document_id is null and missing_since is null
    and not (source_name = any (v_present));
  get diagnostics v_count = row_count;
  v_new := v_new + v_count;
  update public.shop_documents set missing_since = null
  where folder_id = v_folder.id and source = 'pc_folder' and missing_since is not null and source_name = any (v_present);
  update public.shop_pictures set missing_since = null
  where folder_id = v_folder.id and source = 'pc_folder' and document_id is null and missing_since is not null
    and source_name = any (v_present);
  update public.shop_folders set pc_synced_at = now(), pc_files = greatest(0, least(coalesce(p_files, 0), 100000))
  where id = v_folder.id;
  if coalesce(p_changed, 0) > 0 or v_new > 0 then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (v_folder.shop_id, auth.uid(), 'kb_folder_synced',
            jsonb_build_object('folder_id', v_folder.id, 'changed', greatest(0, coalesce(p_changed, 0)), 'missing', v_new));
  end if;
  return jsonb_build_object(
    'remove_missing', v_folder.pc_remove_missing,
    'missing', coalesce((
      select jsonb_agg(m)
      from (
        select jsonb_build_object('kind', 'document', 'id', d.id) as m from public.shop_documents d
        where d.folder_id = v_folder.id and d.source = 'pc_folder' and d.missing_since is not null
        union all
        select jsonb_build_object('kind', 'picture', 'id', p.id) from public.shop_pictures p
        where p.folder_id = v_folder.id and p.source = 'pc_folder' and p.document_id is null and p.missing_since is not null
      ) x), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_kb_folder_synced(uuid, text[], integer, integer) from public, anon;
grant execute on function public.owner_kb_folder_synced(uuid, text[], integer, integer) to authenticated;

/** After the browser removed documents of a linked folder (doc-ingest "delete"): one activity line, never file names. */
create or replace function public.owner_kb_removed(p_folder_id uuid, p_count integer, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_folder public.shop_folders := public.kb_member_folder(p_folder_id);
begin
  perform public.crm_owner_check(v_folder.shop_id);
  if p_reason is null or p_reason not in ('missing', 'replaced', 'owner') then raise exception 'reason' using errcode = '22023'; end if;
  if coalesce(p_count, 0) < 1 then return false; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_folder.shop_id, auth.uid(), 'kb_doc_removed',
          jsonb_build_object('folder_id', v_folder.id, 'count', least(p_count, 100000), 'reason', p_reason));
  return true;
end;
$$;
revoke execute on function public.owner_kb_removed(uuid, integer, text) from public, anon;
grant execute on function public.owner_kb_removed(uuid, integer, text) to authenticated;
