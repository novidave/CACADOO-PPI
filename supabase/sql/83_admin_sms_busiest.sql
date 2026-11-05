-- PPI · database update 83: the busiest shop of each SMS quota (Admin → SMS, 2026-11-05, canvas "Cacaduu – Admin",
-- artboard 6)
--
-- The admin's SMS page shows, for each monthly quota (booking · owner · order), this month's total of all shops and
-- how many shops are at the limit (admin_sms_quotas(), update 58) — and now a bar for the busiest shop: its SMS parts
-- this month / the limit. Counted exactly as the quota itself counts (sms_quota_used(): every SMS in the log except
-- failed ones, in the shop's own calendar month), so the bar shows what the shop's next SMS would be checked against.
--
-- admin_sms_busiest() returns one row per quota (quota, monthly, shop_name, shop_slug, used); a quota no shop used
-- this month has no shop (name and slug null, used 0). Admins only (is_admin()); reads only; no table, no data change.

create or replace function public.admin_sms_busiest()
returns table (quota text, monthly integer, shop_name text, shop_slug text, used integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  return query
  select l.quota, l.monthly, b.name, b.slug, coalesce(b.used, 0)
  from public.sms_quota_limits l
  left join lateral (
    select s.name, s.slug, public.sms_quota_used(s.id, l.quota) as used
    from public.shops s
    where exists (
      select 1 from public.shop_outgoing_messages m
      where m.shop_id = s.id and m.channel = 'sms' and m.status <> 'failed'
        and m.created_at >= now() - interval '32 days' and public.sms_quota_of(m.kind) = l.quota
    )
    order by 3 desc, s.name
    limit 1
  ) b on b.used > 0
  order by l.quota;
end;
$$;
revoke execute on function public.admin_sms_busiest() from public, anon;
grant execute on function public.admin_sms_busiest() to authenticated;
