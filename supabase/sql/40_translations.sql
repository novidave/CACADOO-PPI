-- PPI · 40 · Translations: every European language (+ Chinese and Vietnamese), the interface texts, the shops'
-- content, product descriptions, translations per product, two-language stock files, the shop's languages.
--
--  - languages: which languages the website is shown in (the admin switches each on or off) and which are
--    pre-translated for search engines (hreflang, sitemap); site_languages() is the only public read
--  - ui_translations: the interface texts in the languages that are not written by hand in the repository
--    (sk, hu, en are; Slovak is the source). Made by Claude in the admin's step "Preložiť chýbajúce texty", edited
--    and checked in "Admin → Preklady rozhrania"; ui_messages(lang) is the public read
--  - content_translations: the shops' own content in other languages — never the original, which stays as the shop
--    wrote it. status 'shop' (from the shop's stock file), 'ai' (Claude), 'manual' (the owner), 'none' ("Neprekladať");
--    source_hash says from which text it was made: a changed source makes an AI translation "zastaraný" (it is made
--    again), a shop or manual one is never overwritten. Item names keep shop_items.name_i18n as their search copy
--  - item_descriptions: "Popis (Cacaduu)" — the AI's draft from the shop's own data only, approved by the owner
--  - shop_language_settings: Hlavný jazyk obchodu, Jazyky inventára, Preferované jazyky stránky (limit per plan),
--    Predvolený jazyk na vlastnej doméne, Zverejniť vygenerované popisy automaticky
--  - translation_limits / translation_usage: the admin's limits per plan and the monthly AI cost (alert at 80 %)
--  - translate Edge Function (service role) reads translation_work() and writes apply_translations();
--    visitors only ask for a language (request_translation()), never write a text
--  - stock files: description and category columns, a language per text column (option A) and a second file per
--    language matched by Kód, then EAN (option B; apply_shop_translations())
-- Run once in the SQL Editor (after update 39).

-- ------------------------------------------------------------------ 0. language codes everywhere

-- A language code of the website: "sk", "de", "sr-cyrl", "zh-hans", "zh-hant".
create or replace function public.valid_lang(p_lang text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_lang ~ '^[a-z]{2}(-(cyrl|hans|hant))?$', false)
$$;
grant execute on function public.valid_lang(text) to anon, authenticated, service_role;

alter table public.shop_items drop constraint if exists shop_items_name_lang_check;
alter table public.shop_items add constraint shop_items_name_lang_check check (name_lang is null or public.valid_lang(name_lang));
alter table public.shop_page_sections drop constraint if exists shop_page_sections_lang_check;
alter table public.shop_page_sections add constraint shop_page_sections_lang_check check (lang is null or public.valid_lang(lang));
alter table public.profiles drop constraint if exists profiles_language_check;
alter table public.profiles add constraint profiles_language_check check (public.valid_lang(language));

-- The stock file's description and category (mapping fields "description", "category"), as the shop wrote them.
alter table public.shop_items add column if not exists description text check (description is null or char_length(description) <= 5000);
alter table public.shop_items add column if not exists category text check (category is null or char_length(category) <= 200);

-- The encoding of the shop's stock file the owner chose in the preview (stock-pull reads it; null = detected).
alter table public.sync_sources add column if not exists file_encoding text
  check (file_encoding is null or file_encoding in ('utf-8', 'utf-16le', 'utf-16be', 'windows-1250', 'windows-1252', 'windows-1258', 'gb18030', 'big5'));

-- The language a new account chose at signup (its e-mails are in it): raw_user_meta_data.lang.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name, language)
  values (
    new.id,
    new.raw_user_meta_data ->> 'display_name',
    case when public.valid_lang(new.raw_user_meta_data ->> 'lang') then new.raw_user_meta_data ->> 'lang' else 'sk' end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- The logged-in user's language (e-mails, Môj obchod).
create or replace function public.set_my_language(p_lang text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Log in first' using errcode = '42501';
  end if;
  if not public.valid_lang(p_lang) then
    raise exception 'Unknown language' using errcode = '22023';
  end if;
  update public.profiles set language = p_lang where user_id = auth.uid();
end;
$$;
revoke execute on function public.set_my_language(text) from public, anon;
grant execute on function public.set_my_language(text) to authenticated;

-- ------------------------------------------------------------------ 1. the website's languages

create table if not exists public.languages (
  code       text primary key check (public.valid_lang(code)),
  sort       integer not null default 0,
  -- shown in the picker and served (a switched-off language is a 404)
  enabled    boolean not null default true,
  -- pre-translated: in hreflang and the sitemaps; the others are translated on the first visit and get noindex
  indexed    boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint languages_indexed_enabled check (enabled or not indexed)
);
alter table public.languages enable row level security;
revoke all on public.languages from anon, authenticated;

insert into public.languages (code, sort, enabled, indexed) values
  ('sk', 1, true, true), ('hu', 2, true, true), ('en', 3, true, true), ('cs', 4, true, false), ('pl', 5, true, false),
  ('de', 6, true, false), ('uk', 7, true, false), ('ro', 8, true, false), ('hr', 9, true, false), ('sl', 10, true, false),
  ('bg', 11, true, false), ('el', 12, true, false), ('it', 13, true, false), ('fr', 14, true, false), ('es', 15, true, false),
  ('pt', 16, true, false), ('nl', 17, true, false), ('da', 18, true, false), ('sv', 19, true, false), ('fi', 20, true, false),
  ('et', 21, true, false), ('lv', 22, true, false), ('lt', 23, true, false), ('ga', 24, true, false), ('mt', 25, true, false),
  ('nb', 26, true, false), ('is', 27, true, false), ('sr', 28, true, false), ('sr-cyrl', 29, true, false), ('bs', 30, true, false),
  ('sq', 31, true, false), ('mk', 32, true, false), ('tr', 33, true, false), ('ru', 34, false, false), ('ca', 35, false, false),
  ('eu', 36, false, false), ('gl', 37, false, false), ('cy', 38, false, false), ('lb', 39, false, false),
  ('zh-hans', 40, true, false), ('zh-hant', 41, false, false), ('vi', 42, true, false)
on conflict (code) do nothing;

-- Slovak is the source of every text: always on and pre-translated.
create or replace function public.languages_keep_sk()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.code = 'sk' then
    new.enabled := true;
    new.indexed := true;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists languages_keep_sk on public.languages;
create trigger languages_keep_sk before insert or update on public.languages
  for each row execute function public.languages_keep_sk();

create or replace function public.site_languages()
returns table (code text, enabled boolean, indexed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select l.code, l.enabled, l.indexed from public.languages l order by l.sort, l.code
$$;
revoke execute on function public.site_languages() from public;
grant execute on function public.site_languages() to anon, authenticated, service_role;

create or replace function public.lang_enabled(p_lang text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select l.enabled from public.languages l where l.code = p_lang), false)
$$;
revoke execute on function public.lang_enabled(text) from public;
grant execute on function public.lang_enabled(text) to anon, authenticated, service_role;

-- "Admin → Jazyky": switch a language on or off, pre-translate it or not.
create or replace function public.admin_save_language(p_code text, p_enabled boolean, p_indexed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  update public.languages
  set enabled = coalesce(p_enabled, enabled),
      indexed = coalesce(p_enabled, enabled) and coalesce(p_indexed, indexed)
  where code = p_code;
  if not found then
    raise exception 'Unknown language' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.admin_save_language(text, boolean, boolean) from public, anon;
grant execute on function public.admin_save_language(text, boolean, boolean) to authenticated;

-- ------------------------------------------------------------------ 2. interface texts

create table if not exists public.ui_translations (
  lang        text not null references public.languages (code) on delete cascade,
  -- "shop.items_title" (namespace.key, as in src/i18n/messages)
  key         text not null check (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+){1,3}$'),
  text        text not null check (char_length(text) between 1 and 20000),
  -- md5 of the Slovak text it was made from: another Slovak text = "zastaraný"
  source_hash text not null check (source_hash ~ '^[0-9a-f]{32}$'),
  status      text not null default 'ai' check (status in ('ai', 'manual')),
  -- the admin read it ("Skontrolované"); legal texts carry "Strojový preklad" until then
  checked     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (lang, key),
  constraint ui_translations_not_handwritten check (lang not in ('sk', 'hu', 'en'))
);
alter table public.ui_translations enable row level security;
revoke all on public.ui_translations from anon, authenticated;

-- The interface texts of a language: {"shop.items_title": "…"} (the website layers them over EN and SK).
create or replace function public.ui_messages(p_lang text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(u.key, u.text), '{}'::jsonb)
  from public.ui_translations u
  join public.languages l on l.code = u.lang and l.enabled
  where u.lang = p_lang
$$;
revoke execute on function public.ui_messages(text) from public;
grant execute on function public.ui_messages(text) to anon, authenticated, service_role;

-- Which keys of a language are machine translations nobody checked yet (legal texts show the note).
create or replace function public.ui_unchecked(p_lang text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(u.key order by u.key), '{}'::text[])
  from public.ui_translations u where u.lang = p_lang and not u.checked
$$;
revoke execute on function public.ui_unchecked(text) from public;
grant execute on function public.ui_unchecked(text) to anon, authenticated, service_role;

-- "Admin → Preklady rozhrania": every stored text of a language.
create or replace function public.admin_ui_translations(p_lang text)
returns table (key text, text text, source_hash text, status text, checked boolean, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return query
    select u.key, u.text, u.source_hash, u.status, u.checked, u.updated_at
    from public.ui_translations u where u.lang = p_lang order by u.key;
end;
$$;
revoke execute on function public.admin_ui_translations(text) from public, anon;
grant execute on function public.admin_ui_translations(text) to authenticated;

-- The admin edits a text (it becomes 'manual': never replaced by Claude) and/or marks it checked.
create or replace function public.admin_save_ui_text(p_lang text, p_key text, p_text text, p_source_hash text, p_checked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_text is null then
    update public.ui_translations set checked = coalesce(p_checked, checked), updated_at = now()
    where lang = p_lang and key = p_key;
    return;
  end if;
  insert into public.ui_translations (lang, key, text, source_hash, status, checked)
  values (p_lang, p_key, btrim(p_text), p_source_hash, 'manual', coalesce(p_checked, true))
  on conflict (lang, key) do update
    set text = excluded.text, source_hash = excluded.source_hash, status = 'manual',
        checked = excluded.checked, updated_at = now();
end;
$$;
revoke execute on function public.admin_save_ui_text(text, text, text, text, boolean) from public, anon;
grant execute on function public.admin_save_ui_text(text, text, text, text, boolean) to authenticated;

-- For the translate function: Claude's interface texts. Never replaces an admin's text ('manual') of the same
-- Slovak source; a changed Slovak text replaces even a checked AI text (it is unchecked again).
create or replace function public.apply_ui_translations(p_lang text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  insert into public.ui_translations as u (lang, key, text, source_hash, status, checked)
  select p_lang, r.key, btrim(r.text), r.source_hash, 'ai', false
  from jsonb_to_recordset(p_rows) as r(key text, text text, source_hash text)
  where nullif(btrim(r.text), '') is not null
  on conflict (lang, key) do update
    set text = excluded.text, source_hash = excluded.source_hash, status = 'ai', checked = false, updated_at = now()
    where u.status = 'ai' or u.source_hash <> excluded.source_hash;
  get diagnostics v_saved = row_count;
  return v_saved;
end;
$$;
revoke execute on function public.apply_ui_translations(text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_ui_translations(text, jsonb) to service_role;

-- ------------------------------------------------------------------ 3. limits and the monthly budget

create table if not exists public.translation_limits (
  plan          text primary key check (plan in ('free', 'pro')),
  -- "Preferované jazyky stránky" besides the shop's own language (pre-translated)
  max_preferred integer not null check (max_preferred between 0 and 42),
  updated_at    timestamptz not null default now()
);
alter table public.translation_limits enable row level security;
revoke all on public.translation_limits from anon, authenticated;
insert into public.translation_limits (plan, max_preferred) values ('free', 2), ('pro', 6) on conflict (plan) do nothing;

create or replace function public.translation_limit_for(p_shop_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select l.max_preferred from public.translation_limits l
  where l.plan = case when public.shop_has_plan(p_shop_id) then 'pro' else 'free' end
$$;
revoke execute on function public.translation_limit_for(uuid) from public, anon;
grant execute on function public.translation_limit_for(uuid) to authenticated, service_role;

create or replace function public.admin_translation_limits()
returns table (plan text, max_preferred integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return query select l.plan, l.max_preferred from public.translation_limits l order by l.plan;
end;
$$;
revoke execute on function public.admin_translation_limits() from public, anon;
grant execute on function public.admin_translation_limits() to authenticated;

create or replace function public.admin_save_translation_limits(p_free integer, p_pro integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_free is null or p_pro is null or p_free not between 0 and 42 or p_pro not between 0 and 42 then
    raise exception 'Give a number from 0 to 42' using errcode = '22023';
  end if;
  update public.translation_limits set max_preferred = p_free, updated_at = now() where plan = 'free';
  update public.translation_limits set max_preferred = p_pro, updated_at = now() where plan = 'pro';
end;
$$;
revoke execute on function public.admin_save_translation_limits(integer, integer) from public, anon;
grant execute on function public.admin_save_translation_limits(integer, integer) to authenticated;

-- The AI's cost per month (UTC): tokens and euros, and when the 80 % alert went out.
create table if not exists public.translation_usage (
  month         date primary key,
  calls         integer not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_eur      numeric(12, 4) not null default 0,
  alerted_at    timestamptz
);
alter table public.translation_usage enable row level security;
revoke all on public.translation_usage from anon, authenticated;

-- Before every AI call: whether this month's spend is still under the budget (TRANSLATION_MONTHLY_BUDGET_EUR).
create or replace function public.translation_budget_ok(p_budget_eur numeric)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_budget_eur is null or p_budget_eur <= 0 or coalesce(
    (select u.cost_eur from public.translation_usage u where u.month = date_trunc('month', now() at time zone 'utc')::date), 0
  ) < p_budget_eur
$$;
revoke execute on function public.translation_budget_ok(numeric) from public, anon, authenticated;
grant execute on function public.translation_budget_ok(numeric) to service_role;

-- After every AI call: adds its cost; returns {cost_eur, alert} — alert true once a month, the first time the spend
-- reaches 80 % of the budget (the function then sends one e-mail to ADMIN_ALERT_EMAIL).
create or replace function public.translation_spend(p_input bigint, p_output bigint, p_cost_eur numeric, p_budget_eur numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
  v_row public.translation_usage;
  v_alert boolean := false;
begin
  insert into public.translation_usage as u (month, calls, input_tokens, output_tokens, cost_eur)
  values (v_month, 1, greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0), greatest(coalesce(p_cost_eur, 0), 0))
  on conflict (month) do update
    set calls = u.calls + 1, input_tokens = u.input_tokens + excluded.input_tokens,
        output_tokens = u.output_tokens + excluded.output_tokens, cost_eur = u.cost_eur + excluded.cost_eur
  returning * into v_row;
  if p_budget_eur > 0 and v_row.alerted_at is null and v_row.cost_eur >= p_budget_eur * 0.8 then
    update public.translation_usage set alerted_at = now() where month = v_month and alerted_at is null;
    v_alert := found;
  end if;
  return jsonb_build_object('cost_eur', v_row.cost_eur, 'alert', v_alert);
end;
$$;
revoke execute on function public.translation_spend(bigint, bigint, numeric, numeric) from public, anon, authenticated;
grant execute on function public.translation_spend(bigint, bigint, numeric, numeric) to service_role;

create or replace function public.admin_translation_usage()
returns table (month date, calls integer, input_tokens bigint, output_tokens bigint, cost_eur numeric, alerted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return query select u.month, u.calls, u.input_tokens, u.output_tokens, u.cost_eur, u.alerted_at
    from public.translation_usage u order by u.month desc limit 12;
end;
$$;
revoke execute on function public.admin_translation_usage() from public, anon;
grant execute on function public.admin_translation_usage() to authenticated;

-- ------------------------------------------------------------------ 4. the shop's languages

create table if not exists public.shop_language_settings (
  shop_id           uuid primary key references public.shops (id) on delete cascade,
  -- "Hlavný jazyk obchodu": the language the shop writes in (what is translated from)
  main_lang         text not null check (public.valid_lang(main_lang)),
  -- "Jazyky inventára": the languages of its stock files (main first)
  inventory_langs   text[] not null default '{}' check (cardinality(inventory_langs) <= 10),
  -- "Preferované jazyky stránky": pre-translated, first in the picker, in its sitemap
  preferred_langs   text[] not null default '{}' check (cardinality(preferred_langs) <= 42),
  -- "Predvolený jazyk na vlastnej doméne" (null = the main language)
  domain_lang       text check (domain_lang is null or public.valid_lang(domain_lang)),
  -- "Zverejniť vygenerované popisy automaticky"
  auto_descriptions boolean not null default false,
  updated_at        timestamptz not null default now()
);
alter table public.shop_language_settings enable row level security;
revoke all on public.shop_language_settings from anon, authenticated;
drop policy if exists "shop_language_settings: members read" on public.shop_language_settings;
create policy "shop_language_settings: members read" on public.shop_language_settings
  for select to authenticated using (public.is_shop_member(shop_id));
grant select on public.shop_language_settings to authenticated;

-- The shop's own language: its setting, else its country's (SK → sk, HU → hu, else en).
create or replace function public.shop_main_lang(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select ls.main_lang from public.shop_language_settings ls where ls.shop_id = p_shop_id),
    (select public.shop_site_lang(s.country) from public.shops s where s.id = p_shop_id),
    'sk')
$$;
revoke execute on function public.shop_main_lang(uuid) from public;
grant execute on function public.shop_main_lang(uuid) to anon, authenticated, service_role;

-- "/" on the shop's own domain: "Predvolený jazyk na vlastnej doméne", else the main language.
create or replace function public.shop_home_lang(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select ls.domain_lang from public.shop_language_settings ls join public.languages l on l.code = ls.domain_lang and l.enabled
     where ls.shop_id = p_shop_id),
    public.shop_main_lang(p_shop_id))
$$;
revoke execute on function public.shop_home_lang(uuid) from public;
grant execute on function public.shop_home_lang(uuid) to anon, authenticated, service_role;

-- The preferred languages that count: switched on, not the main language, within the plan's number (in the owner's
-- order; a shop back on free keeps its list and uses the first ones).
create or replace function public.shop_preferred_langs(p_shop_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x.code order by x.ord), '{}'::text[])
  from (
    select p.code, p.ord, row_number() over (order by p.ord) as n
    from public.shop_language_settings ls
    cross join lateral unnest(ls.preferred_langs) with ordinality as p(code, ord)
    join public.languages l on l.code = p.code and l.enabled
    where ls.shop_id = p_shop_id and p.code <> ls.main_lang
  ) x
  where x.n <= public.translation_limit_for(p_shop_id)
$$;
revoke execute on function public.shop_preferred_langs(uuid) from public;
grant execute on function public.shop_preferred_langs(uuid) to anon, authenticated, service_role;

-- Public: the languages of an active shop (null row before the owner saved them: the website uses the country).
create or replace function public.shop_languages(p_slug text)
returns table (main_lang text, inventory_langs text[], preferred_langs text[], domain_lang text)
language sql
stable
security definer
set search_path = ''
as $$
  select ls.main_lang, ls.inventory_langs, public.shop_preferred_langs(s.id), public.shop_home_lang(s.id)
  from public.shops s
  join public.shop_language_settings ls on ls.shop_id = s.id
  where s.slug = p_slug and s.is_active
$$;
revoke execute on function public.shop_languages(text) from public;
grant execute on function public.shop_languages(text) to anon, authenticated, service_role;

-- Môj obchod → Nastavenia → Jazyky: the settings, the plan's number of preferred languages.
create or replace function public.owner_language_settings(p_shop_id uuid)
returns table (main_lang text, inventory_langs text[], preferred_langs text[], domain_lang text, auto_descriptions boolean,
               max_preferred integer, saved boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return query
    select coalesce(ls.main_lang, public.shop_main_lang(p_shop_id)),
           coalesce(ls.inventory_langs, '{}'::text[]),
           coalesce(ls.preferred_langs, '{}'::text[]),
           ls.domain_lang,
           coalesce(ls.auto_descriptions, false),
           public.translation_limit_for(p_shop_id),
           ls.shop_id is not null
    from (select 1) one
    left join public.shop_language_settings ls on ls.shop_id = p_shop_id;
end;
$$;
revoke execute on function public.owner_language_settings(uuid) from public, anon;
grant execute on function public.owner_language_settings(uuid) to authenticated;

-- Saves the languages. Errors: 'main' (unknown language), 'langs' (unknown or switched-off), 'limit' (more preferred
-- languages than the plan allows), 'domain'.
create or replace function public.owner_save_language_settings(
  p_shop_id uuid, p_main text, p_inventory text[], p_preferred text[], p_domain text, p_auto_descriptions boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inventory text[];
  v_preferred text[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.lang_enabled(p_main) then
    raise exception 'main' using errcode = '22023';
  end if;
  select coalesce(array_agg(x order by o), '{}') into v_inventory
    from (select distinct on (x) x, o from unnest(array_prepend(p_main, coalesce(p_inventory, '{}'))) with ordinality as t(x, o) order by x, o) d;
  select coalesce(array_agg(x order by o), '{}') into v_preferred
    from (select distinct on (x) x, o from unnest(coalesce(p_preferred, '{}')) with ordinality as t(x, o) where x <> p_main order by x, o) d;
  if exists (select 1 from unnest(v_inventory || v_preferred) x where not public.lang_enabled(x)) or cardinality(v_inventory) > 10 then
    raise exception 'langs' using errcode = '22023';
  end if;
  if cardinality(v_preferred) > public.translation_limit_for(p_shop_id) then
    raise exception 'limit' using errcode = '22023';
  end if;
  if p_domain is not null and not public.lang_enabled(p_domain) then
    raise exception 'domain' using errcode = '22023';
  end if;
  insert into public.shop_language_settings as ls (shop_id, main_lang, inventory_langs, preferred_langs, domain_lang, auto_descriptions)
  values (p_shop_id, p_main, v_inventory, v_preferred, nullif(p_domain, p_main), coalesce(p_auto_descriptions, false))
  on conflict (shop_id) do update
    set main_lang = excluded.main_lang, inventory_langs = excluded.inventory_langs, preferred_langs = excluded.preferred_langs,
        domain_lang = excluded.domain_lang, auto_descriptions = excluded.auto_descriptions, updated_at = now();
end;
$$;
revoke execute on function public.owner_save_language_settings(uuid, text, text[], text[], text, boolean) from public, anon;
grant execute on function public.owner_save_language_settings(uuid, text, text[], text[], text, boolean) to authenticated;

-- The own domain's front page and links follow "Predvolený jazyk na vlastnej doméne".
create or replace function public.shop_for_host(p_host text)
returns table (slug text, primary_host text, site_lang text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.slug, o.site_host, public.shop_home_lang(s.id)
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  where o.status = 'live'
    and s.is_active
    and public.shop_has_plan(s.id)
    and (o.site_host = lower(btrim(p_host)) or (o.www and 'www.' || o.site_host = lower(btrim(p_host))))
  limit 1
$$;

drop function if exists public.live_shop_sites();
create function public.live_shop_sites()
returns table (slug text, primary_host text, site_lang text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.slug, o.site_host, public.shop_home_lang(s.id)
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  where o.status = 'live' and s.is_active and public.shop_has_plan(s.id)
$$;
revoke execute on function public.live_shop_sites() from public;
grant execute on function public.live_shop_sites() to anon, authenticated, service_role;

-- public_shops: as in update 26, plus the own domain's home language (last).
create or replace view public.public_shops as
select
  sh.id,
  sh.slug,
  sh.name,
  sh.address,
  sh.city,
  sh.country,
  sh.timezone,
  sh.phone,
  sh.website,
  sh.logo_url,
  sh.opening_hours,
  extensions.st_y(sh.location::extensions.geometry) as lat,
  extensions.st_x(sh.location::extensions.geometry) as lng,
  public.freshness_label(ss.latest_file_time) as freshness_state,
  public.freshness_age_minutes(ss.latest_file_time) as freshness_age_minutes,
  ss.latest_file_time,
  sh.has_toilet,
  sh.has_douchette,
  sh.has_card_terminal,
  sh.email,
  sh.facebook_url,
  sh.assistant_label,
  sh.assistant_welcome,
  sh.booking_url,
  public.shop_home_lang(sh.id) as site_lang
from public.shops sh
left join public.sync_sources ss on ss.shop_id = sh.id
where sh.is_active;
grant select on public.public_shops to anon, authenticated;

-- ------------------------------------------------------------------ 5. product descriptions ("Popis (Cacaduu)")

create table if not exists public.item_descriptions (
  item_id      uuid primary key references public.shop_items (id) on delete cascade,
  shop_id      uuid not null references public.shops (id) on delete cascade,
  -- "Návrh popisu": Claude's text from the shop's own data, waiting for the owner
  draft        text check (draft is null or char_length(draft) between 1 and 3000),
  draft_at     timestamptz,
  -- the approved "Popis (Cacaduu)" (the owner may have edited it)
  text         text check (text is null or char_length(text) between 1 and 3000),
  published_at timestamptz,
  -- which description the page shows: 'auto' = the shop's own when there is one, else Cacaduu's
  show         text not null default 'auto' check (show in ('auto', 'shop', 'cacaduu')),
  updated_at   timestamptz not null default now()
);
create index if not exists item_descriptions_shop_idx on public.item_descriptions (shop_id);
alter table public.item_descriptions enable row level security;
revoke all on public.item_descriptions from anon, authenticated;
drop policy if exists "item_descriptions: members read" on public.item_descriptions;
create policy "item_descriptions: members read" on public.item_descriptions
  for select to authenticated using (public.is_shop_member(shop_id));
grant select on public.item_descriptions to authenticated;

-- The description a page shows (its text, 'shop' or 'cacaduu'); the shop's own wins unless the owner chose Cacaduu's.
create or replace function public.item_description_shown(p_item_id uuid)
returns table (text text, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select x.text, x.source from (
    select case
             when d.show = 'cacaduu' and d.text is not null then d.text
             when d.show = 'shop' or nullif(btrim(si.description), '') is not null then nullif(btrim(si.description), '')
             else d.text
           end as text,
           case
             when d.show = 'cacaduu' and d.text is not null then 'cacaduu'
             when d.show = 'shop' or nullif(btrim(si.description), '') is not null then 'shop'
             else 'cacaduu'
           end as source
    from public.shop_items si
    left join public.item_descriptions d on d.item_id = si.id
    where si.id = p_item_id
  ) x
  where x.text is not null
$$;
revoke execute on function public.item_description_shown(uuid) from public;
grant execute on function public.item_description_shown(uuid) to anon, authenticated, service_role;

-- For the translate function: the shop's own data of an item (never purchase prices, suppliers or margins: only the
-- approved columns are ever stored on shop_items) — what a description may be written from.
create or replace function public.item_description_facts(p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'name', si.name, 'brand', si.brand, 'ean', si.ean, 'category', si.category, 'description', si.description,
    'shop_lang', public.shop_main_lang(si.shop_id), 'shop_id', si.shop_id))
  from public.shop_items si where si.id = p_item_id
$$;
revoke execute on function public.item_description_facts(uuid) from public, anon, authenticated;
grant execute on function public.item_description_facts(uuid) to service_role;

-- The translate function stores Claude's draft; with "Zverejniť vygenerované popisy automaticky" it is published.
create or replace function public.save_description_draft(p_item_id uuid, p_text text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_auto boolean;
begin
  select si.shop_id into v_shop from public.shop_items si where si.id = p_item_id;
  if v_shop is null or nullif(btrim(p_text), '') is null then
    return 'skipped';
  end if;
  select coalesce(ls.auto_descriptions, false) into v_auto from public.shop_language_settings ls where ls.shop_id = v_shop;
  insert into public.item_descriptions as d (item_id, shop_id, draft, draft_at, text, published_at)
  values (p_item_id, v_shop,
          case when coalesce(v_auto, false) then null else left(btrim(p_text), 3000) end, now(),
          case when coalesce(v_auto, false) then left(btrim(p_text), 3000) end,
          case when coalesce(v_auto, false) then now() end)
  on conflict (item_id) do update
    set draft = case when coalesce(v_auto, false) then null else excluded.draft end,
        draft_at = now(),
        text = case when coalesce(v_auto, false) then excluded.text else d.text end,
        published_at = case when coalesce(v_auto, false) then now() else d.published_at end,
        updated_at = now();
  return case when coalesce(v_auto, false) then 'published' else 'draft' end;
end;
$$;
revoke execute on function public.save_description_draft(uuid, text) from public, anon, authenticated;
grant execute on function public.save_description_draft(uuid, text) to service_role;

-- "Uložiť a zverejniť" (the draft as the owner edited it), "Zahodiť" (p_text null and p_publish false) or a new text.
create or replace function public.owner_save_description(p_item_id uuid, p_text text, p_publish boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select si.shop_id into v_shop from public.shop_items si where si.id = p_item_id;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not coalesce(p_publish, false) then
    update public.item_descriptions set draft = null, draft_at = null, updated_at = now() where item_id = p_item_id;
    return;
  end if;
  if nullif(btrim(p_text), '') is null then
    -- an empty text takes Cacaduu's description down
    update public.item_descriptions set text = null, published_at = null, draft = null, updated_at = now() where item_id = p_item_id;
    return;
  end if;
  if char_length(btrim(p_text)) > 3000 then
    raise exception 'too_long' using errcode = '22023';
  end if;
  insert into public.item_descriptions as d (item_id, shop_id, text, published_at)
  values (p_item_id, v_shop, btrim(p_text), now())
  on conflict (item_id) do update
    set text = excluded.text, published_at = now(), draft = null, draft_at = null, updated_at = now();
end;
$$;
revoke execute on function public.owner_save_description(uuid, text, boolean) from public, anon;
grant execute on function public.owner_save_description(uuid, text, boolean) to authenticated;

create or replace function public.owner_set_description_choice(p_item_id uuid, p_show text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select si.shop_id into v_shop from public.shop_items si where si.id = p_item_id;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_show not in ('auto', 'shop', 'cacaduu') then
    raise exception 'Unknown choice' using errcode = '22023';
  end if;
  insert into public.item_descriptions as d (item_id, shop_id, show) values (p_item_id, v_shop, p_show)
  on conflict (item_id) do update set show = excluded.show, updated_at = now();
end;
$$;
revoke execute on function public.owner_set_description_choice(uuid, text) from public, anon;
grant execute on function public.owner_set_description_choice(uuid, text) to authenticated;

-- "Vygenerovať popisy": the shop's products with no description at all yet (neither its own, nor Cacaduu's, nor a draft).
create or replace function public.owner_items_without_description(p_shop_id uuid, p_limit integer default 20)
returns table (item_id uuid, name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return query
    select si.id, si.name
    from public.shop_items si
    left join public.item_descriptions d on d.item_id = si.id
    where si.shop_id = p_shop_id
      and nullif(btrim(si.description), '') is null
      and d.text is null and d.draft is null
    order by si.name, si.id
    limit least(greatest(coalesce(p_limit, 20), 1), 20);
end;
$$;
revoke execute on function public.owner_items_without_description(uuid, integer) from public, anon;
grant execute on function public.owner_items_without_description(uuid, integer) to authenticated;

-- ------------------------------------------------------------------ 6. the shops' content in other languages

create table if not exists public.content_translations (
  shop_id     uuid not null references public.shops (id) on delete cascade,
  -- item_name | item_description | item_category | assistant_label | assistant_welcome | special_note |
  -- content_title | section_title | section_alt | blog_title | blog_body
  kind        text not null check (kind in ('item_name', 'item_description', 'item_category', 'assistant_label',
                'assistant_welcome', 'special_note', 'content_title', 'section_title', 'section_alt', 'blog_title', 'blog_body')),
  -- the item, post or section id; the shop id for the shop's own texts; the date of a special day
  ref         text not null check (char_length(ref) between 1 and 64),
  lang        text not null check (public.valid_lang(lang)),
  -- null only for 'none' ("Neprekladať")
  text        text check (text is null or char_length(text) between 1 and 70000),
  status      text not null check (status in ('shop', 'ai', 'manual', 'none')),
  -- md5 of the original it was made from (null for 'none')
  source_hash text check (source_hash is null or source_hash ~ '^[0-9a-f]{32}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (shop_id, kind, ref, lang),
  constraint content_translations_text check ((status = 'none') = (text is null))
);
create index if not exists content_translations_ref_idx on public.content_translations (kind, ref);
alter table public.content_translations enable row level security;
revoke all on public.content_translations from anon, authenticated;
drop policy if exists "content_translations: members read" on public.content_translations;
create policy "content_translations: members read" on public.content_translations
  for select to authenticated using (public.is_shop_member(shop_id));
grant select on public.content_translations to authenticated;

-- The text of everything a shop shows that can be translated (only what visitors may see: items of the shop, the
-- shown description, upcoming special days, files in the slider, visible posts). pub = shown on the page now.
create or replace function public.translation_sources(p_shop_id uuid)
returns table (kind text, ref text, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'item_name', si.id::text, si.name from public.shop_items si where si.shop_id = p_shop_id
  union all
  select 'item_description', si.id::text, d.text
  from public.shop_items si cross join lateral public.item_description_shown(si.id) d where si.shop_id = p_shop_id
  union all
  select 'item_category', si.id::text, si.category from public.shop_items si
  where si.shop_id = p_shop_id and nullif(btrim(si.category), '') is not null
  union all
  select 'assistant_label', s.id::text, s.assistant_label from public.shops s where s.id = p_shop_id and s.assistant_label is not null
  union all
  select 'assistant_welcome', s.id::text, s.assistant_welcome from public.shops s where s.id = p_shop_id and s.assistant_welcome is not null
  union all
  select 'special_note', h.date::text, h.note from public.shop_special_hours h
  where h.shop_id = p_shop_id and nullif(btrim(h.note), '') is not null and h.date >= current_date - 1
  union all
  select 'content_title', c.shop_id::text, c.title from public.shop_page_content c where c.shop_id = p_shop_id and c.title is not null
  union all
  select 'section_title', ps.id::text, ps.title from public.shop_page_sections ps
  where ps.shop_id = p_shop_id and public.section_visible(ps.id)
  union all
  select 'section_alt', ps.id::text, coalesce(nullif(btrim(ps.alt), ''), nullif(btrim(ps.alt_ai), '')) from public.shop_page_sections ps
  where ps.shop_id = p_shop_id and public.section_visible(ps.id) and coalesce(nullif(btrim(ps.alt), ''), nullif(btrim(ps.alt_ai), '')) is not null
  union all
  select 'blog_title', p.id::text, p.title from public.blog_visible_posts(p_shop_id) p
  union all
  select 'blog_body', p.id::text, p.body from public.blog_visible_posts(p_shop_id) p where nullif(btrim(p.body), '') is not null
$$;
revoke execute on function public.translation_sources(uuid) from public, anon, authenticated;
grant execute on function public.translation_sources(uuid) to service_role;

-- One source's current text (null = it is gone or not shown).
create or replace function public.translation_source(p_shop_id uuid, p_kind text, p_ref text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.source from public.translation_sources(p_shop_id) s where s.kind = p_kind and s.ref = p_ref limit 1
$$;
revoke execute on function public.translation_source(uuid, text, text) from public, anon, authenticated;
grant execute on function public.translation_source(uuid, text, text) to service_role;

-- Search across every language: the original name and all its translations (update 17 had sk, hu, en).
create or replace function public.item_names_text(p_name text, p_i18n jsonb)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select public.search_text(
    coalesce(p_name, '') || ' ' ||
    coalesce((select string_agg(e.value, ' ' order by e.key) from jsonb_each_text(
      case when jsonb_typeof(p_i18n) = 'object' then p_i18n else '{}'::jsonb end) e), '')
  )
$$;
reindex index public.shop_items_names_search_idx;

-- shop_items.name_i18n = every item_name translation that is shown (the search copy; the original stays in name).
create or replace function public.refresh_item_names(p_shop_id uuid, p_refs text[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shop_items si
  set name_i18n = (
    select jsonb_object_agg(c.lang, c.text) from public.content_translations c
    where c.shop_id = si.shop_id and c.kind = 'item_name' and c.ref = si.id::text and c.status <> 'none'
  )
  where si.shop_id = p_shop_id and si.id::text = any (p_refs)
$$;
revoke execute on function public.refresh_item_names(uuid, text[]) from public, anon, authenticated;

create or replace function public.content_translations_names_new()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  for v in select n.shop_id, array_agg(distinct n.ref) as refs from new_rows n where n.kind = 'item_name' group by n.shop_id loop
    perform public.refresh_item_names(v.shop_id, v.refs);
  end loop;
  return null;
end;
$$;

create or replace function public.content_translations_names_old()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  for v in select o.shop_id, array_agg(distinct o.ref) as refs from old_rows o where o.kind = 'item_name' group by o.shop_id loop
    perform public.refresh_item_names(v.shop_id, v.refs);
  end loop;
  return null;
end;
$$;

drop trigger if exists content_translations_names_ins on public.content_translations;
drop trigger if exists content_translations_names_upd on public.content_translations;
drop trigger if exists content_translations_names_del on public.content_translations;
create trigger content_translations_names_ins after insert on public.content_translations
  referencing new table as new_rows for each statement execute function public.content_translations_names_new();
create trigger content_translations_names_upd after update on public.content_translations
  referencing new table as new_rows for each statement execute function public.content_translations_names_new();
create trigger content_translations_names_del after delete on public.content_translations
  referencing old table as old_rows for each statement execute function public.content_translations_names_old();

-- The item names translated before (update 17) become rows: the owner's as 'manual', the rest as 'ai'.
insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash)
select si.shop_id, 'item_name', si.id::text, e.key, left(e.value, 70000),
       case when si.name_i18n_by_owner then 'manual' else 'ai' end,
       md5(coalesce(si.translated_name_source, si.name))
from public.shop_items si
cross join lateral jsonb_each_text(si.name_i18n) e
where jsonb_typeof(si.name_i18n) = 'object' and public.valid_lang(e.key) and nullif(btrim(e.value), '') is not null
on conflict do nothing;

-- The status a translation has for the owner: shop | ai | manual | stale (an AI text of an older original) | none.
create or replace function public.translation_state(p_status text, p_hash text, p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_status = 'ai' and p_hash is distinct from md5(coalesce(p_source, '')) then 'stale' else p_status end
$$;
grant execute on function public.translation_state(text, text, text) to anon, authenticated, service_role;

-- Public: a shop's shown translations in one language (never a stale AI text, never one of something not shown).
-- p_kinds / p_refs narrow it (an item page asks for its own item only). Item names also come as name_i18n.
create or replace function public.shop_translations(p_slug text, p_lang text, p_kinds text[] default null, p_refs text[] default null)
returns table (kind text, ref text, text text, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.kind, c.ref, c.text, c.status
  from public.shops s
  join public.content_translations c on c.shop_id = s.id and c.lang = p_lang and c.status in ('shop', 'ai', 'manual')
  join public.translation_sources(s.id) src on src.kind = c.kind and src.ref = c.ref
  where s.slug = p_slug and s.is_active and public.lang_enabled(p_lang)
    and (p_kinds is null or c.kind = any (p_kinds))
    and (p_refs is null or c.ref = any (p_refs))
    and public.translation_state(c.status, c.source_hash, src.source) <> 'stale'
$$;
revoke execute on function public.shop_translations(text, text, text[], text[]) from public;
grant execute on function public.shop_translations(text, text, text[], text[]) to anon, authenticated, service_role;

-- Public: an item's description and category as the page shows them (the original; translations via shop_translations).
create or replace function public.item_texts(p_item_id uuid)
returns table (description text, description_source text, category text, lang text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.text, d.source, nullif(btrim(si.category), ''), coalesce(si.name_lang, public.shop_main_lang(si.shop_id))
  from public.shop_items si
  join public.shops s on s.id = si.shop_id and s.is_active
  left join lateral public.item_description_shown(si.id) d on true
  where si.id = p_item_id
$$;
revoke execute on function public.item_texts(uuid) from public;
grant execute on function public.item_texts(uuid) to anon, authenticated, service_role;

-- The blog's readers carry the post's id (its translations are kept per post, update 40); otherwise as in update 37.
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
           'id', p.id, 'slug', p.slug, 'title', p.title, 'body', p.body, 'source', p.source, 'publish_at', p.publish_at,
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

create or replace function public.shop_blog_post(p_slug text, p_post_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', p.id, 'slug', p.slug, 'title', p.title, 'body', p.body, 'source', p.source, 'publish_at', p.publish_at,
           'modified_at', greatest(p.publish_at, coalesce(p.edited_at, p.publish_at)), 'fb_permalink', p.fb_permalink,
           'links', p.links, 'photos', public.blog_photo_list(p.id))
  from public.shops s, public.blog_visible_posts(s.id) p
  where s.slug = p_slug and s.is_active and p.slug = p_post_slug
$$;
revoke execute on function public.shop_blog_post(text, text) from public;
grant execute on function public.shop_blog_post(text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 7. what to translate, and storing it

-- A visitor opened a shop in a language that is not pre-translated: it is translated now (the page shows the
-- original + "Prekladáme…" meanwhile). Asked again at most every 10 minutes per shop and language; true = queued.
create table if not exists public.translation_requests (
  shop_id      uuid not null references public.shops (id) on delete cascade,
  lang         text not null references public.languages (code) on delete cascade,
  requested_at timestamptz not null default now(),
  primary key (shop_id, lang)
);
alter table public.translation_requests enable row level security;
revoke all on public.translation_requests from anon, authenticated;

create or replace function public.request_translation(p_slug text, p_lang text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select s.id into v_shop from public.shops s where s.slug = p_slug and s.is_active;
  if v_shop is null or not public.lang_enabled(p_lang) or p_lang = public.shop_main_lang(v_shop) then
    return false;
  end if;
  insert into public.translation_requests as r (shop_id, lang) values (v_shop, p_lang)
  on conflict (shop_id, lang) do update set requested_at = now()
    where r.requested_at < now() - interval '10 minutes';
  return found;
end;
$$;
revoke execute on function public.request_translation(text, text) from public;
grant execute on function public.request_translation(text, text) to anon, authenticated, service_role;

-- The languages a shop's content is kept in: its preferred languages (in advance) and the languages visitors asked
-- for in the last 30 days; item names also in sk, hu and en (the search across shops). Never its own language.
create or replace function public.shop_target_langs(p_shop_id uuid, p_kind text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct x), '{}'::text[]) from (
    select unnest(public.shop_preferred_langs(p_shop_id)) as x
    union select r.lang from public.translation_requests r where r.shop_id = p_shop_id and r.requested_at > now() - interval '30 days'
    union select unnest(array['sk', 'hu', 'en']) where p_kind = 'item_name'
  ) t
  where public.lang_enabled(x) and x <> public.shop_main_lang(p_shop_id)
$$;
revoke execute on function public.shop_target_langs(uuid, text) from public, anon, authenticated;
grant execute on function public.shop_target_langs(uuid, text) to service_role;

-- For the translate function: up to p_limit texts that have no translation yet or only a stale AI one (never over a
-- shop, manual or "Neprekladať" one). The shops visitors are waiting for first, then the shop's texts, items, posts.
-- p_shop_id / p_lang narrow it (a visitor's request; "Preložiť znova").
create or replace function public.translation_work(p_limit integer default 200, p_shop_id uuid default null, p_lang text default null)
returns table (shop_id uuid, kind text, ref text, lang text, source text, source_hash text, source_lang text)
language sql
stable
security definer
set search_path = ''
as $$
  with shops as (
    select s.id, coalesce((select max(r.requested_at) from public.translation_requests r where r.shop_id = s.id), 'epoch'::timestamptz) as waiting
    from public.shops s
    where s.is_active and (p_shop_id is null or s.id = p_shop_id)
  ),
  work as (
    select sh.id as shop_id, src.kind, src.ref, l.lang, src.source, md5(src.source) as source_hash,
           case when src.kind like 'item_%' then coalesce(si.name_lang, public.shop_main_lang(sh.id)) else public.shop_main_lang(sh.id) end as source_lang,
           sh.waiting,
           case src.kind when 'assistant_label' then 1 when 'assistant_welcome' then 1 when 'content_title' then 1 when 'special_note' then 2
                         when 'section_title' then 2 when 'section_alt' then 3 when 'item_name' then 4 when 'item_category' then 5
                         when 'blog_title' then 5 when 'item_description' then 6 else 7 end as prio
    from shops sh
    cross join lateral public.translation_sources(sh.id) src
    left join public.shop_items si on src.kind like 'item_%' and si.id::text = src.ref
    cross join lateral unnest(public.shop_target_langs(sh.id, src.kind)) as l(lang)
    left join public.content_translations c
      on c.shop_id = sh.id and c.kind = src.kind and c.ref = src.ref and c.lang = l.lang
    where (p_lang is null or l.lang = p_lang)
      and nullif(btrim(src.source), '') is not null
      and (c.shop_id is null or (c.status = 'ai' and c.source_hash is distinct from md5(src.source)))
  )
  select w.shop_id, w.kind, w.ref, w.lang, w.source, w.source_hash, w.source_lang
  from work w
  where w.lang <> w.source_lang or w.kind not like 'item_%'
  order by w.waiting desc, w.shop_id, w.prio, w.lang, w.ref
  limit least(greatest(coalesce(p_limit, 200), 1), 2000)
$$;
revoke execute on function public.translation_work(integer, uuid, text) from public, anon, authenticated;
grant execute on function public.translation_work(integer, uuid, text) to service_role;

-- For the translate function: Claude's translations [{shop_id, kind, ref, lang, text, source_hash}]. Stored only while
-- the original is still that text, and never over a shop, manual or "Neprekladať" translation. Returns how many.
create or replace function public.apply_translations(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  select r.shop_id, r.kind, r.ref, r.lang, left(btrim(r.text), 70000), 'ai', r.source_hash
  from jsonb_to_recordset(p_rows) as r(shop_id uuid, kind text, ref text, lang text, text text, source_hash text)
  where nullif(btrim(r.text), '') is not null
    and public.valid_lang(r.lang)
    and md5(coalesce(public.translation_source(r.shop_id, r.kind, r.ref), '')) = r.source_hash
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, source_hash = excluded.source_hash, updated_at = now()
    where c.status = 'ai';
  get diagnostics v_saved = row_count;
  return v_saved;
end;
$$;
revoke execute on function public.apply_translations(jsonb) from public, anon, authenticated;
grant execute on function public.apply_translations(jsonb) to service_role;

-- Update 17's stock-pull path: the sk / hu / en names it makes go in as AI translations (never over the owner's or
-- the shop's), name_i18n follows by itself.
create or replace function public.apply_item_translations(p_shop_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'p_items must be a JSON array' using errcode = '22023';
  end if;

  drop table if exists item_tr;
  create temporary table item_tr on commit drop as
  select si.id, si.name, case when public.valid_lang(lower(trim(t.lang))) then lower(trim(t.lang)) end as lang,
         left(trim(t.sk), 300) as sk, left(trim(t.hu), 300) as hu, left(trim(t.en), 300) as en
  from jsonb_to_recordset(p_items) as t(item_id uuid, source text, lang text, sk text, hu text, en text)
  join public.shop_items si on si.id = t.item_id and si.shop_id = p_shop_id
  where not si.name_i18n_by_owner
    and si.name = t.source
    and nullif(trim(t.sk), '') is not null
    and nullif(trim(t.hu), '') is not null
    and nullif(trim(t.en), '') is not null;

  update public.shop_items si set name_lang = t.lang, translated_name_source = t.name
  from item_tr t where si.id = t.id;
  get diagnostics v_saved = row_count;

  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  select p_shop_id, 'item_name', t.id::text, x.lang, x.text, 'ai', md5(t.name)
  from item_tr t
  cross join lateral (values ('sk', t.sk), ('hu', t.hu), ('en', t.en)) as x(lang, text)
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, source_hash = excluded.source_hash, updated_at = now()
    where c.status = 'ai';
  return v_saved;
end;
$$;
revoke execute on function public.apply_item_translations(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_item_translations(uuid, jsonb) to service_role;

-- Update 17's owner correction (sk / hu / en in Môj obchod → Tovar) writes 'manual' rows.
create or replace function public.owner_set_item_translation(p_item_id uuid, p_names jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_name text;
  v_sk text := nullif(trim(p_names ->> 'sk'), '');
  v_hu text := nullif(trim(p_names ->> 'hu'), '');
  v_en text := nullif(trim(p_names ->> 'en'), '');
begin
  select si.shop_id, si.name into v_shop, v_name from public.shop_items si where si.id = p_item_id;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_names is null then
    update public.shop_items set name_i18n_by_owner = false, translated_name_source = null where id = p_item_id;
    -- the owner's texts become AI ones: still found until Claude makes them again from the current name
    update public.content_translations set status = 'ai', source_hash = coalesce(source_hash, md5(v_name)), updated_at = now()
    where shop_id = v_shop and kind = 'item_name' and ref = p_item_id::text and status = 'manual' and lang in ('sk', 'hu', 'en');
    return;
  end if;
  if jsonb_typeof(p_names) is distinct from 'object'
     or coalesce(v_sk, v_hu, v_en) is null
     or greatest(length(v_sk), length(v_hu), length(v_en)) > 300 then
    raise exception 'Give at least one translation of up to 300 characters' using errcode = '22023';
  end if;
  update public.shop_items set name_i18n_by_owner = true, translated_name_source = name where id = p_item_id;
  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  select v_shop, 'item_name', p_item_id::text, x.lang, x.text, 'manual', md5(v_name)
  from (values ('sk', v_sk), ('hu', v_hu), ('en', v_en)) as x(lang, text)
  where x.text is not null
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, status = 'manual', source_hash = excluded.source_hash, updated_at = now();
end;
$$;
revoke execute on function public.owner_set_item_translation(uuid, jsonb) from public, anon;
grant execute on function public.owner_set_item_translation(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ 8. the owner's translations ("Preklady")

-- One page of a shop's translations, every source × language the shop keeps (preferred, inventory, sk/hu/en for item
-- names, asked-for, and any language with a row): its state 'shop' | 'ai' | 'manual' | 'stale' | 'missing' | 'none'.
-- p_kind: null = everything, 'items' = item_*, 'texts' = the shop's texts, 'blog' = blog_*; p_ref one thing (the
-- product's "Preklady" tab); p_q searches the original.
create or replace function public.owner_translations(
  p_shop_id uuid, p_lang text default null, p_kind text default null, p_state text default null,
  p_q text default null, p_ref text default null, p_page integer default 1, p_per_page integer default 50
)
returns table (kind text, ref text, lang text, source text, text text, state text, updated_at timestamptz, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_langs text[];
  v_main text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  v_main := public.shop_main_lang(p_shop_id);
  select coalesce(array_agg(distinct x), '{}') into v_langs from (
    select unnest(public.shop_preferred_langs(p_shop_id)) as x
    union select unnest(ls.inventory_langs) from public.shop_language_settings ls where ls.shop_id = p_shop_id
    union select r.lang from public.translation_requests r where r.shop_id = p_shop_id
    union select c.lang from public.content_translations c where c.shop_id = p_shop_id
    union select unnest(array['sk', 'hu', 'en'])
  ) t where x <> v_main and public.valid_lang(x);
  return query
    with cells as (
      select src.kind, src.ref, l.lang, src.source, c.text, c.updated_at,
             case when c.shop_id is null then 'missing' else public.translation_state(c.status, c.source_hash, src.source) end as state
      from public.translation_sources(p_shop_id) src
      cross join unnest(v_langs) as l(lang)
      left join public.content_translations c on c.shop_id = p_shop_id and c.kind = src.kind and c.ref = src.ref and c.lang = l.lang
      where (p_lang is null or l.lang = p_lang)
        and (p_ref is null or src.ref = p_ref)
        and (p_kind is null
             or (p_kind = 'items' and src.kind like 'item_%')
             or (p_kind = 'blog' and src.kind like 'blog_%')
             or (p_kind = 'texts' and src.kind not like 'item_%' and src.kind not like 'blog_%')
             or src.kind = p_kind)
        and (p_q is null or public.matches_all_words(public.search_text(src.source), p_q))
        and (src.kind <> 'item_name' or l.lang <> coalesce((select si.name_lang from public.shop_items si where si.id::text = src.ref), ''))
    )
    select x.kind, x.ref, x.lang, x.source, x.text, x.state, x.updated_at, count(*) over ()
    from cells x
    where p_state is null or x.state = p_state
    order by x.kind, left(x.source, 80), x.ref, x.lang
    limit least(greatest(coalesce(p_per_page, 50), 1), 200) offset (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_per_page, 50), 1), 200);
end;
$$;
revoke execute on function public.owner_translations(uuid, text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.owner_translations(uuid, text, text, text, text, text, integer, integer) to authenticated;

-- "Upraviť" / "+ Pridať preklad": the owner's text ('manual', never replaced by Claude).
create or replace function public.owner_save_translation(p_shop_id uuid, p_kind text, p_ref text, p_lang text, p_text text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.valid_lang(p_lang) or p_lang = public.shop_main_lang(p_shop_id) then
    raise exception 'lang' using errcode = '22023';
  end if;
  v_source := public.translation_source(p_shop_id, p_kind, p_ref);
  if v_source is null then
    raise exception 'source' using errcode = 'P0002';
  end if;
  if nullif(btrim(p_text), '') is null or char_length(btrim(p_text)) > greatest(300, char_length(v_source) * 3 + 200) then
    raise exception 'text' using errcode = '22023';
  end if;
  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  values (p_shop_id, p_kind, p_ref, p_lang, btrim(p_text), 'manual', md5(v_source))
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, status = 'manual', source_hash = excluded.source_hash, updated_at = now();
end;
$$;
revoke execute on function public.owner_save_translation(uuid, text, text, text, text) from public, anon;
grant execute on function public.owner_save_translation(uuid, text, text, text, text) to authenticated;

-- "Preložiť znova" → the owner took Claude's new text: an AI translation of the current original. Only over an AI or
-- missing one (a shop or manual translation stays; the owner edits it instead).
create or replace function public.owner_accept_translation(p_shop_id uuid, p_kind text, p_ref text, p_lang text, p_text text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  v_source := public.translation_source(p_shop_id, p_kind, p_ref);
  if v_source is null or nullif(btrim(p_text), '') is null or not public.valid_lang(p_lang) then
    raise exception 'text' using errcode = '22023';
  end if;
  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  values (p_shop_id, p_kind, p_ref, p_lang, left(btrim(p_text), 70000), 'ai', md5(v_source))
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, status = 'ai', source_hash = excluded.source_hash, updated_at = now()
    where c.status in ('ai', 'none');
end;
$$;
revoke execute on function public.owner_accept_translation(uuid, text, text, text, text) from public, anon;
grant execute on function public.owner_accept_translation(uuid, text, text, text, text) to authenticated;

-- "Zmazať" (one or many): p_never false = deleted, translated again on the next visit; true = "Neprekladať tento
-- produkt do tohto jazyka". p_cells: [{kind, ref, lang}]. Returns the rows as they were (for "Späť" within 30 s).
create or replace function public.owner_delete_translations(p_shop_id uuid, p_cells jsonb, p_never boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if jsonb_typeof(p_cells) is distinct from 'array' or jsonb_array_length(p_cells) > 1000 then
    raise exception 'cells' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'ref', x.ref, 'lang', x.lang, 'text', c.text,
                                               'status', c.status, 'source_hash', c.source_hash)), '[]'::jsonb)
  into v_before
  from jsonb_to_recordset(p_cells) as x(kind text, ref text, lang text)
  left join public.content_translations c on c.shop_id = p_shop_id and c.kind = x.kind and c.ref = x.ref and c.lang = x.lang;

  delete from public.content_translations c
  using jsonb_to_recordset(p_cells) as x(kind text, ref text, lang text)
  where c.shop_id = p_shop_id and c.kind = x.kind and c.ref = x.ref and c.lang = x.lang;

  if coalesce(p_never, false) then
    insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash)
    select p_shop_id, x.kind, x.ref, x.lang, null, 'none', null
    from jsonb_to_recordset(p_cells) as x(kind text, ref text, lang text)
    where public.valid_lang(x.lang) and public.translation_source(p_shop_id, x.kind, x.ref) is not null
    on conflict do nothing;
  end if;
  return v_before;
end;
$$;
revoke execute on function public.owner_delete_translations(uuid, jsonb, boolean) from public, anon;
grant execute on function public.owner_delete_translations(uuid, jsonb, boolean) to authenticated;

-- "Späť": puts back the rows owner_delete_translations returned (a row without status = there was none).
create or replace function public.owner_restore_translations(p_shop_id uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'rows' using errcode = '22023';
  end if;
  delete from public.content_translations c
  using jsonb_to_recordset(p_rows) as x(kind text, ref text, lang text)
  where c.shop_id = p_shop_id and c.kind = x.kind and c.ref = x.ref and c.lang = x.lang;
  insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash)
  select p_shop_id, x.kind, x.ref, x.lang, x.text, x.status, x.source_hash
  from jsonb_to_recordset(p_rows) as x(kind text, ref text, lang text, text text, status text, source_hash text)
  where x.status in ('shop', 'ai', 'manual', 'none') and public.valid_lang(x.lang)
  on conflict do nothing;
end;
$$;
revoke execute on function public.owner_restore_translations(uuid, jsonb) from public, anon;
grant execute on function public.owner_restore_translations(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ 9. two-language stock files

-- Option B: the shop's second file in another language. Rows [{source_code, ean, name, description, category,
-- quantity, price}] are matched by Kód, then EAN, to the items of the main file; their texts become 'shop'
-- translations (never changed by PPI, never overwritten by Claude). Quantity and price come only from the main file:
-- a different one is reported as a conflict and ignored. Returns {matched, unmatched: [...], conflicts: [...]}.
create or replace function public.apply_shop_translations(p_shop_id uuid, p_lang text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_matched integer;
  v_unmatched jsonb;
  v_conflicts jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  if not public.valid_lang(p_lang) then
    raise exception 'Unknown language' using errcode = '22023';
  end if;
  drop table if exists tr_rows;
  create temporary table tr_rows on commit drop as
  select r.n, nullif(left(trim(r.source_code), 100), '') as source_code, nullif(left(trim(r.ean), 32), '') as ean,
         nullif(left(trim(r.name), 300), '') as name, nullif(left(trim(r.description), 5000), '') as description,
         nullif(left(trim(r.category), 200), '') as category, r.quantity, r.price,
         coalesce(
           (select si.id from public.shop_items si where si.shop_id = p_shop_id and si.source_code = trim(r.source_code)),
           (select si.id from public.shop_items si where si.shop_id = p_shop_id and si.ean = nullif(trim(r.ean), '') order by si.source_code limit 1)
         ) as item_id
  from (
    select e.n, e.v ->> 'source_code' as source_code, e.v ->> 'ean' as ean, e.v ->> 'name' as name,
           e.v ->> 'description' as description, e.v ->> 'category' as category,
           case when jsonb_typeof(e.v -> 'quantity') = 'number' then (e.v ->> 'quantity')::numeric end as quantity,
           case when jsonb_typeof(e.v -> 'price') = 'number' then (e.v ->> 'price')::numeric end as price
    from jsonb_array_elements(p_rows) with ordinality as e(v, n)
    where jsonb_typeof(e.v) = 'object'
  ) r;

  select count(*) into v_matched from tr_rows where item_id is not null;
  select coalesce(jsonb_agg(jsonb_build_object('source_code', source_code, 'ean', ean, 'name', name) order by n), '[]'::jsonb)
  into v_unmatched from (select * from tr_rows where item_id is null order by n limit 200) u;
  select coalesce(jsonb_agg(jsonb_build_object('source_code', si.source_code, 'name', si.name,
           'quantity', t.quantity, 'main_quantity', inv.quantity, 'price', t.price, 'main_price', inv.price) order by t.n), '[]'::jsonb)
  into v_conflicts
  from (select * from tr_rows where item_id is not null) t
  join public.shop_items si on si.id = t.item_id
  left join public.inventory inv on inv.shop_item_id = si.id
  where (t.quantity is not null and t.quantity is distinct from inv.quantity)
     or (t.price is not null and t.price is distinct from inv.price);
  v_conflicts := coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(v_conflicts) e limit 200) x), '[]'::jsonb);

  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  select p_shop_id, x.kind, t.item_id::text, p_lang, x.text, 'shop', md5(coalesce(x.source, ''))
  from (select distinct on (item_id) * from tr_rows where item_id is not null order by item_id, n) t
  join public.shop_items si on si.id = t.item_id
  cross join lateral (values
    ('item_name', t.name, si.name),
    ('item_description', t.description, si.description),
    ('item_category', t.category, si.category)
  ) as x(kind, text, source)
  where x.text is not null and x.source is not null and p_lang <> coalesce(si.name_lang, public.shop_main_lang(p_shop_id))
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, status = 'shop', source_hash = excluded.source_hash, updated_at = now()
    where c.status <> 'manual';

  return jsonb_build_object('matched', v_matched, 'unmatched', v_unmatched, 'conflicts', v_conflicts,
                            'unmatched_count', (select count(*) from tr_rows where item_id is null));
end;
$$;
revoke execute on function public.apply_shop_translations(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_shop_translations(uuid, text, jsonb) to service_role;

-- Option A: a language per text column in the mapping ("name@hu": "Név"). The main file's own description and
-- category are kept on the item; the other languages' texts become 'shop' translations. Called by stock-pull after
-- apply_stock_file() with [{source_code, i18n: {hu: {name, description, category}}}].
create or replace function public.apply_file_texts(p_shop_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  update public.shop_items si
  set description = nullif(left(trim(r.description), 5000), ''), category = nullif(left(trim(r.category), 200), '')
  from jsonb_to_recordset(p_rows) as r(source_code text, description text, category text, has_texts boolean)
  where si.shop_id = p_shop_id and si.source_code = trim(r.source_code) and coalesce(r.has_texts, false)
    and (si.description is distinct from nullif(left(trim(r.description), 5000), '')
         or si.category is distinct from nullif(left(trim(r.category), 200), ''));

  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  select p_shop_id, x.kind, si.id::text, l.key, x.text, 'shop', md5(x.source)
  from jsonb_to_recordset(p_rows) as r(source_code text, i18n jsonb)
  join public.shop_items si on si.shop_id = p_shop_id and si.source_code = trim(r.source_code)
  cross join lateral jsonb_each(case when jsonb_typeof(r.i18n) = 'object' then r.i18n else '{}'::jsonb end) l
  cross join lateral (values
    ('item_name', nullif(left(trim(l.value ->> 'name'), 300), ''), si.name),
    ('item_description', nullif(left(trim(l.value ->> 'description'), 5000), ''), si.description),
    ('item_category', nullif(left(trim(l.value ->> 'category'), 200), ''), si.category)
  ) as x(kind, text, source)
  where public.valid_lang(l.key) and x.text is not null and x.source is not null
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, status = 'shop', source_hash = excluded.source_hash, updated_at = now()
    where c.status <> 'manual' and (c.text is distinct from excluded.text or c.status <> 'shop' or c.source_hash <> excluded.source_hash);
  get diagnostics v_saved = row_count;
  return v_saved;
end;
$$;
revoke execute on function public.apply_file_texts(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_file_texts(uuid, jsonb) to service_role;

-- The mapping knows description, category and a language per text column ("name@hu", "description@de"…; the main
-- columns are in the shop's inventory language). Only the columns named here are ever read (private columns never).
create or replace function public.owner_set_mapping(p_shop_id uuid, p_mapping jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean jsonb := '{}'::jsonb;
  v_field text;
  v_value text;
  v_key text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if jsonb_typeof(p_mapping) is distinct from 'object' then
    raise exception 'The mapping must be an object' using errcode = '22023';
  end if;
  foreach v_field in array array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency', 'description', 'category'] loop
    v_value := nullif(left(trim(coalesce(p_mapping ->> v_field, '')), 200), '');
    v_clean := v_clean || jsonb_build_object(v_field, v_value);
  end loop;
  for v_key, v_value in select e.key, e.value from jsonb_each_text(p_mapping) e loop
    if v_key ~ '^(name|description|category)@[a-z]{2}(-(cyrl|hans|hant))?$' and nullif(trim(v_value), '') is not null then
      v_clean := v_clean || jsonb_build_object(v_key, left(trim(v_value), 200));
    end if;
  end loop;
  if v_clean ->> 'source_code' is null or v_clean ->> 'name' is null
     or v_clean ->> 'quantity' is null or v_clean ->> 'price' is null then
    raise exception 'Item code, name, quantity and price must each be a column of the file' using errcode = '22023';
  end if;
  update public.sync_sources
  set field_mapping = v_clean, mapping_status = 'confirmed', last_error = null
  where shop_id = p_shop_id;
  if not found then
    raise exception 'The shop has no stock file yet' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.owner_set_mapping(uuid, jsonb) from public, anon;
grant execute on function public.owner_set_mapping(uuid, jsonb) to authenticated;

-- The approved columns in field order (the language columns after their field).
create or replace function public.mapped_columns(p_mapping jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(x.col order by x.ord), '{}'::text[])
  from (
    select distinct on (e.value) e.value as col,
           coalesce(array_position(array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency',
                                         'description', 'category'], split_part(e.key, '@', 1)), 100) * 10
             + case when e.key like '%@%' then 1 else 0 end as ord
    from jsonb_each_text(case when jsonb_typeof(p_mapping) = 'object' then p_mapping else '{}'::jsonb end) e
    where nullif(btrim(e.value), '') is not null
    order by e.value, 2
  ) x
$$;
revoke execute on function public.mapped_columns(jsonb) from public;
grant execute on function public.mapped_columns(jsonb) to authenticated, service_role;

-- ------------------------------------------------------------------ 10. search across languages

-- Claude's translations of a search ("白色油漆" → "biela farba", "white paint", "fehér festék"), kept 30 days.
create table if not exists public.query_translations (
  query_key  text primary key check (char_length(query_key) <= 300),
  words      text[] not null check (cardinality(words) <= 8),
  created_at timestamptz not null default now()
);
alter table public.query_translations enable row level security;
revoke all on public.query_translations from anon, authenticated;

-- The website (and the API/MCP) read the cached expansions of a search; the translate function writes them.
create or replace function public.query_expansion(p_query text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select q.words from public.query_translations q
  where q.query_key = left(public.search_text(p_query), 300) and q.created_at > now() - interval '30 days'
$$;
revoke execute on function public.query_expansion(text) from public;
grant execute on function public.query_expansion(text) to anon, authenticated, service_role;

create or replace function public.save_query_expansion(p_query text, p_words text[])
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.query_translations (query_key, words)
  values (left(public.search_text(p_query), 300),
          (select coalesce(array_agg(left(btrim(w), 100)), '{}') from (select w from unnest(p_words) w where nullif(btrim(w), '') is not null limit 8) x))
  on conflict (query_key) do update set words = excluded.words, created_at = now()
$$;
revoke execute on function public.save_query_expansion(text, text[]) from public, anon, authenticated;
grant execute on function public.save_query_expansion(text, text[]) to service_role;

-- ------------------------------------------------------------------ 11. the regular job

/** The 5-minute job sends the Vault secret ppi_translate_cron; the translate function checks it here. */
create or replace function public.translate_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ppi_translate_cron'
      and encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex')
          = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')), false)
$$;
revoke execute on function public.translate_cron_ok(text) from public, anon, authenticated;
grant execute on function public.translate_cron_ok(text) to service_role;

do $$
begin
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_translate_cron') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ppi_translate_cron', 'PPI: the translation job proves itself to the translate function');
  end if;
end;
$$;

-- Every 5 minutes: pre-translations, stale texts, languages visitors asked for. Daily: old requests and searches.
-- Needs the Vault secret ppi_project_url (SETUP.md part O, step 2).
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-translate-tick', '*/5 * * * *', $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/translate',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_translate_cron')),
      body := '{"action":"tick"}'::jsonb,
      timeout_milliseconds := 60000)$job$);
  perform cron.schedule('ppi-translate-cleanup', '23 3 * * *', $job$
    delete from public.translation_requests where requested_at < now() - interval '30 days';
    delete from public.query_translations where created_at < now() - interval '30 days'$job$);
end;
$$;
