-- PPI · 22 · Shop assistant archive (paid plan). Paste the whole file into the Supabase SQL Editor and Run.
--  Every conversation with a shop's assistant is kept for the shop's owners: the messages
--  with their times, the item cards shown (name, price, availability at that moment) and
--  the files the shopper sent (private bucket shop-assistant-uploads, GPS data removed).
--  A conversation ends after 30 minutes without a message or when the shopper closes the
--  chat; then the assistant-archive Edge Function makes one PDF of it.
--  Written only by that function (service role). Owners only read (RLS), choose how long
--  conversations are kept (30 / 90 / 365 days, default 90) and delete them; a shopper can
--  delete their own conversation with its token. Conversation tokens are kept as SHA-256.
--  Two jobs (pg_cron + pg_net, secret in Vault): every 5 minutes (end idle conversations,
--  make PDFs) and once a day (delete what is past the shop's keep time).
-- Safe to run again.

-- ------------------------------------------------------------------ tables

create table if not exists public.assistant_conversations (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  token_hash       text not null,
  -- the page language (sk/hu/en) and the language the shopper wrote in (from the AI)
  page_lang        text not null default 'sk' check (page_lang in ('sk', 'hu', 'en')),
  shopper_lang     text check (shopper_lang is null or shopper_lang ~ '^[a-z]{2,3}$'),
  started_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now(),
  ended_at         timestamptz,
  end_reason       text check (end_reason is null or end_reason in ('closed', 'idle', 'new')),
  message_count    integer not null default 0 check (message_count >= 0),
  attachment_count integer not null default 0 check (attachment_count between 0 and 10),
  first_question   text check (first_question is null or length(first_question) <= 300),
  pdf_status       text not null default 'none' check (pdf_status in ('none', 'ready', 'failed')),
  pdf_path         text,
  pdf_name         text,
  pdf_error        text check (pdf_error is null or length(pdf_error) <= 500),
  pdf_attempts     integer not null default 0,
  pdf_next_try     timestamptz
);
create index if not exists assistant_conversations_shop_idx on public.assistant_conversations (shop_id, started_at desc);
create index if not exists assistant_conversations_open_idx on public.assistant_conversations (last_message_at)
  where ended_at is null;
create index if not exists assistant_conversations_pdf_idx on public.assistant_conversations (ended_at)
  where ended_at is not null and pdf_status <> 'ready';

create table if not exists public.assistant_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  shop_id         uuid not null references public.shops (id) on delete cascade,
  role            text not null check (role in ('shopper', 'assistant')),
  body            text not null check (length(body) <= 8000),
  -- the same text in Slovak for the owner, when it was written in another language
  body_owner      text check (body_owner is null or length(body_owner) <= 8000),
  lang            text check (lang is null or lang ~ '^[a-z]{2,3}$'),
  -- item cards shown with an answer, as they were at that moment:
  -- [{name, price, availability, data_time, quantity?, note?}]
  cards           jsonb not null default '[]'::jsonb check (jsonb_typeof(cards) = 'array'),
  attachment_ids  uuid[] not null default '{}',
  created_at      timestamptz not null default now()
);
create index if not exists assistant_messages_conversation_idx on public.assistant_messages (conversation_id, id);

create table if not exists public.assistant_attachments (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  shop_id         uuid not null references public.shops (id) on delete cascade,
  -- the shopper's file name (cleaned), its real type (checked by its content) and size
  name            text not null check (length(name) between 1 and 200),
  kind            text not null check (kind in ('jpeg', 'png', 'webp', 'heic', 'pdf')),
  bytes           integer not null check (bytes between 1 and 10485760),
  storage_path    text not null unique,
  -- a small JPEG made in the shopper's browser (pictures only): for the PDF and the owner
  preview_path    text unique,
  created_at      timestamptz not null default now()
);
create index if not exists assistant_attachments_conversation_idx on public.assistant_attachments (conversation_id);

