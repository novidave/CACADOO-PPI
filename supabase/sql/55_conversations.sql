-- =====================================================================================================================
-- Update 55 — "Konverzácie" for Pro shops (2026-10-30, at the owner's request; phase 1 of the CRM work)
--
-- Paste the whole file into Supabase → SQL Editor and run it. Running it again changes nothing.
--
-- 1. Keep time: "Neobmedzene" (kept until the owner deletes them) is the default; 30 / 90 / 365 days stay as choices.
--    The nightly job deletes only the conversations of shops that chose a limit. Shops still on the old default
--    (90 days, never chosen after this update) become "Neobmedzene"; 30 and 365 days were chosen and stay.
-- 2. Every conversation gets a status (Nové / Prečítané / Archivované), a star, the owner's private note, the flags
--    "bez odpovede" (the assistant could not answer) and "prístupový kľúč" (an access key was used), the products it
--    suggested (their ids) and a search text. Conversations before this update keep the flags unknown (null).
-- 3. The owner's functions: the list with filters and search, marking (one or many), the note, the CSV export and the
--    activity log of every action. Only members of the shop (is_shop_member); visitors never.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. keep time

alter table public.shop_assistant_settings
  -- when the owner last chose the keep time (null = never chose after update 55)
  add column if not exists retention_chosen_at timestamptz;
alter table public.shop_assistant_settings alter column retention_days drop not null;
alter table public.shop_assistant_settings alter column retention_days drop default;
alter table public.shop_assistant_settings drop constraint if exists shop_assistant_settings_retention_days_check;
alter table public.shop_assistant_settings add constraint shop_assistant_settings_retention_days_check
  check (retention_days is null or retention_days in (30, 90, 365));
-- 30 and 365 days were chosen by the owner; 90 was the default nobody had to choose: it becomes "Neobmedzene" (once —
-- a 90 chosen after this update has retention_chosen_at and stays).
update public.shop_assistant_settings set retention_chosen_at = coalesce(updated_at, now())
where retention_chosen_at is null and retention_days in (30, 365);
update public.shop_assistant_settings set retention_days = null
where retention_chosen_at is null and retention_days = 90;

/** Conversations past a keep time the shop chose (30, 90 or 365 days after the last message); none for "Neobmedzene". */
create or replace function public.assistant_expired(p_limit integer default 200)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.assistant_conversations c
  join public.shop_assistant_settings st on st.shop_id = c.shop_id
  where c.ended_at is not null
    and st.retention_days is not null
    and c.last_message_at < now() - make_interval(days => st.retention_days)
  order by c.last_message_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;
revoke execute on function public.assistant_expired(integer) from public, anon, authenticated;
grant execute on function public.assistant_expired(integer) to service_role;

-- ------------------------------------------------------------------ 2. the activity log's new actions

alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted',
                    'inventory_api_connected', 'inventory_api_key_changed', 'inventory_api_approved',
                    'inventory_api_error', 'inventory_api_recovered', 'inventory_api_disconnected',
                    'connector_paired', 'connector_revoked', 'stock_source_changed', 'connector_snapshot_held',
                    'connector_snapshot_approved', 'connector_snapshot_discarded', 'connector_sync_requested',
                    'conversation_retention', 'conversations_marked', 'conversation_note', 'conversations_deleted',
                    'conversations_exported'));

/** The owner changes the keep time: 30, 90 or 365 days, or null = "Neobmedzene" (members of the shop only). */
create or replace function public.owner_set_assistant_retention(p_shop_id uuid, p_days integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_days is not null and p_days not in (30, 90, 365) then
    raise exception 'retention' using errcode = '22023';
  end if;
  insert into public.shop_assistant_settings (shop_id, retention_days, retention_chosen_at, updated_at)
  values (p_shop_id, p_days, now(), now())
  on conflict (shop_id) do update
    set retention_days = excluded.retention_days, retention_chosen_at = now(), updated_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'conversation_retention', jsonb_build_object('days', p_days));
  return p_days;
end;
$$;
revoke execute on function public.owner_set_assistant_retention(uuid, integer) from public, anon;
grant execute on function public.owner_set_assistant_retention(uuid, integer) to authenticated, service_role;

-- ------------------------------------------------------------------ 3. a conversation's status, star, note, flags

