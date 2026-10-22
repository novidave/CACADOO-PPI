-- PPI · 41 · Môj obchod → Jazyky a inventár → "Tovar": filters and what each product still lacks.
--
--  - owner_item_rows(): the shop's items for its owner, each with has_description (a description is shown on the
--    product page: the shop's own or the approved "Popis (Cacaduu)") and missing_translation (its name, or its shown
--    description, has no current translation in a language the shop's texts are translated into — a stale AI text
--    counts as missing, "Neprekladať" does not; the same languages as the translate job, shop_target_langs())
--  - owner_items(..., p_filter): the list with the filters Všetko / Na sklade / Vypredané / Bez popisu / Chýba preklad;
--    "Na sklade" / "Vypredané" go by the quantity in the shop's file (more than 0 / 0, less or none), never by a
--    label recomputed elsewhere; the label the shopper sees still comes from availability_label()
--  - owner_item_counts(): how many items each filter has
-- Nothing here changes a shop's data or how its stock is shown. Run once in the SQL Editor (after update 40).

-- ------------------------------------------------------------------ 1. the rows with their flags

create or replace function public.owner_item_rows(p_shop_id uuid, p_q text default null)
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
  missing_translation boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_state text;
  v_name_langs text[];
  v_desc_langs text[];
begin
  -- Items of active shops are readable by everyone, so the owner's list checks membership itself.
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    return;
  end if;
  select f.state into v_state from public.freshness_state(p_shop_id) f;
  v_name_langs := public.shop_target_langs(p_shop_id, 'item_name');
  v_desc_langs := public.shop_target_langs(p_shop_id, 'item_description');
  return query
    select
      si.id, si.source_code, si.name, si.ean,
      inv.price, coalesce(inv.currency, 'EUR'), inv.quantity,
      public.availability_label(inv.quantity, v_state),
      coalesce(inv.source_updated_at, inv.received_at, si.updated_at),
      si.name_lang, si.name_i18n, si.name_i18n_by_owner, si.translated_name_source,
      d.text is not null,
      exists (
        select 1 from unnest(v_name_langs) l(lang)
        left join public.content_translations c
          on c.shop_id = p_shop_id and c.kind = 'item_name' and c.ref = si.id::text and c.lang = l.lang
        where l.lang <> coalesce(si.name_lang, '')
          and (c.shop_id is null or public.translation_state(c.status, c.source_hash, si.name) = 'stale')
      ) or (d.text is not null and exists (
        select 1 from unnest(v_desc_langs) l(lang)
        left join public.content_translations c
          on c.shop_id = p_shop_id and c.kind = 'item_description' and c.ref = si.id::text and c.lang = l.lang
        where c.shop_id is null or public.translation_state(c.status, c.source_hash, d.text) = 'stale'
      ))
    from public.shop_items si
    left join public.inventory inv on inv.shop_item_id = si.id
    left join lateral public.item_description_shown(si.id) d on true
    where si.shop_id = p_shop_id
      and (
        nullif(trim(coalesce(p_q, '')), '') is null
        or si.source_code = trim(p_q)
        or si.ean = trim(p_q)
        or public.matches_all_words(public.item_names_text(si.name, si.name_i18n), p_q)
      );
end;
$$;
revoke execute on function public.owner_item_rows(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ 2. the list with its filter

drop function if exists public.owner_items(uuid, text, integer, integer);
drop function if exists public.owner_items(uuid, text, integer, integer, text);
create function public.owner_items(
  p_shop_id uuid,
  q text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_filter text default null
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
  missing_translation boolean
)
language plpgsql
stable
security definer
set search_path = ''
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
           r.name_lang, r.name_i18n, r.name_i18n_by_owner, r.translated_name_source, r.has_description, r.missing_translation
    from public.owner_item_rows(p_shop_id, q) r
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
revoke execute on function public.owner_items(uuid, text, integer, integer, text) from public, anon;
grant execute on function public.owner_items(uuid, text, integer, integer, text) to authenticated, service_role;

-- ------------------------------------------------------------------ 3. how many each filter has

create or replace function public.owner_item_counts(p_shop_id uuid)
returns table (all_items bigint, in_stock bigint, sold_out bigint, no_description bigint, missing_translation bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*),
         count(*) filter (where coalesce(r.quantity, 0) > 0),
         count(*) filter (where coalesce(r.quantity, 0) <= 0),
         count(*) filter (where not r.has_description),
         count(*) filter (where r.missing_translation)
  from public.owner_item_rows(p_shop_id, null) r
$$;
revoke execute on function public.owner_item_counts(uuid) from public, anon;
grant execute on function public.owner_item_counts(uuid) to authenticated, service_role;
