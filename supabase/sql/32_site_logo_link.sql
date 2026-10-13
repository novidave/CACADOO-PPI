-- PPI · 32 · Where the own domain's header logo leads.
--  Paste the whole file into the Supabase SQL Editor and Run. Needs update 31. Shop profile content, not stock:
--  - shops.site_logo_link: the address the small logo at the top left of the shop's own domain opens (https of a real
--    host, at most 500 characters, e.g. the shop's main website). Empty (NULL) = the shop's home page, as before.
--    Only through owner_set_site_logo_link() (Pro or a domain of its own, as the header logo; going back to the home
--    page is always allowed); it applies to whatever the header shows (the header logo, the shop's logo or its name).
--  - shop_site_logo() also returns link and has a row when the shop has a header logo or a link.
-- Safe to run again.

alter table public.shops add column if not exists site_logo_link text;

alter table public.shops drop constraint if exists shops_site_logo_link_check;
alter table public.shops add constraint shops_site_logo_link_check check (
  site_logo_link is null or (length(site_logo_link) <= 500
    and site_logo_link ~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:[0-9]{1,5})?([/?#][^[:space:]<>"]*)?$'));

/** As in update 31, plus the logo's link: changed only through owner_set_site_logo() / owner_set_site_logo_link(). */
create or replace function public.guard_shop_site_logo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request()
     and (new.site_logo_url is distinct from old.site_logo_url or new.site_logo_width is distinct from old.site_logo_width
          or new.site_logo_height is distinct from old.site_logo_height or new.site_logo_link is distinct from old.site_logo_link) then
    raise exception 'The header logo is changed only through owner_set_site_logo() and owner_set_site_logo_link()'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_shop_site_logo() from public, anon, authenticated;
drop trigger if exists shops_guard_site_logo on public.shops;
create trigger shops_guard_site_logo before update of site_logo_url, site_logo_width, site_logo_height, site_logo_link
  on public.shops for each row execute function public.guard_shop_site_logo();

/**
 * "Odkaz loga" (own domain): where a click on the header logo leads. The address as typed, with
 * https:// added in front when missing (http becomes https); empty or NULL = the shop's home page,
 * always allowed. Another address only for shops with the paid plan or a domain of their own.
 */
create or replace function public.owner_set_site_logo_link(p_shop_id uuid, p_link text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link text := public.clean_contact('link', p_link);
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if v_link is not null and not public.shop_stands_alone(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  begin
    update public.shops set site_logo_link = v_link where id = p_shop_id;
  exception when check_violation then
    raise exception 'link' using errcode = '22023';
  end;
  return v_link;
end;
$$;
revoke execute on function public.owner_set_site_logo_link(uuid, text) from public, anon;
grant execute on function public.owner_set_site_logo_link(uuid, text) to authenticated;

-- As in update 31, plus link; a row also for a shop with only a link (the header then shows the shop's logo or name).
drop function if exists public.shop_site_logo(text);
create function public.shop_site_logo(p_slug text)
returns table (url text, width integer, height integer, link text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.site_logo_url, s.site_logo_width, s.site_logo_height, s.site_logo_link
  from public.shops s
  where s.slug = p_slug and s.is_active and (s.site_logo_url is not null or s.site_logo_link is not null)
$$;
revoke execute on function public.shop_site_logo(text) from public;
grant execute on function public.shop_site_logo(text) to anon, authenticated, service_role;