-- Conversations before this update count as read (the owner could already read them); new ones arrive as "new".
alter table public.assistant_conversations add column if not exists status text;
update public.assistant_conversations set status = 'read' where status is null;
alter table public.assistant_conversations alter column status set default 'new';
alter table public.assistant_conversations alter column status set not null;
alter table public.assistant_conversations drop constraint if exists assistant_conversations_status_check;
alter table public.assistant_conversations add constraint assistant_conversations_status_check
  check (status in ('new', 'read', 'archived'));

alter table public.assistant_conversations
  add column if not exists starred boolean not null default false,
  add column if not exists owner_note text,
  -- null = before update 55 (unknown); then false until the assistant could not answer / a key was used
  add column if not exists unanswered boolean,
  add column if not exists access_key_used boolean,
  -- the products the assistant suggested (shop_items ids, in the order first suggested; a deleted product stays here)
  add column if not exists item_ids uuid[] not null default '{}',
  -- every message (and its Slovak version) as search_text(): the owner's search
  add column if not exists search_doc text,
  add column if not exists read_at timestamptz;
alter table public.assistant_conversations alter column unanswered set default false;
alter table public.assistant_conversations alter column access_key_used set default false;
alter table public.assistant_conversations drop constraint if exists assistant_conversations_owner_note_check;
alter table public.assistant_conversations add constraint assistant_conversations_owner_note_check
  check (owner_note is null or char_length(owner_note) <= 2000);

alter table public.assistant_messages
  -- the answer said the assistant could not help (it pointed to the shop)
  add column if not exists unanswered boolean not null default false;

update public.assistant_conversations c
set search_doc = (select public.search_text(string_agg(m.body || ' ' || coalesce(m.body_owner, ''), ' ' order by m.id))
                  from public.assistant_messages m where m.conversation_id = c.id)
where c.search_doc is null;

-- Owners read the new columns too (never the search text: it is only for the search).
grant select (status, starred, owner_note, unanswered, access_key_used, item_ids, read_at)
  on public.assistant_conversations to authenticated;

create index if not exists assistant_conversations_status_idx
  on public.assistant_conversations (shop_id, status, started_at desc);
create index if not exists assistant_conversations_search_idx
  on public.assistant_conversations using gin (search_doc extensions.gin_trgm_ops);

/** A card as stored: only these fields, texts cut to sensible lengths, the product's id when it is one. */
create or replace function public.assistant_card(p_card jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'item_id', case when (p_card ->> 'item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then lower(p_card ->> 'item_id') end,
    'name', left(p_card ->> 'name', 300),
    'price', left(p_card ->> 'price', 40),
    'availability', left(p_card ->> 'availability', 80),
    'data_time', case when (p_card ->> 'data_time') ~ '^\d{4}-\d{2}-\d{2}T' then p_card ->> 'data_time' end,
    'quantity', case when (p_card ->> 'quantity') ~ '^\d{1,3}$' then (p_card ->> 'quantity')::integer end,
    'note', nullif(left(p_card ->> 'note', 200), '')))
$$;
revoke execute on function public.assistant_card(jsonb) from public, anon, authenticated;
grant execute on function public.assistant_card(jsonb) to service_role;

/**
 * One exchange (as update 22), now also: p_assistant.unanswered (the assistant could not answer), p_shopper.access_key
 * (the shopper had folders open with an access key), the suggested products' ids from the cards, the search text, and
 * a new message makes the conversation "new" again for the owner.
 */
