-- PPI · database update 65 — the shop's own "Právne informácie" (2026-11-01, at the owner's request)
--
-- Every shop (free and Pro) can publish its own legal page: on its own domain (davide.sk/pravne-informacie) and on its
-- Cacaduu address (/shops/<slug>/pravne-informacie). The shop is the one that sells and the controller of its
-- customers' data (assistant conversations, contacts, bookings), so the texts are the shop's own, written by the owner
-- in Môj obchod → "Právne informácie": an e-mail for questions about personal data, a privacy notice, terms of sale and
-- a complaints procedure. PPI never writes, edits or translates them; they are shown as written (plain text, no HTML).
-- The page also shows the company details the shop already gave (update 47/48: company name, IČO, DIČ, address).
--
--   shop_legal_pages            one row per shop; RLS: members read; no grants to write (only the function)
--   owner_save_legal_page()     members of the shop; texts ≤ 30 000 characters, the e-mail checked; activity log
--   shop_legal_page(slug)       visitors (anon): the texts of an active shop + its company details
--
-- Safe to run twice.

create table if not exists public.shop_legal_pages (
  shop_id        uuid primary key references public.shops (id) on delete cascade,
  contact_email  text check (contact_email is null or (char_length(contact_email) <= 254
                                                       and contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  privacy        text check (privacy is null or char_length(privacy) <= 30000),
  terms          text check (terms is null or char_length(terms) <= 30000),
  complaints     text check (complaints is null or char_length(complaints) <= 30000),
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
alter table public.shop_legal_pages enable row level security;
revoke all on public.shop_legal_pages from public, anon, authenticated;
grant all on public.shop_legal_pages to service_role;
grant select (shop_id, contact_email, privacy, terms, complaints, updated_at) on public.shop_legal_pages to authenticated;
drop policy if exists "shop_legal_pages: members read" on public.shop_legal_pages;
create policy "shop_legal_pages: members read" on public.shop_legal_pages
  for select to authenticated using (public.is_shop_member(shop_id));

-- the activity log's list of actions gets "legal_page_saved" (added to the list that is live, nothing else changes)
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
begin
  if v_def is not null and position('''legal_page_saved''' in v_def) = 0 then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''legal_page_saved''::text, ');
  end if;
end;
$$;

/** A text as the owner wrote it: control characters removed (new lines kept), trimmed; empty = NULL. */
create or replace function public.legal_text(p_text text, p_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(regexp_replace(replace(coalesce(p_text, ''), E'\r\n', E'\n'), E'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', 'g'));
begin
  if v = '' then return null; end if;
  if char_length(v) > p_max then raise exception 'too_long' using errcode = '22023'; end if;
  return v;
end;
$$;
revoke execute on function public.legal_text(text, integer) from public, anon, authenticated;

/** "Uložiť" in Môj obchod → Právne informácie (members of the shop; every shop). */
create or replace function public.owner_save_legal_page(
  p_shop_id uuid, p_contact_email text, p_privacy text, p_terms text, p_complaints text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email' using errcode = '22023';
  end if;
  insert into public.shop_legal_pages (shop_id, contact_email, privacy, terms, complaints, updated_at, updated_by)
  values (p_shop_id, v_email, public.legal_text(p_privacy, 30000), public.legal_text(p_terms, 30000),
          public.legal_text(p_complaints, 30000), now(), auth.uid())
  on conflict (shop_id) do update
    set contact_email = excluded.contact_email, privacy = excluded.privacy, terms = excluded.terms,
        complaints = excluded.complaints, updated_at = now(), updated_by = auth.uid();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'legal_page_saved',
          jsonb_build_object('privacy', p_privacy is not null and btrim(p_privacy) <> '',
                             'terms', p_terms is not null and btrim(p_terms) <> '',
                             'complaints', p_complaints is not null and btrim(p_complaints) <> ''));
end;
$$;
revoke execute on function public.owner_save_legal_page(uuid, text, text, text, text) from public, anon;
grant execute on function public.owner_save_legal_page(uuid, text, text, text, text) to authenticated, service_role;

/** The page for visitors: an active shop's texts and its company details (never anything else of the shop). */
create or replace function public.shop_legal_page(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select jsonb_build_object(
           'name', s.name, 'address', s.address, 'city', s.city, 'country', s.country,
           'company_name', co.company_name, 'ico', nullif(btrim(s.ico), ''), 'dic', co.dic, 'zip', co.zip,
           'contact_email', coalesce(l.contact_email, s.email),
           'privacy', l.privacy, 'terms', l.terms, 'complaints', l.complaints, 'updated_at', l.updated_at)
  from public.shops s
  left join public.shop_company co on co.shop_id = s.id
  left join public.shop_legal_pages l on l.shop_id = s.id
  where s.slug = p_slug and s.is_active
$$;
revoke execute on function public.shop_legal_page(text) from public;
grant execute on function public.shop_legal_page(text) to anon, authenticated, service_role;
