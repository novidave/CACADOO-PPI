-- =====================================================================================================================
-- Update 56 — "Kontakty" for Pro shops (2026-10-30, at the owner's request; phase 2 of the CRM work)
--
-- Paste the whole file into Supabase → SQL Editor and run it. Running it again changes nothing.
--
-- 1. The shop's contacts: name, phone (E.164, one contact per number and shop, "overené" only when the system checked
--    it — the booking's SMS code, phase 3), e-mail, address, tags, a note. Owners read their shop's contacts; every
--    change goes through the owner_* functions (members of the shop, the paid plan for changes) and the activity log.
-- 2. Conversations and (phase 3) bookings belong to a contact through the phone: a conversation with the shopper's
--    phone (filled from phase 3 / 5 on) joins the contact with that number; the owner can also link one by hand.
-- 3. E-mail templates (name, subject, text with {{name}}, {{first_name}}, {{shop}}, {{shop_phone}}, {{shop_email}},
--    {{shop_address}}, {{shop_web}}).
-- 4. Every outgoing SMS and e-mail is written down (shop_outgoing_messages: to whom, the text as sent, the status, who
--    sent it). The crm-messages Edge Function sends them; nothing is sent from the database.
-- =====================================================================================================================

-- ------------------------------------------------------------------ phone numbers

/** The country calling code of a country (ISO 3166-1 alpha-2); null for a country not in the list. */
create or replace function public.crm_calling_code(p_country text)
returns text
language sql
immutable
set search_path = ''
as $$
  select code from (values
    ('AL','355'),('AT','43'),('BA','387'),('BE','32'),('BG','359'),('CH','41'),('CY','357'),('CZ','420'),('DE','49'),
    ('DK','45'),('EE','372'),('ES','34'),('FI','358'),('FR','33'),('GB','44'),('GR','30'),('HR','385'),('HU','36'),
    ('IE','353'),('IS','354'),('IT','39'),('LI','423'),('LT','370'),('LU','352'),('LV','371'),('MD','373'),('ME','382'),
    ('MK','389'),('MT','356'),('NL','31'),('NO','47'),('PL','48'),('PT','351'),('RO','40'),('RS','381'),('SE','46'),
    ('SI','386'),('SK','421'),('SM','378'),('TR','90'),('UA','380'),('VA','39'),('XK','383')
  ) as c(country, code)
  where country = upper(p_country)
$$;

/**
 * A phone number as E.164 ("+421905123456"): spaces, dots, dashes, slashes and brackets dropped; "00…" and "+…" are
 * international; a national number (trunk "0", in Hungary "06"; Italy, San Marino and the Vatican keep their 0) gets
 * the shop's country code. null when it cannot be one (too short, letters, no country for a national number).
 */
create or replace function public.crm_phone(p_raw text, p_country text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := regexp_replace(coalesce(p_raw, ''), '[\s.()/\-]', '', 'g');
  v_code text := public.crm_calling_code(p_country);
  v_country text := upper(coalesce(p_country, ''));
begin
  if v = '' then return null; end if;
  if v ~ '^00' then v := '+' || substr(v, 3); end if;
  if v !~ '^\+' then
    if v !~ '^[0-9]+$' or v_code is null then return null; end if;
    if v_country = 'HU' and v ~ '^06' then v := substr(v, 3);
    elsif v_country not in ('IT', 'SM', 'VA') and v ~ '^0' then v := substr(v, 2);
    end if;
    v := '+' || v_code || v;
  end if;
  return case when v ~ '^\+[1-9][0-9]{6,14}$' then v end;
end;
$$;
grant execute on function public.crm_calling_code(text), public.crm_phone(text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ 1. contacts

create table if not exists public.shop_contacts (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops (id) on delete cascade,
  name              text check (name is null or char_length(name) <= 120),
  phone             text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- set only by the system when the number was checked with an SMS code (phase 3); a changed number is unchecked again
  phone_verified_at timestamptz,
  email             text check (email is null or (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  address           text check (address is null or char_length(address) <= 300),
  tags              text[] not null default '{}' check (cardinality(tags) <= 20),
  note              text check (note is null or char_length(note) <= 4000),
  source            text not null default 'owner' check (source in ('owner', 'chat', 'booking')),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint shop_contacts_something check (coalesce(name, phone, email) is not null)
);
create unique index if not exists shop_contacts_phone_key on public.shop_contacts (shop_id, phone) where phone is not null;
create index if not exists shop_contacts_shop_idx on public.shop_contacts (shop_id, updated_at desc);

alter table public.shop_contacts enable row level security;
revoke all on public.shop_contacts from public, anon, authenticated;
grant all on public.shop_contacts to service_role;
grant select on public.shop_contacts to authenticated;
drop policy if exists "shop_contacts: members read" on public.shop_contacts;
create policy "shop_contacts: members read" on public.shop_contacts
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ 2. conversations belong to a contact

alter table public.assistant_conversations
  add column if not exists contact_id uuid references public.shop_contacts (id) on delete set null,
  -- the shopper's phone as E.164 when the system got it (the booking's SMS code, phase 3; "leave a number", phase 5)
  add column if not exists shopper_phone text check (shopper_phone is null or shopper_phone ~ '^\+[1-9][0-9]{6,14}$');
create index if not exists assistant_conversations_contact_idx on public.assistant_conversations (contact_id, started_at desc);
create index if not exists assistant_conversations_phone_idx on public.assistant_conversations (shop_id, shopper_phone)
  where shopper_phone is not null;
grant select (contact_id, shopper_phone) on public.assistant_conversations to authenticated;

/** A contact's number joins every conversation of the shop with that number that has no contact yet. */
create or replace function public.crm_contact_phone_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.phone is not null and (tg_op = 'INSERT' or new.phone is distinct from old.phone) then
    update public.assistant_conversations
    set contact_id = new.id
    where shop_id = new.shop_id and shopper_phone = new.phone and contact_id is null;
  end if;
  return new;
end;
$$;
drop trigger if exists shop_contacts_phone_link on public.shop_contacts;
create trigger shop_contacts_phone_link after insert or update of phone on public.shop_contacts
  for each row execute function public.crm_contact_phone_link();

/** A conversation that gets the shopper's phone joins the contact with that number (if any). */
create or replace function public.crm_conversation_phone_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shopper_phone is not null and new.contact_id is null then
    new.contact_id := (select c.id from public.shop_contacts c where c.shop_id = new.shop_id and c.phone = new.shopper_phone);
  end if;
  return new;
end;
$$;
drop trigger if exists assistant_conversations_phone_link on public.assistant_conversations;
create trigger assistant_conversations_phone_link before insert or update of shopper_phone on public.assistant_conversations
  for each row execute function public.crm_conversation_phone_link();

-- ------------------------------------------------------------------ 3. e-mail templates

create table if not exists public.shop_email_templates (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  subject    text not null check (char_length(btrim(subject)) between 1 and 200),
  body       text not null check (char_length(btrim(body)) between 1 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shop_email_templates_name_key on public.shop_email_templates (shop_id, lower(name));
alter table public.shop_email_templates enable row level security;
revoke all on public.shop_email_templates from public, anon, authenticated;
grant all on public.shop_email_templates to service_role;
grant select on public.shop_email_templates to authenticated;
drop policy if exists "shop_email_templates: members read" on public.shop_email_templates;
create policy "shop_email_templates: members read" on public.shop_email_templates
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ 4. every outgoing message

create table if not exists public.shop_outgoing_messages (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops (id) on delete cascade,
  contact_id   uuid references public.shop_contacts (id) on delete set null,
  channel      text not null check (channel in ('sms', 'email')),
  -- the number or address it went to (kept when the contact is deleted: the log stays complete)
  recipient    text not null,
  subject      text,
  body         text not null,
  template_id  uuid references public.shop_email_templates (id) on delete set null,
  -- queued → sent | failed; test = an SMS while no SMS provider is connected (written down, not sent)
  status       text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'test')),
  provider     text,
  provider_ref text,
  error        text,
  sent_by      uuid,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists shop_outgoing_messages_shop_idx on public.shop_outgoing_messages (shop_id, created_at desc);
create index if not exists shop_outgoing_messages_contact_idx on public.shop_outgoing_messages (contact_id, created_at desc);
alter table public.shop_outgoing_messages enable row level security;
revoke all on public.shop_outgoing_messages from public, anon, authenticated;
grant all on public.shop_outgoing_messages to service_role;
grant select on public.shop_outgoing_messages to authenticated;
drop policy if exists "shop_outgoing_messages: members read" on public.shop_outgoing_messages;
create policy "shop_outgoing_messages: members read" on public.shop_outgoing_messages
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ the activity log's new actions

alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted',
                    'inventory_api_connected', 'inventory_api_key_changed', 'inventory_api_approved',
                    'inventory_api_error', 'inventory_api_recovered', 'inventory_api_disconnected',
                    'connector_paired', 'connector_revoked', 'stock_source_changed', 'connector_snapshot_held',
                    'connector_snapshot_approved', 'connector_snapshot_discarded', 'connector_sync_requested',
                    'conversation_retention', 'conversations_marked', 'conversation_note', 'conversations_deleted',
                    'conversations_exported',
                    'contact_saved', 'contact_deleted', 'contact_linked', 'email_template_saved',
                    'email_template_deleted', 'message_sent'));

-- ------------------------------------------------------------------ the owner's functions

/** Members of the shop with the paid plan may change contacts, templates and send messages. */
create or replace function public.crm_owner_check(p_shop_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
end;
$$;
revoke execute on function public.crm_owner_check(uuid) from public, anon;
grant execute on function public.crm_owner_check(uuid) to authenticated, service_role;

/** Tags as the owner typed them: trimmed, ≤ 40 characters, no empties, each once (case ignored), at most 20. */
create or replace function public.crm_tags(p_tags text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(t order by n), '{}')
  from (select distinct on (lower(t)) t, n
        from (select left(btrim(x), 40) as t, n from unnest(coalesce(p_tags, '{}')) with ordinality as u(x, n)) y
        where t <> ''
        order by lower(t), n) z
  where n is not null
$$;

/**
 * "Kontakty": the shop's contacts, last changed first. p_q = words that must all appear (name, phone, e-mail, address,
 * tags, note; accents ignored; a phone number also matches written with spaces), p_tag = one tag. Members only.
 */
create or replace function public.owner_contacts(
  p_shop_id uuid, p_q text default null, p_tag text default null, p_limit integer default 50, p_offset integer default 0
)
returns table (
  id uuid, name text, phone text, phone_verified boolean, email text, tags text[], source text, updated_at timestamptz,
  conversation_count integer, message_count integer, last_message_at timestamptz, total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name, c.phone, c.phone_verified_at is not null, c.email, c.tags, c.source, c.updated_at,
         (select count(*)::integer from public.assistant_conversations a where a.contact_id = c.id),
         (select count(*)::integer from public.shop_outgoing_messages m where m.contact_id = c.id),
         (select max(m.created_at) from public.shop_outgoing_messages m where m.contact_id = c.id),
         count(*) over ()
  from public.shop_contacts c
  where c.shop_id = p_shop_id and public.is_shop_member(p_shop_id)
    and (nullif(btrim(coalesce(p_tag, '')), '') is null or lower(p_tag) = any (select lower(t) from unnest(c.tags) t))
    and (nullif(btrim(coalesce(p_q, '')), '') is null
         or public.matches_all_words(public.search_text(concat_ws(' ', c.name, c.phone, c.email, c.address,
                                                                   array_to_string(c.tags, ' '), c.note)), p_q)
         or (regexp_replace(p_q, '[^0-9]', '', 'g') ~ '^[0-9]{4,}$'
             and c.phone like '%' || regexp_replace(regexp_replace(p_q, '[^0-9]', '', 'g'), '^0+', '') || '%'))
  order by c.updated_at desc, c.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke execute on function public.owner_contacts(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.owner_contacts(uuid, text, text, integer, integer) to authenticated, service_role;

/** The tags the shop uses, most used first (the filter). Members only. */
create or replace function public.owner_contact_tags(p_shop_id uuid)
returns table (tag text, contacts bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select min(t), count(*)
  from public.shop_contacts c, unnest(c.tags) t
  where c.shop_id = p_shop_id and public.is_shop_member(p_shop_id)
  group by lower(t)
  order by 2 desc, 1
$$;
revoke execute on function public.owner_contact_tags(uuid) from public, anon;
grant execute on function public.owner_contact_tags(uuid) to authenticated, service_role;

/**
 * Saves a contact (p_id null = a new one) and returns its id. The phone is made E.164 with the shop's country
 * ('phone' when it cannot be; 'phone_taken' when another contact of the shop has it); a changed number is no longer
 * "overené". p_conversation_id: a conversation of the same shop to link right away ("Nový kontakt z konverzácie").
 */
create or replace function public.owner_save_contact(
  p_shop_id uuid, p_id uuid, p_name text, p_phone text, p_email text, p_address text, p_tags text[], p_note text,
  p_conversation_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_country text;
  v_phone text;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_id uuid;
  v_old public.shop_contacts%rowtype;
begin
  perform public.crm_owner_check(p_shop_id);
  select country into v_country from public.shops where id = p_shop_id;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    v_phone := public.crm_phone(p_phone, v_country);
    if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email' using errcode = '22023';
  end if;
  if coalesce(v_name, v_phone, v_email) is null then raise exception 'empty' using errcode = '22023'; end if;
  if exists (select 1 from public.shop_contacts c where c.shop_id = p_shop_id and c.phone = v_phone
             and c.id is distinct from p_id) then
    raise exception 'phone_taken' using errcode = '23505';
  end if;
  if p_id is null then
    insert into public.shop_contacts (shop_id, name, phone, email, address, tags, note, created_by)
    values (p_shop_id, left(v_name, 120), v_phone, v_email, left(nullif(btrim(coalesce(p_address, '')), ''), 300),
            public.crm_tags(p_tags), left(nullif(btrim(coalesce(p_note, '')), ''), 4000), auth.uid())
    returning id into v_id;
  else
    select * into v_old from public.shop_contacts where id = p_id and shop_id = p_shop_id for update;
    if not found then raise exception 'Not your shop' using errcode = '42501'; end if;
    update public.shop_contacts
    set name = left(v_name, 120), phone = v_phone, email = v_email,
        address = left(nullif(btrim(coalesce(p_address, '')), ''), 300), tags = public.crm_tags(p_tags),
        note = left(nullif(btrim(coalesce(p_note, '')), ''), 4000),
        phone_verified_at = case when v_phone is not distinct from v_old.phone then v_old.phone_verified_at end,
        updated_at = now()
    where id = p_id
    returning id into v_id;
  end if;
  if p_conversation_id is not null then
    update public.assistant_conversations set contact_id = v_id where id = p_conversation_id and shop_id = p_shop_id;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'contact_saved', jsonb_build_object('contact_id', v_id, 'created', p_id is null));
  return v_id;
end;
$$;
revoke execute on function public.owner_save_contact(uuid, uuid, text, text, text, text, text[], text, uuid) from public, anon;
grant execute on function public.owner_save_contact(uuid, uuid, text, text, text, text, text[], text, uuid) to authenticated, service_role;

/** Deletes a contact; its conversations stay (without the contact), the message log keeps its lines. Members only. */
create or replace function public.owner_delete_contact(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select shop_id from public.shop_contacts where id = p_id);
begin
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  delete from public.shop_contacts where id = p_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop, auth.uid(), 'contact_deleted', jsonb_build_object('contact_id', p_id));
  return true;
end;
$$;
revoke execute on function public.owner_delete_contact(uuid) from public, anon;
grant execute on function public.owner_delete_contact(uuid) to authenticated, service_role;

/** Links a conversation to a contact of the same shop (p_contact_id null = unlinks). Members with the plan. */
create or replace function public.owner_link_conversation(p_conversation_id uuid, p_contact_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select shop_id from public.assistant_conversations where id = p_conversation_id);
begin
  if v_shop is null then raise exception 'Not your shop' using errcode = '42501'; end if;
  perform public.crm_owner_check(v_shop);
  if p_contact_id is not null and not exists (select 1 from public.shop_contacts where id = p_contact_id and shop_id = v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.assistant_conversations set contact_id = p_contact_id where id = p_conversation_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop, auth.uid(), 'contact_linked', jsonb_build_object('conversation_id', p_conversation_id, 'contact_id', p_contact_id));
  return true;
end;
$$;
revoke execute on function public.owner_link_conversation(uuid, uuid) from public, anon;
grant execute on function public.owner_link_conversation(uuid, uuid) to authenticated, service_role;

/** Saves an e-mail template (p_id null = new; at most 50 per shop; the name once per shop) and returns its id. */
create or replace function public.owner_save_email_template(p_shop_id uuid, p_id uuid, p_name text, p_subject text, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.crm_owner_check(p_shop_id);
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80
     or char_length(btrim(coalesce(p_subject, ''))) not between 1 and 200
     or char_length(btrim(coalesce(p_body, ''))) not between 1 and 10000 then
    raise exception 'template' using errcode = '22023';
  end if;
  if exists (select 1 from public.shop_email_templates t where t.shop_id = p_shop_id
             and lower(t.name) = lower(btrim(p_name)) and t.id is distinct from p_id) then
    raise exception 'template_name' using errcode = '23505';
  end if;
  if p_id is null then
    if (select count(*) from public.shop_email_templates where shop_id = p_shop_id) >= 50 then
      raise exception 'template_limit' using errcode = '54000';
    end if;
    insert into public.shop_email_templates (shop_id, name, subject, body)
    values (p_shop_id, btrim(p_name), btrim(p_subject), btrim(p_body))
    returning id into v_id;
  else
    update public.shop_email_templates
    set name = btrim(p_name), subject = btrim(p_subject), body = btrim(p_body), updated_at = now()
    where id = p_id and shop_id = p_shop_id
    returning id into v_id;
    if v_id is null then raise exception 'Not your shop' using errcode = '42501'; end if;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'email_template_saved', jsonb_build_object('template_id', v_id, 'created', p_id is null));
  return v_id;
end;
$$;
revoke execute on function public.owner_save_email_template(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.owner_save_email_template(uuid, uuid, text, text, text) to authenticated, service_role;

create or replace function public.owner_delete_email_template(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select shop_id from public.shop_email_templates where id = p_id);
begin
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  delete from public.shop_email_templates where id = p_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop, auth.uid(), 'email_template_deleted', jsonb_build_object('template_id', p_id));
  return true;
end;
$$;
revoke execute on function public.owner_delete_email_template(uuid) from public, anon;
grant execute on function public.owner_delete_email_template(uuid) to authenticated, service_role;

/**
 * A text with the variables filled in for a contact of a shop: {{name}}, {{first_name}}, {{shop}}, {{shop_phone}},
 * {{shop_email}}, {{shop_address}}, {{shop_web}} (spaces inside the braces allowed, case ignored). A missing value is
 * left empty; any other {{…}} stays as written.
 */
create or replace function public.crm_render(p_text text, p_contact_id uuid, p_shop_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contact public.shop_contacts%rowtype;
  v_shop public.shops%rowtype;
  v text := coalesce(p_text, '');
  v_pair record;
begin
  select * into v_contact from public.shop_contacts where id = p_contact_id and shop_id = p_shop_id;
  select * into v_shop from public.shops where id = p_shop_id;
  for v_pair in
    select * from (values
      ('name', coalesce(v_contact.name, '')),
      ('first_name', coalesce(split_part(btrim(v_contact.name), ' ', 1), '')),
      ('shop', coalesce(v_shop.name, '')),
      ('shop_phone', coalesce(v_shop.phone, '')),
      ('shop_email', coalesce(v_shop.email, '')),
      ('shop_address', concat_ws(', ', nullif(v_shop.address, ''), nullif(v_shop.city, ''))),
      ('shop_web', coalesce(v_shop.website, ''))
    ) as p(k, val)
  loop
    v := regexp_replace(v, '\{\{\s*' || v_pair.k || '\s*\}\}', replace(v_pair.val, '\', '\\'), 'gi');
  end loop;
  return v;
end;
$$;
revoke execute on function public.crm_render(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.crm_render(text, uuid, uuid) to service_role;

/** The message to a contact as it would go (variables filled in), checked like a real one: the base of both functions. */
create or replace function public.crm_message_draft(
  p_contact_id uuid, p_channel text, p_template_id uuid, p_subject text, p_body text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contact public.shop_contacts%rowtype;
  v_template public.shop_email_templates%rowtype;
  v_subject text;
  v_body text;
  v_to text;
begin
  select * into v_contact from public.shop_contacts where id = p_contact_id;
  if not found then raise exception 'Not your shop' using errcode = '42501'; end if;
  perform public.crm_owner_check(v_contact.shop_id);
  if p_channel is null or p_channel not in ('sms', 'email') then raise exception 'channel' using errcode = '22023'; end if;
  if p_template_id is not null then
    select * into v_template from public.shop_email_templates where id = p_template_id and shop_id = v_contact.shop_id;
    if not found then raise exception 'Not your shop' using errcode = '42501'; end if;
  end if;
  v_to := case p_channel when 'sms' then v_contact.phone else v_contact.email end;
  if v_to is null then raise exception 'no_recipient' using errcode = '22023'; end if;
  v_body := btrim(coalesce(nullif(btrim(coalesce(p_body, '')), ''), v_template.body, ''));
  v_subject := btrim(coalesce(nullif(btrim(coalesce(p_subject, '')), ''), v_template.subject, ''));
  if v_body = '' then raise exception 'empty' using errcode = '22023'; end if;
  if p_channel = 'email' and v_subject = '' then raise exception 'subject' using errcode = '22023'; end if;
  v_body := public.crm_render(v_body, v_contact.id, v_contact.shop_id);
  v_subject := public.crm_render(v_subject, v_contact.id, v_contact.shop_id);
  if p_channel = 'sms' and char_length(v_body) > 480 then raise exception 'too_long' using errcode = '22023'; end if;
  if p_channel = 'email' and (char_length(v_body) > 10000 or char_length(v_subject) > 200) then
    raise exception 'too_long' using errcode = '22023';
  end if;
  return jsonb_build_object('shop_id', v_contact.shop_id, 'contact_id', v_contact.id, 'channel', p_channel,
                            'recipient', v_to, 'subject', case when p_channel = 'email' then v_subject end,
                            'body', v_body, 'template_id', p_template_id);
end;
$$;
revoke execute on function public.crm_message_draft(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.crm_message_draft(uuid, text, uuid, text, text) to authenticated, service_role;

/** "Náhľad": the message as it would go, nothing written. Members of the shop with the plan. */
create or replace function public.owner_message_preview(
  p_contact_id uuid, p_channel text, p_template_id uuid default null, p_subject text default null, p_body text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.crm_message_draft(p_contact_id, p_channel, p_template_id, p_subject, p_body) - 'shop_id'
$$;
revoke execute on function public.owner_message_preview(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.owner_message_preview(uuid, text, uuid, text, text) to authenticated, service_role;

/**
 * "Odoslať": writes the message down as queued (the crm-messages function then sends it and reports the result) and
 * returns it with what the sender needs (the shop's name and e-mail for "reply to"). At most 100 messages per channel
 * and shop in 24 hours (the monthly SMS quotas come in phase 4). Members of the shop with the plan.
 */
create or replace function public.owner_message_queue(
  p_contact_id uuid, p_channel text, p_template_id uuid default null, p_subject text default null, p_body text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_draft jsonb := public.crm_message_draft(p_contact_id, p_channel, p_template_id, p_subject, p_body);
  v_shop uuid := (v_draft ->> 'shop_id')::uuid;
  v_id uuid;
begin
  if (select count(*) from public.shop_outgoing_messages
      where shop_id = v_shop and channel = p_channel and created_at > now() - interval '24 hours') >= 100 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, subject, body, template_id, sent_by)
  values (v_shop, p_contact_id, p_channel, v_draft ->> 'recipient', v_draft ->> 'subject', v_draft ->> 'body',
          p_template_id, auth.uid())
  returning id into v_id;
  return (v_draft - 'shop_id') || jsonb_build_object('id', v_id, 'shop_name', (select name from public.shops where id = v_shop),
                                                     'reply_to', (select email from public.shops where id = v_shop));
end;
$$;
revoke execute on function public.owner_message_queue(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.owner_message_queue(uuid, text, uuid, text, text) to authenticated, service_role;

/** The crm-messages function reports what happened to a queued message (once). Service role only. */
create or replace function public.crm_message_result(p_id uuid, p_status text, p_provider text, p_ref text, p_error text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_outgoing_messages%rowtype;
begin
  if p_status not in ('sent', 'failed', 'test') then raise exception 'status' using errcode = '22023'; end if;
  update public.shop_outgoing_messages
  set status = p_status, provider = left(p_provider, 40), provider_ref = left(p_ref, 200), error = left(p_error, 500),
      sent_at = case when p_status = 'sent' then now() end
  where id = p_id and status = 'queued'
  returning * into v;
  if not found then return false; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, v.sent_by, 'message_sent',
          jsonb_build_object('message_id', v.id, 'channel', v.channel, 'status', p_status, 'contact_id', v.contact_id));
  return true;
end;
$$;
revoke execute on function public.crm_message_result(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.crm_message_result(uuid, text, text, text, text) to service_role;