create or replace function public.assistant_add_turn(
  p_id uuid, p_token text, p_shop_id uuid, p_shopper jsonb, p_assistant jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conv public.assistant_conversations%rowtype;
  v_files uuid[];
  v_at timestamptz;
  v_lang text;
  v_cards jsonb;
  v_unanswered boolean := coalesce((p_assistant ->> 'unanswered') = 'true', false);
  v_key boolean := coalesce((p_shopper ->> 'access_key') = 'true', false);
  v_items uuid[];
begin
  select * into v_conv from public.assistant_conversations
  where id = p_id and token_hash = public.assistant_token_hash(p_token) and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_conv.ended_at is not null then
    raise exception 'ended' using errcode = '55000';
  end if;
  if coalesce(btrim(p_assistant ->> 'body'), '') = '' then
    raise exception 'The answer is empty' using errcode = '22023';
  end if;

  select coalesce(array_agg(a.id order by a.created_at), '{}') into v_files
  from public.assistant_attachments a
  where a.conversation_id = v_conv.id
    and a.id::text in (select jsonb_array_elements_text(coalesce(p_shopper -> 'attachments', '[]'::jsonb)))
    and not exists (select 1 from public.assistant_messages m
                    where m.conversation_id = v_conv.id and a.id = any (m.attachment_ids));
  -- The shopper's time: when the website got the message (a little before the answer).
  v_at := case when (p_shopper ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T'
                    and (p_shopper ->> 'at')::timestamptz between now() - interval '3 minutes' and now()
               then (p_shopper ->> 'at')::timestamptz else now() end;
  v_lang := case when (p_shopper ->> 'lang') ~ '^[a-z]{2,3}$' then p_shopper ->> 'lang' end;
  select coalesce(jsonb_agg(public.assistant_card(c)), '[]'::jsonb) into v_cards
  from (select c from jsonb_array_elements(case when jsonb_typeof(p_assistant -> 'cards') = 'array'
                                                then p_assistant -> 'cards' else '[]'::jsonb end) c
        where jsonb_typeof(c) = 'object' limit 40) x;
  -- the suggested products, once each, in the order first suggested (only ids of this shop's products)
  select coalesce(array_agg(i.id order by i.n), '{}') into v_items
  from (select distinct on ((c ->> 'item_id')::uuid) (c ->> 'item_id')::uuid as id, n
        from jsonb_array_elements(v_cards) with ordinality as e(c, n)
        where c ? 'item_id'
        order by (c ->> 'item_id')::uuid, n) i
  where exists (select 1 from public.shop_items si where si.id = i.id and si.shop_id = v_conv.shop_id)
    and not i.id = any (v_conv.item_ids);

  insert into public.assistant_messages (conversation_id, shop_id, role, body, body_owner, lang, attachment_ids, created_at)
  values (v_conv.id, v_conv.shop_id, 'shopper', left(coalesce(p_shopper ->> 'body', ''), 8000),
          nullif(left(btrim(coalesce(p_shopper ->> 'body_owner', '')), 8000), ''), v_lang, v_files, v_at);
  insert into public.assistant_messages (conversation_id, shop_id, role, body, body_owner, lang, cards, unanswered)
  values (v_conv.id, v_conv.shop_id, 'assistant', left(p_assistant ->> 'body', 8000),
          nullif(left(btrim(coalesce(p_assistant ->> 'body_owner', '')), 8000), ''),
          case when (p_assistant ->> 'lang') ~ '^[a-z]{2,3}$' then p_assistant ->> 'lang' end, v_cards, v_unanswered);

  update public.assistant_conversations
  set message_count = message_count + 2,
      last_message_at = now(),
      shopper_lang = coalesce(shopper_lang, v_lang),
      first_question = coalesce(first_question,
                                nullif(left(btrim(regexp_replace(coalesce(p_shopper ->> 'body', ''), '\s+', ' ', 'g')), 300), '')),
      unanswered = coalesce(unanswered, false) or v_unanswered,
      access_key_used = coalesce(access_key_used, false) or v_key,
      item_ids = item_ids || v_items,
      search_doc = left(concat_ws(' ', search_doc, public.search_text(concat_ws(' ',
                     p_shopper ->> 'body', p_shopper ->> 'body_owner', p_assistant ->> 'body', p_assistant ->> 'body_owner'))),
                        200000),
      -- a new message: the owner sees the conversation as new again (also an archived one)
      status = 'new',
      read_at = null
  where id = v_conv.id;
end;
$$;
revoke execute on function public.assistant_add_turn(uuid, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.assistant_add_turn(uuid, text, uuid, jsonb, jsonb) to service_role;

-- ------------------------------------------------------------------ 4. the owner's list

/**
 * "Konverzácie": newest first. p_q = words that must all appear (any message, its Slovak version or the owner's note;
 * accents and case ignored); p_from / p_to = days in the shop's time zone; p_status: null = new and read (not
 * archived), 'new' | 'read' | 'archived' | 'all'; p_starred / p_unanswered / p_attachments: true = only those;
 * p_lang = the shopper's language. Members of the shop only.
 */
create or replace function public.owner_conversations(
  p_shop_id uuid,
  p_q text default null,
  p_from date default null,
  p_to date default null,
  p_status text default null,
  p_starred boolean default null,
  p_unanswered boolean default null,
  p_attachments boolean default null,
  p_lang text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  page_lang text,
  shopper_lang text,
  message_count integer,
  attachment_count integer,
  first_question text,
  pdf_status text,
  export_status text,
  export_error text,
  export_path text,
  shopper_deleted_at timestamptz,
  status text,
  starred boolean,
  unanswered boolean,
  access_key_used boolean,
  has_note boolean,
  item_count integer,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with shop as (
    select s.id, s.timezone from public.shops s
    where s.id = owner_conversations.p_shop_id and public.is_shop_member(s.id)
  )
  select c.id, c.started_at, c.ended_at, c.page_lang, c.shopper_lang, c.message_count, c.attachment_count,
         c.first_question, c.pdf_status, c.export_status, c.export_error, c.export_path, c.shopper_deleted_at,
         c.status, c.starred, c.unanswered, c.access_key_used, c.owner_note is not null and c.owner_note <> '',
         cardinality(c.item_ids), count(*) over ()
  from public.assistant_conversations c
  join shop on shop.id = c.shop_id
  where (c.message_count > 0 or c.shopper_deleted_at is not null)
    and case coalesce(owner_conversations.p_status, '')
          when '' then c.status <> 'archived'
          when 'all' then true
          else c.status = owner_conversations.p_status end
    and (owner_conversations.p_starred is not true or c.starred)
    and (owner_conversations.p_unanswered is not true or c.unanswered)
    and (owner_conversations.p_attachments is not true or c.attachment_count > 0)
    and (nullif(owner_conversations.p_lang, '') is null
         or coalesce(c.shopper_lang, c.page_lang) = owner_conversations.p_lang)
    and (owner_conversations.p_from is null
         or c.started_at >= (owner_conversations.p_from::timestamp at time zone shop.timezone))
    and (owner_conversations.p_to is null
         or c.started_at < ((owner_conversations.p_to + 1)::timestamp at time zone shop.timezone))
    and (nullif(btrim(coalesce(owner_conversations.p_q, '')), '') is null
         or public.matches_all_words(concat_ws(' ', c.search_doc, public.search_text(c.owner_note)),
                                     owner_conversations.p_q))
  order by c.started_at desc, c.id
  limit least(greatest(coalesce(owner_conversations.p_limit, 20), 1), 100)
  offset greatest(coalesce(owner_conversations.p_offset, 0), 0)
$$;
revoke execute on function public.owner_conversations(uuid, text, date, date, text, boolean, boolean, boolean, text, integer, integer)
  from public, anon;
grant execute on function public.owner_conversations(uuid, text, date, date, text, boolean, boolean, boolean, text, integer, integer)
  to authenticated, service_role;

/** The languages the shop's conversations were in (for the filter), most used first. Members only. */
create or replace function public.owner_conversation_languages(p_shop_id uuid)
returns table (lang text, conversations bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(c.shopper_lang, c.page_lang), count(*)
  from public.assistant_conversations c
  where c.shop_id = p_shop_id and public.is_shop_member(p_shop_id) and c.message_count > 0
  group by 1
  order by 2 desc, 1
$$;
revoke execute on function public.owner_conversation_languages(uuid) from public, anon;
grant execute on function public.owner_conversation_languages(uuid) to authenticated, service_role;

/** How many conversations wait as "Nové" (the badge). Members only. */
create or replace function public.owner_conversations_new(p_shop_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.assistant_conversations c
  where c.shop_id = p_shop_id and public.is_shop_member(p_shop_id) and c.status = 'new' and c.message_count > 0
$$;
revoke execute on function public.owner_conversations_new(uuid) from public, anon;
grant execute on function public.owner_conversations_new(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ 5. the owner's changes

/**
 * Marks conversations of the shop: 'read' | 'new' | 'archive' | 'unarchive' (back to read) | 'star' | 'unstar'.
 * Ids of other shops are ignored. p_log false = opening a conversation (marked read, not written in the log).
 * Returns how many changed. Members of the shop only.
 */
create or replace function public.owner_conversations_mark(p_shop_id uuid, p_ids uuid[], p_action text, p_log boolean default true)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('read', 'new', 'archive', 'unarchive', 'star', 'unstar') then
    raise exception 'action' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) > 500 then
    raise exception 'too_many' using errcode = '22023';
  end if;
  update public.assistant_conversations c
  set status = case p_action when 'read' then 'read' when 'new' then 'new' when 'archive' then 'archived'
                             when 'unarchive' then 'read' else c.status end,
      read_at = case when p_action in ('read', 'archive', 'unarchive') then coalesce(c.read_at, now())
                     when p_action = 'new' then null else c.read_at end,
      starred = case p_action when 'star' then true when 'unstar' then false else c.starred end
  where c.shop_id = p_shop_id and c.id = any (p_ids)
    and case p_action when 'read' then c.status = 'new'
                      when 'new' then c.status <> 'new'
                      when 'archive' then c.status <> 'archived'
                      when 'unarchive' then c.status = 'archived'
                      when 'star' then not c.starred
                      else c.starred end;
  get diagnostics v_n = row_count;
  if v_n > 0 and coalesce(p_log, true) then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p_shop_id, auth.uid(), 'conversations_marked', jsonb_build_object('action', p_action, 'count', v_n));
  end if;
  return v_n;
end;
$$;
revoke execute on function public.owner_conversations_mark(uuid, uuid[], text, boolean) from public, anon;
grant execute on function public.owner_conversations_mark(uuid, uuid[], text, boolean) to authenticated, service_role;

/** The owner's private note on a conversation (plain text, ≤ 2000; empty clears it). Members of its shop only. */
create or replace function public.owner_conversation_note(p_id uuid, p_note text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select shop_id into v_shop from public.assistant_conversations where id = p_id;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if char_length(coalesce(v_note, '')) > 2000 then
    raise exception 'note' using errcode = '22023';
  end if;
  update public.assistant_conversations set owner_note = v_note where id = p_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop, auth.uid(), 'conversation_note', jsonb_build_object('conversation_id', p_id, 'cleared', v_note is null));
  return v_note;
end;
$$;
revoke execute on function public.owner_conversation_note(uuid, text) from public, anon;
grant execute on function public.owner_conversation_note(uuid, text) to authenticated, service_role;

/**
 * Writes the owner's deletions and exports into the activity log (the files are deleted by the assistant-archive
 * function, the exports made by the website): 'conversations_deleted' | 'conversations_exported'. Members only.
 */
create or replace function public.owner_conversations_log(p_shop_id uuid, p_action text, p_details jsonb)
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
  if p_action is null or p_action not in ('conversations_deleted', 'conversations_exported') then
    raise exception 'action' using errcode = '22023';
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), p_action,
          case when jsonb_typeof(p_details) = 'object' then p_details else '{}'::jsonb end);
end;
$$;
revoke execute on function public.owner_conversations_log(uuid, text, jsonb) from public, anon;
grant execute on function public.owner_conversations_log(uuid, text, jsonb) to authenticated, service_role;

/**
 * The CSV export of a date range (days in the shop's time zone): one row per message, the conversation's status,
 * star, flags and language with it. At most 50 000 rows; the export is written in the activity log. Members only.
 */
create or replace function public.owner_conversations_export(p_shop_id uuid, p_from date, p_to date)
returns table (
  conversation_id uuid,
  started_at timestamptz,
  status text,
  starred boolean,
  unanswered boolean,
  access_key_used boolean,
  language text,
  message_at timestamptz,
  role text,
  body text,
  body_owner text,
  attachments integer,
  products text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  select s.timezone into v_tz from public.shops s where s.id = p_shop_id;
  if v_tz is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception 'range' using errcode = '22023';
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'conversations_exported', jsonb_build_object('from', p_from, 'to', p_to, 'format', 'csv'));
  return query
  select c.id, c.started_at, c.status, c.starred, c.unanswered, c.access_key_used,
         coalesce(c.shopper_lang, c.page_lang), m.created_at, m.role, m.body, m.body_owner,
         cardinality(m.attachment_ids),
         (select string_agg(x ->> 'name', '; ') from jsonb_array_elements(m.cards) x)
  from public.assistant_conversations c
  join public.assistant_messages m on m.conversation_id = c.id
  where c.shop_id = p_shop_id
    and c.started_at >= (p_from::timestamp at time zone v_tz)
    and c.started_at < ((p_to + 1)::timestamp at time zone v_tz)
  order by c.started_at, c.id, m.id
  limit 50000;
end;
$$;
revoke execute on function public.owner_conversations_export(uuid, date, date) from public, anon;
grant execute on function public.owner_conversations_export(uuid, date, date) to authenticated, service_role;