create table if not exists public.shop_assistant_settings (
  shop_id        uuid primary key references public.shops (id) on delete cascade,
  retention_days integer not null default 90 check (retention_days in (30, 90, 365)),
  updated_at     timestamptz not null default now()
);

-- ------------------------------------------------------------------ access

alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_attachments enable row level security;
alter table public.shop_assistant_settings enable row level security;

revoke all on public.assistant_conversations, public.assistant_messages, public.assistant_attachments,
  public.shop_assistant_settings from public, anon, authenticated;
grant all on public.assistant_conversations, public.assistant_messages, public.assistant_attachments,
  public.shop_assistant_settings to service_role;
-- Owners read; never the token hash or the storage paths.
grant select (id, shop_id, page_lang, shopper_lang, started_at, last_message_at, ended_at, end_reason, message_count,
              attachment_count, first_question, pdf_status, pdf_name, pdf_error)
  on public.assistant_conversations to authenticated;
grant select on public.assistant_messages to authenticated;
grant select (id, conversation_id, shop_id, name, kind, bytes, created_at) on public.assistant_attachments to authenticated;
grant select on public.shop_assistant_settings to authenticated;

drop policy if exists "assistant_conversations: members read" on public.assistant_conversations;
create policy "assistant_conversations: members read" on public.assistant_conversations
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "assistant_messages: members read" on public.assistant_messages;
create policy "assistant_messages: members read" on public.assistant_messages
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "assistant_attachments: members read" on public.assistant_attachments;
create policy "assistant_attachments: members read" on public.assistant_attachments
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "shop_assistant_settings: members read" on public.shop_assistant_settings;
create policy "shop_assistant_settings: members read" on public.shop_assistant_settings
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ helpers

/** Conversation tokens are kept only as their SHA-256. */
create or replace function public.assistant_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.assistant_token_hash(text) from public, anon, authenticated;
grant execute on function public.assistant_token_hash(text) to service_role;

/** A file name safe for storage and cloud folders: no path, no control or reserved characters. */
create or replace function public.assistant_file_name(p_name text, p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(btrim(left(regexp_replace(regexp_replace(coalesce(p_name, ''), '^.*[\\/]', ''),
                                                   '[[:cntrl:]<>:"|?*]', '_', 'g'), 120), ' .'), ''),
                  'subor.' || case p_kind when 'jpeg' then 'jpg' else coalesce(p_kind, 'bin') end)
$$;
revoke execute on function public.assistant_file_name(text, text) from public, anon, authenticated;
grant execute on function public.assistant_file_name(text, text) to service_role;

-- ------------------------------------------------------------------ conversations (service role)

/**
 * A new conversation of an active shop with the paid plan. p_ip_hash: the website's daily
 * hash of the shopper (never an IP address); at most 30 new conversations per shopper and
 * shop an hour. Returns {id, token}: the token is shown only now; its hash is kept.
 */
