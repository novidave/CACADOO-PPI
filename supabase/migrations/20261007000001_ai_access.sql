-- PPI · 10 · AI access: public API / MCP rate limit + usage log, town lookup.

-- One call per API or MCP request: logs it (hashed IP, endpoint) and says
-- whether this caller is still within the limit (default 60 per minute).
-- The IP hash is made in the web app with a salt that changes daily, so
-- callers cannot be followed across days and no IP address is stored.
create or replace function public.api_hit(
  p_ip_hash text,
  p_endpoint text,
  p_limit integer default 60
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recent integer;
begin
  if p_ip_hash is null or length(p_ip_hash) < 16 or length(p_ip_hash) > 128 then
    raise exception 'Invalid caller hash' using errcode = '22023';
  end if;

  select count(*) into v_recent
  from public.api_usage
  where ip_hash = p_ip_hash and created_at > now() - interval '1 minute';

  insert into public.api_usage (ip_hash, endpoint)
  values (p_ip_hash, left(coalesce(p_endpoint, ''), 200));

  -- Keep the log small: now and then forget entries older than 30 days.
  if random() < 0.01 then
    delete from public.api_usage where created_at < now() - interval '30 days';
  end if;

  return v_recent < greatest(coalesce(p_limit, 60), 1);
end;
$$;

revoke execute on function public.api_hit(text, text, integer) from public;
grant execute on function public.api_hit(text, text, integer) to anon, authenticated;

-- "Near Michalovce": the middle of the active shops in a town with that name
-- (accent- and case-insensitive). No outside geocoding service needed.
create or replace function public.town_center(p_town text)
returns table (lat double precision, lng double precision, town text, country text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    avg(extensions.st_y(sh.location::extensions.geometry)),
    avg(extensions.st_x(sh.location::extensions.geometry)),
    min(sh.city),
    min(sh.country)
  from public.shops sh
  where sh.is_active
    and sh.location is not null
    and public.search_text(sh.city) = public.search_text(trim(p_town))
  group by public.search_text(sh.city)
  limit 1
$$;

grant execute on function public.town_center(text) to anon, authenticated;
