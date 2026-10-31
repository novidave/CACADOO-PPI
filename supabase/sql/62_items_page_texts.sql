-- PPI · database update 62 — "Tovar" holds the products and their translations, "Texty stránky" the page's own texts
-- (at the owner's request, 31 October 2026)
--
--  1. Tovar (Môj obchod → Jazyky a inventár):
--     - owner_item_languages(): the languages "Preklady: X z Y jazykov" counts (Y) = the shop's preferred languages;
--     - owner_item_rows() / owner_items() / owner_item_counts() take a language (the "Jazyk" dropdown) and give
--       tr_done / tr_total / missing_langs per product. A product is translated into a language when that is the
--       language of its own name, or its name has a current translation there (a shop's, the AI's or the owner's;
--       "Neprekladať" counts as done, a stale AI text as missing) and so has its shown description, if it has one.
--       "Chýba preklad" = missing in one of the preferred languages (or in the chosen one) — decided only here;
--     - owner_item_ids(): every product of the list as filtered (the "Stiahnuť preklady" shortcut);
--     - owner_item_translation_cells(): the texts of chosen products × languages with their state (the bulk actions
--       "Preložiť znova" and "Zmazať preklady" go through the update 40 functions owner_delete_translations() /
--       owner_restore_translations() with these cells);
--     - translation_work_items(): the translate function's "Preložiť chýbajúce" for chosen products only.
--  2. Texty stránky: owner_page_texts() = every text of the page that is not a product (the assistant's label and
--     welcome text, special-day notes, the slider's title, section titles and alt texts, blog posts), one row per
--     original with its languages in it. owner_save_translation() now also takes the shop's own language for the
--     assistant's texts (they are translated into it since update 46).
--  3. Clean-up, in two steps (nothing changes when this file is pasted):
--       select * from public.page_text_cleanup(false);   -- the preview: every row that would go or change
--       select * from public.page_text_cleanup(true);    -- the change, in one transaction
--     It removes the translations of page texts whose original was deleted (a special day, a page section, a blog
--     post, the slider's title, the assistant's texts), the old assistant label "Keresés Cacadoo Assistenssel" with
--     its translations, and turns "Cacadoo" into "Cacaduu" in the assistant's texts and their translations. Product
--     translations are never touched (a product that comes back gets them back by its code, update 43). Every row
--     removed or changed is kept in page_text_cleanup_log first.
-- Paste this whole file into the Supabase SQL Editor once (after update 61). Safe to run again.

-- ------------------------------------------------------------------ 1. Tovar: the languages Y

create or replace function public.owner_item_languages(p_shop_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return public.shop_preferred_langs(p_shop_id);
end;
$$;
revoke execute on function public.owner_item_languages(uuid) from public, anon;
grant execute on function public.owner_item_languages(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ 2. the rows with "X z Y" and a language

drop function if exists public.owner_item_counts(uuid);
drop function if exists public.owner_items(uuid, text, integer, integer, text);
drop function if exists public.owner_item_rows(uuid, text);
create or replace function public.owner_item_rows(p_shop_id uuid, p_q text default null, p_lang text default null)
returns table (
  item_id uuid,
  source_code text,
  item_name text,
  ean text,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  updated_at timestamptz,
  name_lang text,
  name_i18n jsonb,
  name_i18n_by_owner boolean,
  translated_name_source text,
  has_description boolean,
  missing_translation boolean,
  tr_done integer,
  tr_total integer,
  missing_langs text[]
)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
declare
  v_state text;
  v_main text;
  v_all text[];
  v_check text[];
  v_cols text[];
  v_patterns text[] := public.search_patterns(p_q);
begin
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    return;
  end if;
  select f.state into v_state from public.freshness_state(p_shop_id) f;
  v_main := public.shop_main_lang(p_shop_id);
  v_all := public.shop_preferred_langs(p_shop_id);
  -- the "Jazyk" dropdown: "Chýba preklad" for that language only (an unknown or the shop's own language: none)
  v_check := case when p_lang is null then v_all
                  when public.valid_lang(p_lang) and p_lang <> v_main then array[p_lang]
                  else '{}'::text[] end;
  v_cols := v_all || array(select x from unnest(v_check) x where x <> all (v_all));
  return query
    select
      si.id, si.source_code, si.name, si.ean,
      inv.price, coalesce(inv.currency, 'EUR'), inv.quantity,
      public.availability_label(inv.quantity, v_state),
      coalesce(inv.source_updated_at, inv.received_at, si.updated_at),
      si.name_lang, si.name_i18n, si.name_i18n_by_owner, si.translated_name_source,
      d.text is not null,
      coalesce(t.missing_check, false),
      coalesce(t.done, 0),
      cardinality(v_all),
      coalesce(t.missing, '{}'::text[])
    from public.shop_items si
    left join public.inventory inv on inv.shop_item_id = si.id
    left join lateral public.item_description_shown(si.id) d on true
    left join lateral (
      select count(*) filter (where k.ok and l.lang = any (v_all))::integer as done,
             array_agg(l.lang order by l.ord) filter (where not k.ok and l.lang = any (v_all)) as missing,
             bool_or(not k.ok and l.lang = any (v_check)) as missing_check
      from unnest(v_cols) with ordinality as l(lang, ord)
      cross join lateral (
        select l.lang = coalesce(si.name_lang, v_main)
               or (exists (select 1 from public.content_translations c
                           where c.shop_id = p_shop_id and c.kind = 'item_name' and c.ref = si.id::text and c.lang = l.lang
                             and public.translation_state(c.status, c.source_hash, si.name) <> 'stale')
                   and (d.text is null or exists (
                          select 1 from public.content_translations c
                          where c.shop_id = p_shop_id and c.kind = 'item_description' and c.ref = si.id::text
                            and c.lang = l.lang and public.translation_state(c.status, c.source_hash, d.text) <> 'stale'))) as ok
      ) k
    ) t on true
    where si.shop_id = p_shop_id
      and (
        nullif(trim(coalesce(p_q, '')), '') is null
        or si.source_code = trim(p_q)
        or si.ean = trim(p_q)
        or si.names_search like all (v_patterns)
      );
end;
$$;
revoke execute on function public.owner_item_rows(uuid, text, text) from public, anon, authenticated;

create or replace function public.owner_items(
  p_shop_id uuid,
  q text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_filter text default null,
  p_lang text default null
)
returns table (
  item_id uuid,
  source_code text,
  item_name text,
  ean text,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  updated_at timestamptz,
  total_count bigint,
  name_lang text,
  name_i18n jsonb,
  name_i18n_by_owner boolean,
  translated_name_source text,
  has_description boolean,
  missing_translation boolean,
  tr_done integer,
  tr_total integer,
  missing_langs text[]
)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
declare
  v_filter text := coalesce(nullif(trim(p_filter), ''), 'all');
begin
  if v_filter not in ('all', 'in_stock', 'sold_out', 'no_description', 'missing_translation') then
    raise exception 'Unknown filter %', v_filter using errcode = '22023';
  end if;
  return query
    select r.item_id, r.source_code, r.item_name, r.ean, r.price, r.currency, r.quantity, r.availability, r.updated_at,
           count(*) over (),
           r.name_lang, r.name_i18n, r.name_i18n_by_owner, r.translated_name_source, r.has_description,
           r.missing_translation, r.tr_done, r.tr_total, r.missing_langs
    from public.owner_item_rows(p_shop_id, q, p_lang) r
    where case v_filter
            when 'in_stock' then coalesce(r.quantity, 0) > 0
            when 'sold_out' then coalesce(r.quantity, 0) <= 0
            when 'no_description' then not r.has_description
            when 'missing_translation' then r.missing_translation
            else true
          end
    order by r.item_name, r.item_id
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
revoke execute on function public.owner_items(uuid, text, integer, integer, text, text) from public, anon;
grant execute on function public.owner_items(uuid, text, integer, integer, text, text) to authenticated, service_role;

create or replace function public.owner_item_counts(p_shop_id uuid, p_lang text default null)
returns table (all_items bigint, in_stock bigint, sold_out bigint, no_description bigint, missing_translation bigint)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select count(*),
         count(*) filter (where coalesce(r.quantity, 0) > 0),
         count(*) filter (where coalesce(r.quantity, 0) <= 0),
         count(*) filter (where not r.has_description),
         count(*) filter (where r.missing_translation)
  from public.owner_item_rows(p_shop_id, null, p_lang) r
$$;
revoke execute on function public.owner_item_counts(uuid, text) from public, anon;
grant execute on function public.owner_item_counts(uuid, text) to authenticated, service_role;

-- Every product of the list as filtered (search, filter, language), for "Stiahnuť preklady".
create or replace function public.owner_item_ids(p_shop_id uuid, q text default null, p_filter text default null, p_lang text default null)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_filter text := coalesce(nullif(trim(p_filter), ''), 'all');
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if v_filter not in ('all', 'in_stock', 'sold_out', 'no_description', 'missing_translation') then
    raise exception 'Unknown filter %', v_filter using errcode = '22023';
  end if;
  return coalesce((
    select array_agg(r.item_id order by r.item_name, r.item_id)
    from public.owner_item_rows(p_shop_id, q, p_lang) r
    where case v_filter
            when 'in_stock' then coalesce(r.quantity, 0) > 0
            when 'sold_out' then coalesce(r.quantity, 0) <= 0
            when 'no_description' then not r.has_description
            when 'missing_translation' then r.missing_translation
            else true
          end), '{}'::uuid[]);
end;
$$;
revoke execute on function public.owner_item_ids(uuid, text, text, text) from public, anon;
grant execute on function public.owner_item_ids(uuid, text, text, text) to authenticated;

-- The texts of chosen products (≤ 200) × languages: the name, the shown description and the category, each with its
-- state as on the "Preklady" tab (shop | ai | manual | stale | missing | none). Languages: the chosen one, else the
-- preferred ones and every language one of these texts already has. A name is never "missing" in its own language.
create or replace function public.owner_item_translation_cells(p_shop_id uuid, p_item_ids uuid[], p_lang text default null)
returns table (kind text, ref text, lang text, state text)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_main text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if cardinality(p_item_ids) > 200 then
    raise exception 'items' using errcode = '22023';
  end if;
  if p_lang is not null and not public.valid_lang(p_lang) then
    raise exception 'lang' using errcode = '22023';
  end if;
  v_main := public.shop_main_lang(p_shop_id);
  return query
    with texts as (
      select 'item_name'::text as kind, si.id::text as ref, si.name as source, coalesce(si.name_lang, v_main) as own
      from public.shop_items si where si.shop_id = p_shop_id and si.id = any (p_item_ids)
      union all
      select 'item_description', si.id::text, d.text, coalesce(si.name_lang, v_main)
      from public.shop_items si cross join lateral public.item_description_shown(si.id) d
      where si.shop_id = p_shop_id and si.id = any (p_item_ids)
      union all
      select 'item_category', si.id::text, si.category, coalesce(si.name_lang, v_main)
      from public.shop_items si
      where si.shop_id = p_shop_id and si.id = any (p_item_ids) and nullif(btrim(si.category), '') is not null
    ),
    langs as (
      select x as lang from unnest(case when p_lang is not null then array[p_lang] else public.shop_preferred_langs(p_shop_id) end) x
      union
      select c.lang from public.content_translations c
      where p_lang is null and c.shop_id = p_shop_id and c.kind like 'item_%'
        and c.ref in (select i::text from unnest(p_item_ids) i)
    )
    select t.kind, t.ref, l.lang,
           case when c.shop_id is null then 'missing' else public.translation_state(c.status, c.source_hash, t.source) end
    from texts t
    cross join langs l
    left join public.content_translations c on c.shop_id = p_shop_id and c.kind = t.kind and c.ref = t.ref and c.lang = l.lang
    where l.lang <> v_main and (l.lang <> t.own or c.shop_id is not null)
    order by t.ref, t.kind, l.lang;
end;
$$;
revoke execute on function public.owner_item_translation_cells(uuid, uuid[], text) from public, anon;
grant execute on function public.owner_item_translation_cells(uuid, uuid[], text) to authenticated;

-- For the translate function's "run" with chosen products: their missing (or stale AI) names, descriptions and
-- categories in one language. Service role only (the function checks the owner first).
create or replace function public.translation_work_items(p_shop_id uuid, p_lang text, p_refs text[], p_limit integer default 200)
returns table (shop_id uuid, kind text, ref text, lang text, source text, source_hash text, source_lang text)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select p_shop_id, src.kind, src.ref, p_lang, src.source, md5(src.source), coalesce(si.name_lang, public.shop_main_lang(p_shop_id))
  from public.translation_sources(p_shop_id) src
  join public.shop_items si on si.shop_id = p_shop_id and si.id::text = src.ref
  left join public.content_translations c on c.shop_id = p_shop_id and c.kind = src.kind and c.ref = src.ref and c.lang = p_lang
  where src.kind like 'item_%'
    and src.ref = any (p_refs)
    and public.lang_enabled(p_lang)
    and p_lang <> coalesce(si.name_lang, public.shop_main_lang(p_shop_id))
    and p_lang <> public.shop_main_lang(p_shop_id)
    and nullif(btrim(src.source), '') is not null
    and (c.shop_id is null or (c.status = 'ai' and c.source_hash is distinct from md5(src.source)))
  order by src.ref, src.kind
  limit least(greatest(coalesce(p_limit, 200), 1), 5000)
$$;
revoke execute on function public.translation_work_items(uuid, text, text[], integer) from public, anon, authenticated;
grant execute on function public.translation_work_items(uuid, text, text[], integer) to service_role;

-- ------------------------------------------------------------------ 3. Texty stránky

-- The groups of the "Čo" filter.
create or replace function public.page_text_group(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_kind in ('assistant_label', 'assistant_welcome') then 'assistant'
    when p_kind = 'special_note' then 'hours'
    when p_kind in ('content_title', 'section_title', 'section_alt') then 'content'
    when p_kind in ('blog_title', 'blog_body') then 'blog'
  end
$$;
grant execute on function public.page_text_group(text) to authenticated, service_role;

-- Every text of the page that is not a product, one row per original with its languages (cells: [{lang, text, state,
-- updated_at}]). p_kind: a group (assistant, hours, content, blog) or one kind; p_state: only the cells in that state
-- (and only the originals that have one); p_q: words in the original.
create or replace function public.owner_page_texts(
  p_shop_id uuid, p_lang text default null, p_kind text default null, p_state text default null,
  p_q text default null, p_page integer default 1, p_per_page integer default 30
)
returns table (kind text, ref text, source text, cells jsonb, total bigint)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_langs text[];
  v_main text;
  v_patterns text[] := public.search_patterns(p_q);
  v_per integer := least(greatest(coalesce(p_per_page, 30), 1), 100);
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  v_main := public.shop_main_lang(p_shop_id);
  -- the same languages as "Preklady" had (update 40), and the shop's own one for the assistant's texts (update 46)
  select coalesce(array_agg(distinct x), '{}') into v_langs from (
    select unnest(public.shop_preferred_langs(p_shop_id)) as x
    union select unnest(ls.inventory_langs) from public.shop_language_settings ls where ls.shop_id = p_shop_id
    union select r.lang from public.translation_requests r where r.shop_id = p_shop_id
    union select c.lang from public.content_translations c where c.shop_id = p_shop_id and c.kind not like 'item_%'
    union select unnest(array['sk', 'hu', 'en'])
    union select v_main
  ) t where public.valid_lang(x);
  return query
    with src as (
      select s.kind, s.ref, s.source
      from public.translation_sources(p_shop_id) s
      where s.kind not like 'item_%'
        and nullif(btrim(s.source), '') is not null
        and (p_kind is null or public.page_text_group(s.kind) = p_kind or s.kind = p_kind)
        and (p_q is null or public.search_text(s.source) like all (v_patterns))
    ),
    cells as (
      select s.kind, s.ref, s.source, l.lang, c.text, c.updated_at,
             case when c.shop_id is null then 'missing' else public.translation_state(c.status, c.source_hash, s.source) end as state
      from src s
      cross join unnest(v_langs) as l(lang)
      left join public.content_translations c on c.shop_id = p_shop_id and c.kind = s.kind and c.ref = s.ref and c.lang = l.lang
      where (p_lang is null or l.lang = p_lang)
        and (l.lang <> v_main or public.preset_translation_kind(s.kind))
    ),
    groups as (
      select x.kind, x.ref, x.source,
             jsonb_agg(jsonb_build_object('lang', x.lang, 'text', x.text, 'state', x.state, 'updated_at', x.updated_at)
                       order by x.lang) as cells
      from cells x
      where p_state is null or x.state = p_state
      group by x.kind, x.ref, x.source
    )
    select g.kind, g.ref, g.source, g.cells, count(*) over ()
    from groups g
    order by case public.page_text_group(g.kind) when 'assistant' then 1 when 'hours' then 2 when 'content' then 3 else 4 end,
             g.kind, left(g.source, 80), g.ref
    limit v_per offset (greatest(coalesce(p_page, 1), 1) - 1) * v_per;
end;
$$;
revoke execute on function public.owner_page_texts(uuid, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.owner_page_texts(uuid, text, text, text, text, integer, integer) to authenticated;

-- "Upraviť" of a page text: as in update 40, and the assistant's texts also in the shop's own language (update 46
-- translates them into it, so the owner can correct that one too).
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
  if not public.valid_lang(p_lang) or (p_lang = public.shop_main_lang(p_shop_id) and not public.preset_translation_kind(p_kind)) then
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

-- ------------------------------------------------------------------ 4. the clean-up (preview, then change)

create table if not exists public.page_text_cleanup_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null,
  shop_id uuid not null,
  kind text not null,
  ref text not null,
  lang text,
  old_text text,
  new_text text,
  status text,
  source_hash text
);
alter table public.page_text_cleanup_log enable row level security;
revoke all on public.page_text_cleanup_log from public, anon, authenticated;
grant all on public.page_text_cleanup_log to service_role;

-- The old assistant label of the removed search button (owner's request, 2026-10-31).
create or replace function public.page_text_cleanup_old_label(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select btrim(coalesce(p_text, '')) = 'Keresés Cacadoo Assistenssel'
$$;

-- p_apply false: every row that would go or change (nothing changes). true: the same rows, changed in this one
-- transaction (each kept in page_text_cleanup_log first). Actions:
--   orphan       a translation of a page text whose original row no longer exists (deleted special day, page
--                section, blog post, slider title, assistant text)
--   old_label    the assistant label "Keresés Cacadoo Assistenssel" (shops.assistant_label → empty = the default
--                heading in every language) and every translation of it
--   rename       "Cacadoo" → "Cacaduu" in the assistant's label / welcome text and their translations
-- Never a product's translation, never a hidden or expired section's (it may be shown again), never a past special
-- day that still exists.
create or replace function public.page_text_cleanup(p_apply boolean default false)
returns table (action text, shop text, kind text, ref text, lang text, old_text text, new_text text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- only the SQL Editor (and the service role) may run it: no grant to visitors or owners
  create temporary table if not exists pg_temp.cleanup_rows (
    action text, shop_id uuid, kind text, ref text, lang text, old_text text, new_text text, status text, source_hash text
  ) on commit drop;
  truncate pg_temp.cleanup_rows;

  insert into pg_temp.cleanup_rows
  select 'orphan', c.shop_id, c.kind, c.ref, c.lang, c.text, null, c.status, c.source_hash
  from public.content_translations c
  where c.kind not like 'item_%'
    and not case c.kind
      when 'special_note' then exists (select 1 from public.shop_special_hours h
                                       where h.shop_id = c.shop_id and h.date::text = c.ref and nullif(btrim(h.note), '') is not null)
      when 'section_title' then exists (select 1 from public.shop_page_sections ps where ps.shop_id = c.shop_id and ps.id::text = c.ref)
      when 'section_alt' then exists (select 1 from public.shop_page_sections ps where ps.shop_id = c.shop_id and ps.id::text = c.ref)
      when 'blog_title' then exists (select 1 from public.blog_posts p where p.shop_id = c.shop_id and p.id::text = c.ref)
      when 'blog_body' then exists (select 1 from public.blog_posts p where p.shop_id = c.shop_id and p.id::text = c.ref)
      when 'content_title' then exists (select 1 from public.shop_page_content pc where pc.shop_id = c.shop_id and pc.title is not null)
      when 'assistant_label' then exists (select 1 from public.shops s where s.id = c.shop_id and s.assistant_label is not null)
      when 'assistant_welcome' then exists (select 1 from public.shops s where s.id = c.shop_id and s.assistant_welcome is not null)
      else true
    end;

  insert into pg_temp.cleanup_rows
  select 'old_label', s.id, 'assistant_label', s.id::text, null, s.assistant_label, null, null, null
  from public.shops s where public.page_text_cleanup_old_label(s.assistant_label);
  insert into pg_temp.cleanup_rows
  select 'old_label', c.shop_id, c.kind, c.ref, c.lang, c.text, null, c.status, c.source_hash
  from public.content_translations c join public.shops s on s.id = c.shop_id
  where c.kind = 'assistant_label' and public.page_text_cleanup_old_label(s.assistant_label)
    and not exists (select 1 from pg_temp.cleanup_rows r where r.shop_id = c.shop_id and r.kind = c.kind and r.lang = c.lang);

  insert into pg_temp.cleanup_rows
  select 'rename', s.id, x.kind, s.id::text, null, x.text, replace(replace(replace(x.text, 'Cacadoo', 'Cacaduu'), 'CACADOO', 'CACADUU'), 'cacadoo', 'cacaduu'), null, null
  from public.shops s
  cross join lateral (values ('assistant_label', s.assistant_label), ('assistant_welcome', s.assistant_welcome)) as x(kind, text)
  where x.text ilike '%cacadoo%' and not (x.kind = 'assistant_label' and public.page_text_cleanup_old_label(s.assistant_label));
  insert into pg_temp.cleanup_rows
  select 'rename', c.shop_id, c.kind, c.ref, c.lang, c.text,
         replace(replace(replace(c.text, 'Cacadoo', 'Cacaduu'), 'CACADOO', 'CACADUU'), 'cacadoo', 'cacaduu'), c.status, c.source_hash
  from public.content_translations c
  where c.kind in ('assistant_label', 'assistant_welcome') and c.text ilike '%cacadoo%'
    and not exists (select 1 from pg_temp.cleanup_rows r
                    where r.shop_id = c.shop_id and r.kind = c.kind and r.ref = c.ref and r.lang is not distinct from c.lang);

  if p_apply then
    insert into public.page_text_cleanup_log (action, shop_id, kind, ref, lang, old_text, new_text, status, source_hash)
    select r.action, r.shop_id, r.kind, r.ref, r.lang, r.old_text, r.new_text, r.status, r.source_hash from pg_temp.cleanup_rows r;

    -- translations that go (orphans and the old label's)
    delete from public.content_translations c
    using pg_temp.cleanup_rows r
    where r.action in ('orphan', 'old_label') and r.lang is not null
      and c.shop_id = r.shop_id and c.kind = r.kind and c.ref = r.ref and c.lang = r.lang;
    update public.shops s set assistant_label = null
    where exists (select 1 from pg_temp.cleanup_rows r where r.action = 'old_label' and r.lang is null and r.shop_id = s.id);

    -- "Cacaduu": first the translations (an AI text made from the old original stays current with the new one)
    update public.content_translations c
    set text = r.new_text,
        source_hash = case when c.status = 'ai' and c.source_hash = md5(coalesce(case c.kind when 'assistant_label' then s.assistant_label else s.assistant_welcome end, ''))
                           then md5(replace(replace(replace(case c.kind when 'assistant_label' then s.assistant_label else s.assistant_welcome end,
                                'Cacadoo', 'Cacaduu'), 'CACADOO', 'CACADUU'), 'cacadoo', 'cacaduu'))
                           else c.source_hash end,
        updated_at = now()
    from pg_temp.cleanup_rows r, public.shops s
    where r.action = 'rename' and r.lang is not null and s.id = r.shop_id
      and c.shop_id = r.shop_id and c.kind = r.kind and c.ref = r.ref and c.lang = r.lang;
    -- an AI translation of a renamed original whose own text did not say "Cacadoo" stays current too
    update public.content_translations c
    set source_hash = md5(replace(replace(replace(case c.kind when 'assistant_label' then s.assistant_label else s.assistant_welcome end,
                          'Cacadoo', 'Cacaduu'), 'CACADOO', 'CACADUU'), 'cacadoo', 'cacaduu'))
    from public.shops s
    where s.id = c.shop_id and c.status = 'ai' and c.kind in ('assistant_label', 'assistant_welcome')
      and exists (select 1 from pg_temp.cleanup_rows r where r.action = 'rename' and r.lang is null and r.shop_id = s.id and r.kind = c.kind)
      and c.source_hash = md5(coalesce(case c.kind when 'assistant_label' then s.assistant_label else s.assistant_welcome end, ''));
    update public.shops s set assistant_label = r.new_text
    from pg_temp.cleanup_rows r where r.action = 'rename' and r.lang is null and r.kind = 'assistant_label' and r.shop_id = s.id;
    update public.shops s set assistant_welcome = r.new_text
    from pg_temp.cleanup_rows r where r.action = 'rename' and r.lang is null and r.kind = 'assistant_welcome' and r.shop_id = s.id;
  end if;

  return query
    select r.action, coalesce(s.slug, r.shop_id::text), r.kind, r.ref, r.lang, r.old_text, r.new_text
    from pg_temp.cleanup_rows r left join public.shops s on s.id = r.shop_id
    order by r.action, s.slug, r.kind, r.ref, r.lang nulls first;
end;
$$;
revoke execute on function public.page_text_cleanup(boolean) from public, anon, authenticated;
grant execute on function public.page_text_cleanup(boolean) to service_role;

-- What the clean-up would do now (nothing changes). After checking the rows, run:
--   select * from public.page_text_cleanup(true);
select * from public.page_text_cleanup(false);
