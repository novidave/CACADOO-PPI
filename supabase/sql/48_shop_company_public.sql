-- =====================================================================================================================
-- Update 48: the company on the shop page (at the owner's request, 2026-10-27).
--
-- Update 47 kept PSČ, company name and DIČ for the owners only. Now the shop page shows them under the address
-- ("Budince 26, 040 01 Budince" and "Davide Paint s.r.o. · IČO 12345678 · DIČ 2020123456"), on the Cacaduu address and
-- the own domain, and the JSON-LD gets postalCode, legalName and taxID. Visitors still never read the table
-- shop_company itself: only this function, only for active shops, only these four values (IČO from shops.ico).
-- Paste this whole file into the Supabase SQL Editor once.
-- =====================================================================================================================

create or replace function public.shop_company_details(p_slug text)
returns table (company_name text, ico text, dic text, zip text)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select co.company_name, nullif(btrim(sh.ico), ''), co.dic, co.zip
  from public.shops sh
  left join public.shop_company co on co.shop_id = sh.id
  where sh.slug = p_slug and sh.is_active
    and (co.shop_id is not null or nullif(btrim(sh.ico), '') is not null)
$$;
revoke execute on function public.shop_company_details(text) from public;
grant execute on function public.shop_company_details(text) to anon, authenticated, service_role;
