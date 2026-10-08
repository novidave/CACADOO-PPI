-- PPI · 19 · AI assistant on the shop page (a paid feature).
--  - shop_chat_hit(): one call per shopper message, before Claude is asked. Says whether
--    the message may go out: the shop must have the paid plan (shop_has_plan), each
--    caller (hashed IP, logged in api_usage like api_hit) at most p_hourly_limit messages
--    an hour, each shop at most p_monthly_limit messages a calendar month (UTC).
--    Answers 'ok', 'no_plan', 'caller_limit' or 'shop_limit'; only 'ok' is counted.
--  - shop_chat_usage: messages per shop per month (no client access).
-- Safe to run again.

create table if not exists public.shop_chat_usage (
  shop_id  uuid not null references public.shops (id) on delete cascade,
  month    date not null,
  messages integer not null default 0 check (messages >= 0),
  primary key (shop_id, month)
);

alter table public.shop_chat_usage enable row level security;
revoke all on public.shop_chat_usage from public, anon, authenticated;
grant all on public.shop_chat_usage to service_role;

create index if not exists api_usage_shop_chat_idx
  on public.api_usage (ip_hash, created_at) where endpoint = 'shop-chat';

create or replace function public.shop_chat_hit(
  p_ip_hash text,
  p_shop_id uuid,
  p_hourly_limit integer default 20,
  p_monthly_limit integer default 1000
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_count integer;
begin
  if p_ip_hash is null or length(p_ip_hash) < 16 or length(p_ip_hash) > 128 then
    raise exception 'Invalid caller hash' using errcode = '22023';
  end if;

  if not public.shop_has_plan(p_shop_id) then
    return 'no_plan';
  end if;

  if (select count(*) from public.api_usage
      where ip_hash = p_ip_hash and endpoint = 'shop-chat' and created_at > now() - interval '1 hour')
     >= greatest(coalesce(p_hourly_limit, 20), 0) then
    return 'caller_limit';
  end if;

  if greatest(coalesce(p_monthly_limit, 1000), 0) = 0 then
    return 'shop_limit';
  end if;
  insert into public.shop_chat_usage as u (shop_id, month, messages)
  values (p_shop_id, v_month, 1)
  on conflict (shop_id, month) do update
    set messages = u.messages + 1
    where u.messages < greatest(coalesce(p_monthly_limit, 1000), 0)
  returning u.messages into v_count;
  if v_count is null then
    return 'shop_limit';
  end if;

  insert into public.api_usage (ip_hash, endpoint) values (p_ip_hash, 'shop-chat');
  return 'ok';
end;
$$;

revoke execute on function public.shop_chat_hit(text, uuid, integer, integer) from public;
grant execute on function public.shop_chat_hit(text, uuid, integer, integer) to anon, authenticated, service_role;