create or replace function public.assistant_open(p_shop_id uuid, p_page_lang text, p_ip_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid;
begin
  if not exists (select 1 from public.shops where id = p_shop_id and is_active) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  if p_ip_hash is null or length(p_ip_hash) < 16 or length(p_ip_hash) > 128 then
    raise exception 'Invalid caller hash' using errcode = '22023';
  end if;
  if (select count(*) from public.api_usage
      where ip_hash = p_ip_hash and endpoint = 'assistant-open:' || p_shop_id
        and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.api_usage (ip_hash, endpoint) values (p_ip_hash, 'assistant-open:' || p_shop_id);
  insert into public.assistant_conversations (shop_id, token_hash, page_lang)
  values (p_shop_id, public.assistant_token_hash(v_token),
          case when p_page_lang in ('sk', 'hu', 'en') then p_page_lang else 'sk' end)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token);
end;
$$;
revoke execute on function public.assistant_open(uuid, text, text) from public, anon, authenticated;
grant execute on function public.assistant_open(uuid, text, text) to service_role;

/** The conversation when the token fits: {id, shop_id, open, messages, attachments}; else null. */
create or replace function public.assistant_conversation(p_id uuid, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'shop_id', c.shop_id, 'open', c.ended_at is null,
                            'messages', c.message_count, 'attachments', c.attachment_count)
  from public.assistant_conversations c
  where c.id = p_id and c.token_hash = public.assistant_token_hash(p_token)
$$;
revoke execute on function public.assistant_conversation(uuid, text) from public, anon, authenticated;
grant execute on function public.assistant_conversation(uuid, text) to service_role;

/**
 * Registers a shopper's file before it is stored: only while the conversation is open, at
 * most 10 per conversation, 10 MB each, only JPEG, PNG, WebP, HEIC and PDF (the function
 * checks the real type from the content). Returns {id, name, path, preview_path}.
 */
create or replace function public.assistant_add_attachment(
  p_id uuid, p_token text, p_name text, p_kind text, p_bytes integer, p_preview boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conv public.assistant_conversations%rowtype;
  v_att uuid := gen_random_uuid();
  v_ext text;
  v_base text;
  v_name text;
  v_preview text;
begin
  select * into v_conv from public.assistant_conversations
  where id = p_id and token_hash = public.assistant_token_hash(p_token)
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_conv.ended_at is not null then
    raise exception 'ended' using errcode = '55000';
  end if;
  if v_conv.attachment_count >= 10 then
    raise exception 'too_many_files' using errcode = '54000';
  end if;
  if p_kind is null or p_kind not in ('jpeg', 'png', 'webp', 'heic', 'pdf') then
    raise exception 'type' using errcode = '22023';
  end if;
  if p_bytes is null or p_bytes < 1 or p_bytes > 10485760 then
    raise exception 'too_big' using errcode = '22023';
  end if;
  v_ext := case p_kind when 'jpeg' then 'jpg' else p_kind end;
  v_base := v_conv.shop_id || '/' || v_conv.id || '/files/' || v_att;
  v_name := public.assistant_file_name(p_name, p_kind);
  v_preview := case when coalesce(p_preview, false) and p_kind <> 'pdf' then v_base || '.preview.jpg' end;
  insert into public.assistant_attachments (id, conversation_id, shop_id, name, kind, bytes, storage_path, preview_path)
  values (v_att, v_conv.id, v_conv.shop_id, v_name, p_kind, p_bytes, v_base || '.' || v_ext, v_preview);
  update public.assistant_conversations
  set attachment_count = attachment_count + 1, last_message_at = now()
  where id = v_conv.id;
  return jsonb_build_object('id', v_att, 'name', v_name, 'path', v_base || '.' || v_ext, 'preview_path', v_preview);
end;
$$;
revoke execute on function public.assistant_add_attachment(uuid, text, text, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.assistant_add_attachment(uuid, text, text, text, integer, boolean) to service_role;

/** A file whose storing failed is forgotten again. */
create or replace function public.assistant_drop_attachment(p_attachment uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conv uuid;
begin
  delete from public.assistant_attachments where id = p_attachment returning conversation_id into v_conv;
  if v_conv is not null then
    update public.assistant_conversations set attachment_count = greatest(attachment_count - 1, 0) where id = v_conv;
  end if;
end;
$$;
revoke execute on function public.assistant_drop_attachment(uuid) from public, anon, authenticated;
grant execute on function public.assistant_drop_attachment(uuid) to service_role;

/**
 * A file the shopper took back before sending it: its stored paths (the function deletes
 * them, then the row) while no message has it yet; null when it is not theirs.
 */
create or replace function public.assistant_discardable(p_id uuid, p_token text, p_attachment uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[a.storage_path, a.preview_path], null)
  from public.assistant_attachments a
  join public.assistant_conversations c on c.id = a.conversation_id
  where a.id = p_attachment and c.id = p_id and c.token_hash = public.assistant_token_hash(p_token)
    and not exists (select 1 from public.assistant_messages m
                    where m.conversation_id = c.id and a.id = any (m.attachment_ids))
$$;
revoke execute on function public.assistant_discardable(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.assistant_discardable(uuid, text, uuid) to service_role;

/** A card as stored: only these fields, texts cut to sensible lengths. */
create or replace function public.assistant_card(p_card jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
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
 * One exchange: the shopper's message (with the files sent with it) and the assistant's
 * answer with its cards, only into a conversation of that shop (p_shop_id). p_shopper / p_assistant: {body, body_owner, lang, at?,
 * attachments? (shopper), cards? (assistant)}. Only files of this conversation that no
 * earlier message has. Raises 'ended' when the conversation has ended (the website then
 * starts a new one).
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

  insert into public.assistant_messages (conversation_id, shop_id, role, body, body_owner, lang, attachment_ids, created_at)
  values (v_conv.id, v_conv.shop_id, 'shopper', left(coalesce(p_shopper ->> 'body', ''), 8000),
          nullif(left(btrim(coalesce(p_shopper ->> 'body_owner', '')), 8000), ''), v_lang, v_files, v_at);
  insert into public.assistant_messages (conversation_id, shop_id, role, body, body_owner, lang, cards)
  values (v_conv.id, v_conv.shop_id, 'assistant', left(p_assistant ->> 'body', 8000),
          nullif(left(btrim(coalesce(p_assistant ->> 'body_owner', '')), 8000), ''),
          case when (p_assistant ->> 'lang') ~ '^[a-z]{2,3}$' then p_assistant ->> 'lang' end, v_cards);

  update public.assistant_conversations
  set message_count = message_count + 2,
      last_message_at = now(),
      shopper_lang = coalesce(shopper_lang, v_lang),
      first_question = coalesce(first_question,
                                nullif(left(btrim(regexp_replace(coalesce(p_shopper ->> 'body', ''), '\s+', ' ', 'g')), 300), ''))
  where id = v_conv.id;
end;
$$;
revoke execute on function public.assistant_add_turn(uuid, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.assistant_add_turn(uuid, text, uuid, jsonb, jsonb) to service_role;

/** The shopper closed the chat (or started a new one): returns whether it was still open. */
create or replace function public.assistant_end(p_id uuid, p_token text, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.assistant_conversations
  set ended_at = now(), end_reason = case when p_reason in ('closed', 'new') then p_reason else 'closed' end
  where id = p_id and token_hash = public.assistant_token_hash(p_token) and ended_at is null;
  return found;
end;
$$;
revoke execute on function public.assistant_end(uuid, text, text) from public, anon, authenticated;
grant execute on function public.assistant_end(uuid, text, text) to service_role;

/** Conversations without a message for p_minutes (30) end at their last message. */
create or replace function public.assistant_end_idle(p_minutes integer default 30)
returns setof uuid
language sql
volatile
security definer
set search_path = ''
as $$
  update public.assistant_conversations
  set ended_at = last_message_at, end_reason = 'idle'
  where ended_at is null
    and last_message_at < now() - make_interval(mins => greatest(coalesce(p_minutes, 30), 1))
  returning id
$$;
revoke execute on function public.assistant_end_idle(integer) from public, anon, authenticated;
grant execute on function public.assistant_end_idle(integer) to service_role;

/** Ended conversations without any message (files chosen but never sent): forgotten with their files. */
create or replace function public.assistant_empty_ended(p_limit integer default 50)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.assistant_conversations
  where ended_at is not null and message_count = 0
  order by ended_at
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
revoke execute on function public.assistant_empty_ended(integer) from public, anon, authenticated;
grant execute on function public.assistant_empty_ended(integer) to service_role;

/** Ended conversations that still need their PDF: at most 3 tries, the next one 10, 20 minutes later. */
create or replace function public.assistant_pdf_todo(p_limit integer default 3)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.assistant_conversations
  where ended_at is not null and message_count > 0 and pdf_status = 'none' and pdf_attempts < 3
    and (pdf_next_try is null or pdf_next_try <= now())
  order by ended_at
  limit least(greatest(coalesce(p_limit, 3), 1), 50)
$$;
revoke execute on function public.assistant_pdf_todo(integer) from public, anon, authenticated;
grant execute on function public.assistant_pdf_todo(integer) to service_role;

/** Everything the PDF shows: the shop, the conversation, its messages and files. */
create or replace function public.assistant_pdf_data(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'conversation', jsonb_build_object(
      'id', c.id, 'shop_id', c.shop_id, 'page_lang', c.page_lang, 'shopper_lang', c.shopper_lang,
      'started_at', c.started_at, 'ended_at', coalesce(c.ended_at, c.last_message_at), 'message_count', c.message_count),
    'shop', jsonb_build_object('name', s.name, 'logo_url', s.logo_url, 'timezone', s.timezone),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('role', m.role, 'body', m.body, 'body_owner', m.body_owner, 'lang', m.lang,
                                          'cards', m.cards, 'attachment_ids', to_jsonb(m.attachment_ids),
                                          'created_at', m.created_at) order by m.created_at, m.id)
      from public.assistant_messages m where m.conversation_id = c.id), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'bytes', a.bytes,
                                          'path', a.storage_path, 'preview_path', a.preview_path) order by a.created_at)
      from public.assistant_attachments a where a.conversation_id = c.id), '[]'::jsonb))
  from public.assistant_conversations c
  join public.shops s on s.id = c.shop_id
  where c.id = p_id
$$;
revoke execute on function public.assistant_pdf_data(uuid) from public, anon, authenticated;
grant execute on function public.assistant_pdf_data(uuid) to service_role;

/** The PDF was stored (p_error null), or making it failed (tried again later, 3 times at most). */
create or replace function public.assistant_pdf_done(p_id uuid, p_path text, p_name text, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_error is null then
    update public.assistant_conversations
    set pdf_status = 'ready', pdf_path = p_path, pdf_name = p_name, pdf_error = null, pdf_next_try = null
    where id = p_id;
  else
    update public.assistant_conversations
    set pdf_attempts = pdf_attempts + 1,
        pdf_error = left(p_error, 500),
        pdf_status = case when pdf_attempts + 1 >= 3 then 'failed' else 'none' end,
        pdf_next_try = now() + make_interval(mins => 10 * (pdf_attempts + 1))
    where id = p_id;
  end if;
end;
$$;
revoke execute on function public.assistant_pdf_done(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.assistant_pdf_done(uuid, text, text, text) to service_role;

/** Conversations past their shop's keep time (30, 90 or 365 days after the last message; 90 when not set). */
create or replace function public.assistant_expired(p_limit integer default 200)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.assistant_conversations c
  left join public.shop_assistant_settings st on st.shop_id = c.shop_id
  where c.ended_at is not null
    and c.last_message_at < now() - make_interval(days => coalesce(st.retention_days, 90))
  order by c.last_message_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;
revoke execute on function public.assistant_expired(integer) from public, anon, authenticated;
grant execute on function public.assistant_expired(integer) to service_role;

/** Every stored file of a conversation (originals, previews, PDF): deleted before the rows. */
create or replace function public.assistant_files(p_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(p), '{}') from (
    select a.storage_path as p from public.assistant_attachments a where a.conversation_id = p_id
    union all
    select a.preview_path from public.assistant_attachments a where a.conversation_id = p_id and a.preview_path is not null
    union all
    select c.pdf_path from public.assistant_conversations c where c.id = p_id and c.pdf_path is not null
  ) x
$$;
revoke execute on function public.assistant_files(uuid) from public, anon, authenticated;
grant execute on function public.assistant_files(uuid) to service_role;

/** Forgets a conversation with its messages and files (the stored files were deleted first). */
create or replace function public.assistant_forget(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.assistant_conversations where id = p_id;
  return found;
end;
$$;
revoke execute on function public.assistant_forget(uuid) from public, anon, authenticated;
grant execute on function public.assistant_forget(uuid) to service_role;

-- ------------------------------------------------------------------ owners

/** How long the shop's conversations are kept: 30, 90 or 365 days (members of the shop only). */
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
  if p_days is null or p_days not in (30, 90, 365) then
    raise exception 'retention' using errcode = '22023';
  end if;
  insert into public.shop_assistant_settings (shop_id, retention_days, updated_at)
  values (p_shop_id, p_days, now())
  on conflict (shop_id) do update set retention_days = excluded.retention_days, updated_at = now();
  return p_days;
end;
$$;
revoke execute on function public.owner_set_assistant_retention(uuid, integer) from public, anon;
grant execute on function public.owner_set_assistant_retention(uuid, integer) to authenticated, service_role;

/**
 * The owner's list: newest first; p_q = words that must all appear in the conversation (any
 * message, the shop's or the Slovak version; accents and case ignored); p_from / p_to =
 * days in the shop's time zone. Members of the shop only.
 */
create or replace function public.owner_assistant_conversations(
  p_shop_id uuid,
  p_q text default null,
  p_from date default null,
  p_to date default null,
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
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with shop as (
    select s.id, s.timezone from public.shops s
    where s.id = owner_assistant_conversations.p_shop_id and public.is_shop_member(s.id)
  )
  select c.id, c.started_at, c.ended_at, c.page_lang, c.shopper_lang, c.message_count, c.attachment_count,
         c.first_question, c.pdf_status, count(*) over ()
  from public.assistant_conversations c
  join shop on shop.id = c.shop_id
  where c.message_count > 0
    and (owner_assistant_conversations.p_from is null
         or c.started_at >= (owner_assistant_conversations.p_from::timestamp at time zone shop.timezone))
    and (owner_assistant_conversations.p_to is null
         or c.started_at < ((owner_assistant_conversations.p_to + 1)::timestamp at time zone shop.timezone))
    and (nullif(btrim(coalesce(owner_assistant_conversations.p_q, '')), '') is null
         or public.matches_all_words(public.search_text(
              (select string_agg(m.body || ' ' || coalesce(m.body_owner, ''), ' ')
               from public.assistant_messages m where m.conversation_id = c.id)),
            owner_assistant_conversations.p_q))
  order by c.started_at desc, c.id
  limit least(greatest(coalesce(owner_assistant_conversations.p_limit, 20), 1), 100)
  offset greatest(coalesce(owner_assistant_conversations.p_offset, 0), 0)
$$;
revoke execute on function public.owner_assistant_conversations(uuid, text, date, date, integer, integer) from public, anon;
grant execute on function public.owner_assistant_conversations(uuid, text, date, date, integer, integer)
  to authenticated, service_role;

-- ------------------------------------------------------------------ the jobs' secret

/** The 5-minute and daily jobs send the Vault secret ppi_assistant_cron; the function checks it here. */
create or replace function public.assistant_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ppi_assistant_cron'
      and encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex')
          = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')), false)
$$;
revoke execute on function public.assistant_cron_ok(text) from public, anon, authenticated;
grant execute on function public.assistant_cron_ok(text) to service_role;

do $$
begin
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_assistant_cron') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ppi_assistant_cron', 'PPI: the assistant archive jobs prove themselves to the assistant-archive function');
  end if;
end;
$$;

-- ------------------------------------------------------------------ storage

-- Private; no policies: only the service role (the assistant-archive function) reads and writes.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('shop-assistant-uploads', 'shop-assistant-uploads', false, 10485760,
            array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ------------------------------------------------------------------ the jobs (pg_cron + pg_net)

-- Needs the Vault secret ppi_project_url (https://<project>.supabase.co, SETUP.md part O, step 2).
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/assistant-archive',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_assistant_cron')),
      body := jsonb_build_object('action', '%s'),
      timeout_milliseconds := 60000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-assistant-tick', '*/5 * * * *', format(v_call, 'tick'));
  perform cron.schedule('ppi-assistant-retention', '17 3 * * *', format(v_call, 'retention'));
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_project_url') then
    raise notice 'The jobs need the Vault secret ppi_project_url (SETUP.md part O, step 2).';
  end if;
end;
$$;
