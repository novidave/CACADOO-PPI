-- =====================================================================================================================
-- Update 46: the assistant's button label and welcome text always in the page language (at the owner's request,
-- 2026-10-27).
--
-- The owner may write "Keresés Cacadoo Assistenssel" in Hungarian in a Slovak shop. Before, those two texts were
-- translated only into the shop's preferred languages and the languages visitors asked for, never into the shop's own
-- language, and always "from the shop's language". Now they are a preset of every translation run:
--   * target languages = the admin's pre-translated languages ("preložený vopred": sk, hu, en by default)
--     + the shop's preferred languages + the languages visitors asked for, and ALSO the shop's own language;
--   * the source language is 'auto': the translate function lets Claude see which language the text is in (a text
--     already in the target language comes back unchanged).
-- The original stays as the owner wrote it; the owner's own translations ("Upravené ručne") are never overwritten.
-- Paste this whole file into the Supabase SQL Editor once. Then paste the new supabase/functions/translate/index.ts.
-- =====================================================================================================================

-- The texts translated in every pre-translated language and in the shop's own language.
create or replace function public.preset_translation_kind(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_kind in ('assistant_label', 'assistant_welcome')
$$;
grant execute on function public.preset_translation_kind(text) to anon, authenticated, service_role;

-- The languages a shop's content is kept in: its preferred languages (in advance) and the languages visitors asked
-- for in the last 30 days; item names also in sk, hu and en (the search across shops); the assistant's label and
-- welcome text also in every pre-translated language and in the shop's own language (update 46). Never its own
-- language for anything else.
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
    union select l.code from public.languages l where l.indexed and public.preset_translation_kind(p_kind)
    union select public.shop_main_lang(p_shop_id) where public.preset_translation_kind(p_kind)
  ) t
  where public.lang_enabled(x) and (x <> public.shop_main_lang(p_shop_id) or public.preset_translation_kind(p_kind))
$$;
revoke execute on function public.shop_target_langs(uuid, text) from public, anon, authenticated;
grant execute on function public.shop_target_langs(uuid, text) to service_role;

-- For the translate function: as in update 40; the assistant's texts come with source_lang 'auto' (update 46).
create or replace function public.translation_work(p_limit integer default 200, p_shop_id uuid default null, p_lang text default null)
returns table (shop_id uuid, kind text, ref text, lang text, source text, source_hash text, source_lang text)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  with shops as (
    select s.id, coalesce((select max(r.requested_at) from public.translation_requests r where r.shop_id = s.id), 'epoch'::timestamptz) as waiting
    from public.shops s
    where s.is_active and (p_shop_id is null or s.id = p_shop_id)
  ),
  work as (
    select sh.id as shop_id, src.kind, src.ref, l.lang, src.source, md5(src.source) as source_hash,
           case when public.preset_translation_kind(src.kind) then 'auto'
                when src.kind like 'item_%' then coalesce(si.name_lang, public.shop_main_lang(sh.id))
                else public.shop_main_lang(sh.id) end as source_lang,
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
