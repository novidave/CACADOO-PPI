-- PPI · database update 90 — CRM → Konverzácie: the two-pane inbox and the reply drafts (2026-11-07, the owner's request;
-- canvas "Cacaduu – webová aplikácia (Môj obchod)", artboards 8 and 8b). Nothing is deleted or changed in update 55's
-- functions (the live site and the exports keep calling owner_conversations as it is); the inbox reads a NEW function
-- with the same filters plus "Čaká" / "Rezerv." and what a row and the conversation's head show.
--
--   crm_phone_masked(phone, country)   "+421 905 ··· 418": only the calling code, the next three and the last three digits
--   owner_conversations_inbox(...)     update 55's filters + p_filter 'waiting' | 'booked'; per row the last message
--                                      (≤ 140, the owner's SK version), the next live booking, the contact's name and how
--                                      many conversations it has, the masked phone, verified or not, whether it waits,
--                                      and the caller's own draft (its beginning)
--   owner_conversations_inbox_counts   {all, waiting, booked, new} for the segmented filter
--   owner_conversation_head(id)        the open conversation's header and its event pills (only data it has)
--   owner_conversation_drafts          the reply drafts: one per conversation and owner (no grants; functions only)
--   owner_draft_save / _get / _clear   members of the conversation's shop; an empty text clears; no activity log
--
-- "Waits for an answer" (the "Čaká" filter and tag) = a callback that waits (update 59, the menu badge's rule) or the
-- assistant could not answer (update 55's `unanswered`) and nobody from the shop wrote into it since, never archived.

-- ------------------------------------------------------------------ the masked phone

create or replace function public.crm_phone_masked(p_phone text, p_country text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  cc text := coalesce(public.crm_calling_code(p_country), '');
  rest text;
begin
  if char_length(d) < 7 then return null; end if;
  if cc <> '' and d like cc || '%' and char_length(d) - char_length(cc) >= 7 then
    rest := substr(d, char_length(cc) + 1);
  else
    cc := left(d, 3);
    rest := substr(d, 4);
  end if;
  return '+' || cc || ' ' || left(rest, 3) || ' ··· ' || right(rest, 3);
end;
$$;
revoke execute on function public.crm_phone_masked(text, text) from public, anon;
grant execute on function public.crm_phone_masked(text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ drafts

create table if not exists public.owner_conversation_drafts (
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  user_id         uuid not null,
  shop_id         uuid not null references public.shops (id) on delete cascade,
  channel         text not null default 'sms' check (channel in ('sms', 'email')),
  subject         text check (subject is null or char_length(subject) <= 200),
  body            text not null default '' check (char_length(body) <= 5000),
  updated_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists owner_conversation_drafts_shop_idx on public.owner_conversation_drafts (shop_id, user_id);
alter table public.owner_conversation_drafts enable row level security;
revoke all on public.owner_conversation_drafts from public, anon, authenticated;
grant all on public.owner_conversation_drafts to service_role;

/** The conversation's shop when the caller is a member of it (else an error). */
create or replace function public.owner_draft_shop(p_conversation_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select c.shop_id into v_shop from public.assistant_conversations c where c.id = p_conversation_id;
  if v_shop is null or auth.uid() is null or not public.is_shop_member(v_shop) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  return v_shop;
end;
$$;
revoke execute on function public.owner_draft_shop(uuid) from public, anon, authenticated;
grant execute on function public.owner_draft_shop(uuid) to service_role;

/** Saves the caller's draft of a reply (text, subject, channel); an empty text and subject clear it. Returns its time. */
create or replace function public.owner_draft_save(p_conversation_id uuid, p_channel text, p_subject text, p_body text)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := public.owner_draft_shop(p_conversation_id);
  v_body text := left(coalesce(p_body, ''), 5000);
  v_subject text := nullif(left(btrim(coalesce(p_subject, '')), 200), '');
  v_at timestamptz := now();
begin
  if btrim(v_body) = '' and v_subject is null then
    delete from public.owner_conversation_drafts where conversation_id = p_conversation_id and user_id = auth.uid();
    return null;
  end if;
  insert into public.owner_conversation_drafts (conversation_id, user_id, shop_id, channel, subject, body, updated_at)
  values (p_conversation_id, auth.uid(), v_shop, case when p_channel = 'email' then 'email' else 'sms' end, v_subject, v_body, v_at)
  on conflict (conversation_id, user_id) do update
    set channel = excluded.channel, subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at;
  return v_at;
end;
$$;
revoke execute on function public.owner_draft_save(uuid, text, text, text) from public, anon;
grant execute on function public.owner_draft_save(uuid, text, text, text) to authenticated, service_role;

/** The caller's own draft of this conversation: {channel, subject, body, updated_at} or null. */
create or replace function public.owner_draft_get(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.owner_draft_shop(p_conversation_id);
  return (
    select jsonb_build_object('channel', d.channel, 'subject', d.subject, 'body', d.body, 'updated_at', d.updated_at)
    from public.owner_conversation_drafts d
    where d.conversation_id = p_conversation_id and d.user_id = auth.uid()
  );
end;
$$;
revoke execute on function public.owner_draft_get(uuid) from public, anon;
grant execute on function public.owner_draft_get(uuid) to authenticated, service_role;

/** A successful send (or the owner) clears the caller's draft. */
create or replace function public.owner_draft_clear(p_conversation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.owner_draft_shop(p_conversation_id);
  delete from public.owner_conversation_drafts where conversation_id = p_conversation_id and user_id = auth.uid();
end;
$$;
revoke execute on function public.owner_draft_clear(uuid) from public, anon;
grant execute on function public.owner_draft_clear(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ the rule "waits for an answer"

create or replace function public.crm_conversation_waiting(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select (c.callback_at is not null and c.callback_answered_at is null)
        or (c.unanswered is true and c.callback_at is null and c.status <> 'archived'
            and not exists (select 1 from public.assistant_messages m where m.conversation_id = c.id and m.role = 'owner'))
    from public.assistant_conversations c where c.id = p_conversation_id
  ), false)
$$;
revoke execute on function public.crm_conversation_waiting(uuid) from public, anon, authenticated;
grant execute on function public.crm_conversation_waiting(uuid) to service_role;

-- ------------------------------------------------------------------ the inbox's list

create or replace function public.owner_conversations_inbox(
  p_shop_id uuid,
  p_q text default null,
  p_from date default null,
  p_to date default null,
  p_status text default null,
  p_starred boolean default null,
  p_unanswered boolean default null,
  p_attachments boolean default null,
  p_lang text default null,
  p_filter text default null,
  p_limit integer default 30,
  p_offset integer default 0
)
returns table (
  id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  last_at timestamptz,
  page_lang text,
  shopper_lang text,
  message_count integer,
  attachment_count integer,
  first_question text,
  pdf_status text,
  export_status text,
  shopper_deleted_at timestamptz,
  status text,
  starred boolean,
  unanswered boolean,
  waiting boolean,
  last_text text,
  last_role text,
  next_booking_at timestamptz,
  contact_id uuid,
  contact_name text,
  contact_conversations integer,
  phone_masked text,
  phone_verified boolean,
  draft_text text,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with shop as (
    select s.id, s.timezone, s.country from public.shops s
    where s.id = owner_conversations_inbox.p_shop_id and public.is_shop_member(s.id)
  ),
  rows as (
    select c.*, shop.country as shop_country, public.crm_conversation_waiting(c.id) as is_waiting
    from public.assistant_conversations c
    join shop on shop.id = c.shop_id
    where (c.message_count > 0 or c.shopper_deleted_at is not null)
      and case coalesce(owner_conversations_inbox.p_status, '')
            when '' then c.status <> 'archived'
            when 'all' then true
            else c.status = owner_conversations_inbox.p_status end
      and (owner_conversations_inbox.p_starred is not true or c.starred)
      and (owner_conversations_inbox.p_unanswered is not true or c.unanswered)
      and (owner_conversations_inbox.p_attachments is not true or c.attachment_count > 0)
      and (nullif(owner_conversations_inbox.p_lang, '') is null
           or coalesce(c.shopper_lang, c.page_lang) = owner_conversations_inbox.p_lang)
      and (owner_conversations_inbox.p_from is null
           or c.started_at >= (owner_conversations_inbox.p_from::timestamp at time zone shop.timezone))
      and (owner_conversations_inbox.p_to is null
           or c.started_at < ((owner_conversations_inbox.p_to + 1)::timestamp at time zone shop.timezone))
      and (nullif(btrim(coalesce(owner_conversations_inbox.p_q, '')), '') is null
           or public.matches_all_words(concat_ws(' ', c.search_doc, public.search_text(c.owner_note)),
                                       owner_conversations_inbox.p_q))
      and (coalesce(owner_conversations_inbox.p_filter, '') <> 'booked'
           or exists (select 1 from public.shop_bookings b
                      where b.conversation_id = c.id and b.status not in ('cancelled', 'expired')))
  )
  select r.id, r.started_at, r.ended_at, r.last_message_at, r.page_lang, r.shopper_lang, r.message_count,
         r.attachment_count, r.first_question, r.pdf_status, r.export_status, r.shopper_deleted_at, r.status, r.starred,
         r.unanswered, r.is_waiting,
         lm.text, lm.role,
         (select min(b.starts_at) from public.shop_bookings b
          where b.shop_id = r.shop_id and b.status in ('pending', 'confirmed') and b.starts_at > now()
            and (b.conversation_id = r.id or (r.contact_id is not null and b.contact_id = r.contact_id))),
         r.contact_id, k.name,
         case when r.contact_id is null then 0
              else (select count(*)::integer from public.assistant_conversations o
                    where o.shop_id = r.shop_id and o.contact_id = r.contact_id and o.message_count > 0) end,
         public.crm_phone_masked(coalesce(k.phone, r.shopper_phone), r.shop_country),
         k.phone_verified_at is not null,
         (select left(d.body, 120) from public.owner_conversation_drafts d
          where d.conversation_id = r.id and d.user_id = auth.uid() and btrim(d.body) <> ''),
         count(*) over ()
  from rows r
  left join public.shop_contacts k on k.id = r.contact_id
  left join lateral (
    select left(regexp_replace(coalesce(m.body_owner, m.body), '\s+', ' ', 'g'), 140) as text, m.role
    from public.assistant_messages m where m.conversation_id = r.id order by m.id desc limit 1
  ) lm on true
  where coalesce(owner_conversations_inbox.p_filter, '') <> 'waiting' or r.is_waiting
  order by r.last_message_at desc, r.id
  limit least(greatest(coalesce(owner_conversations_inbox.p_limit, 30), 1), 300)
  offset greatest(coalesce(owner_conversations_inbox.p_offset, 0), 0)
$$;
revoke execute on function public.owner_conversations_inbox(uuid, text, date, date, text, boolean, boolean, boolean, text, text, integer, integer)
  from public, anon;
grant execute on function public.owner_conversations_inbox(uuid, text, date, date, text, boolean, boolean, boolean, text, text, integer, integer)
  to authenticated, service_role;

/** The segmented filter's numbers: {all, waiting, booked, new} (not archived). Members only. */
create or replace function public.owner_conversations_inbox_counts(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not a member of this shop' using errcode = '42501'; end if;
  return (
    select jsonb_build_object(
      'all', count(*),
      'waiting', count(*) filter (where public.crm_conversation_waiting(c.id)),
      'booked', count(*) filter (where exists (select 1 from public.shop_bookings b
                                               where b.conversation_id = c.id and b.status not in ('cancelled', 'expired'))),
      'new', count(*) filter (where c.status = 'new'))
    from public.assistant_conversations c
    where c.shop_id = p_shop_id and c.message_count > 0 and c.status <> 'archived'
  );
end;
$$;
revoke execute on function public.owner_conversations_inbox_counts(uuid) from public, anon;
grant execute on function public.owner_conversations_inbox_counts(uuid) to authenticated, service_role;

/**
 * The open conversation's header and event pills (only data the conversation has): the contact (name, masked phone,
 * verified, how many conversations, has phone / e-mail for the reply's channels), whether it waits, the next live
 * booking, and the events — the shopper left a contact (update 59), bookings made in it, food orders placed in it, a
 * non-public document used (update 55, no time of its own). Members only.
 */
create or replace function public.owner_conversation_head(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.assistant_conversations%rowtype;
  k public.shop_contacts%rowtype;
  v_country text;
begin
  select * into c from public.assistant_conversations where id = p_conversation_id;
  if not found or not public.is_shop_member(c.shop_id) then raise exception 'Not a member of this shop' using errcode = '42501'; end if;
  select s.country into v_country from public.shops s where s.id = c.shop_id;
  if c.contact_id is not null then select * into k from public.shop_contacts where id = c.contact_id; end if;
  return jsonb_build_object(
    'contact_id', c.contact_id,
    'contact_name', k.name,
    'phone_masked', public.crm_phone_masked(coalesce(k.phone, c.shopper_phone), v_country),
    'phone_verified', k.phone_verified_at is not null,
    'has_phone', k.phone is not null,
    'has_email', k.email is not null,
    'contact_conversations', case when c.contact_id is null then 0
      else (select count(*) from public.assistant_conversations o
            where o.shop_id = c.shop_id and o.contact_id = c.contact_id and o.message_count > 0) end,
    'waiting', public.crm_conversation_waiting(c.id),
    'next_booking_at', (select min(b.starts_at) from public.shop_bookings b
                        where b.shop_id = c.shop_id and b.status in ('pending', 'confirmed') and b.starts_at > now()
                          and (b.conversation_id = c.id or (c.contact_id is not null and b.contact_id = c.contact_id))),
    'events', coalesce((
      select jsonb_agg(e order by e ->> 'at') from (
        select jsonb_build_object('kind', 'contact_left', 'at', c.callback_at) as e where c.callback_at is not null
        union all
        select jsonb_build_object('kind', case when b.status = 'confirmed' then 'booking_confirmed' else 'booking_made' end,
                                  'at', coalesce(b.confirmed_at, b.created_at), 'starts_at', b.starts_at)
        from public.shop_bookings b where b.conversation_id = c.id and b.status in ('pending', 'confirmed', 'no_show')
        union all
        select jsonb_build_object('kind', 'food_order', 'at', o.created_at, 'number', o.number)
        from public.food_orders o where o.conversation_id = c.id
      ) x), '[]'::jsonb),
    'access_key_used', coalesce(c.access_key_used, false)
  );
end;
$$;
revoke execute on function public.owner_conversation_head(uuid) from public, anon;
grant execute on function public.owner_conversation_head(uuid) to authenticated, service_role;
