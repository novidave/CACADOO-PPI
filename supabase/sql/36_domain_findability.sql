-- PPI · 36 · Shops on their own domains fully findable (Prompt 12): Search Console and Bing, IndexNow on every host.
--  Paste the whole file into the Supabase SQL Editor and Run. Needs updates 25 and 33. Safe to run again.
--  - domain_orders: the id of the Search Console TXT record Cacadoo added to the domain's DNS (google_txt_record_id),
--    so "Odstrániť" removes only that one record; a value that was already in the DNS ("present") is never removed.
--  - domain_site_verifications: the owner's Google (google-site-verification) and Bing (msvalidate.01) meta tag values
--    for a live domain — the shop's pages on that domain carry them. Owners read their own rows (RLS); they are written
--    only through owner_set_site_verification(); site_verification_meta(slug) gives the pages the live domain's values.
--  - inventory.indexnow_at: when an item changed in a way a search result shows — new, price or currency, or in stock ↔
--    sold out (set by the trigger; 12 → 11 pieces is not such a change).
--  - indexnow_hosts / indexnow_pings: IndexNow per host (the main Cacadoo domain and each live own domain): at most one
--    ping per hour per host; what changed since the last answered ping is sent with the next one; every ping logged.
--    indexnow_claim_host() decides (service role, stock-pull), indexnow_done() notes the answer.
--  - shop_llms_facts(): + the categories of the shop's stock file and whether the shop follows public holidays.
--  Every new table has RLS on.

-- ------------------------------------------------------------------ 1. Search Console: only our own TXT record

alter table public.domain_orders add column if not exists google_txt_record_id text;
alter table public.domain_orders drop constraint if exists domain_orders_google_state;
alter table public.domain_orders add constraint domain_orders_google_state check (
  (google_verification is null) = (google_verification_state is null)
  and (google_verification_state is null or google_verification_state in ('added', 'present', 'manual'))
  -- a record id only for a record Cacadoo added
  and (google_txt_record_id is null or google_verification_state = 'added'));
alter table public.domain_orders drop constraint if exists domain_orders_google_record_id;
alter table public.domain_orders add constraint domain_orders_google_record_id check (
  google_txt_record_id is null or google_txt_record_id ~ '^[A-Za-z0-9_-]{1,64}$');

-- ------------------------------------------------------------------ 2. Meta tags (Google, Bing)

create table if not exists public.domain_site_verifications (
  order_id    uuid primary key references public.domain_orders (id) on delete cascade,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  google_meta text,
  bing_meta   text,
  updated_at  timestamptz not null default now(),
  -- The content of <meta name="google-site-verification" content="…">: Google's token only.
  constraint domain_site_verifications_google check (google_meta is null or google_meta ~ '^[A-Za-z0-9_-]{20,100}$'),
  -- The content of <meta name="msvalidate.01" content="…">: Bing's hexadecimal code.
  constraint domain_site_verifications_bing check (bing_meta is null or bing_meta ~ '^[A-Fa-f0-9]{16,64}$')
);
alter table public.domain_site_verifications enable row level security;
revoke all on public.domain_site_verifications from public, anon, authenticated;
grant select on public.domain_site_verifications to authenticated;
grant all on public.domain_site_verifications to service_role;
drop policy if exists "domain_site_verifications: members read" on public.domain_site_verifications;
create policy "domain_site_verifications: members read" on public.domain_site_verifications
  for select to authenticated using (public.is_shop_member(shop_id));

/**
 * A meta tag value as pasted: the whole tag (<meta name="google-site-verification" content="…" />), "content=…" or the
 * value alone. Only the format of that kind passes: anything else (another tag, a script) → null.
 */
create or replace function public.clean_site_verification(p_kind text, p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := btrim(coalesce(p_value, ''));
  v_name text := case p_kind when 'google' then 'google-site-verification' when 'bing' then 'msvalidate.01' end;
  v_content text;
begin
  if v_name is null or v_text = '' then
    return null;
  end if;
  if v_text ~* '^<meta\s' then
    -- the tag of this kind only, with its content
    if v_text !~* ('name\s*=\s*["'']' || replace(v_name, '.', '\.') || '["'']') then
      return null;
    end if;
    v_content := substring(v_text from '(?i)content\s*=\s*["'']([^"'']*)["'']');
  else
    v_content := regexp_replace(v_text, '^content\s*=\s*', '', 'i');
    v_content := btrim(v_content, ' "''');
  end if;
  v_content := btrim(coalesce(v_content, ''));
  if p_kind = 'google' and v_content ~ '^[A-Za-z0-9_-]{20,100}$' then
    return v_content;
  end if;
  if p_kind = 'bing' and v_content ~ '^[A-Fa-f0-9]{16,64}$' then
    return upper(v_content);
  end if;
  return null;
end;
$$;
revoke execute on function public.clean_site_verification(text, text) from public;
grant execute on function public.clean_site_verification(text, text) to authenticated, service_role;

/**
 * The owner sets ("google" / "bing") or removes (an empty value) a meta tag value of the shop's live own domain.
 * Errors: value (not that kind's format), state (the domain is not live). Only the shop's owners (is_shop_member).
 */
create or replace function public.owner_set_site_verification(p_order_id uuid, p_kind text, p_value text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.domain_orders;
  v_value text;
begin
  select * into o from public.domain_orders where id = p_order_id;
  if auth.uid() is null or o.id is null or not public.is_shop_member(o.shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_kind not in ('google', 'bing') then
    raise exception 'kind' using errcode = '22023';
  end if;
  if o.status <> 'live' then
    raise exception 'state' using errcode = 'P0001';
  end if;
  v_value := public.clean_site_verification(p_kind, p_value);
  if v_value is null and btrim(coalesce(p_value, '')) <> '' then
    raise exception 'value' using errcode = '22023';
  end if;
  insert into public.domain_site_verifications (order_id, shop_id) values (o.id, o.shop_id)
  on conflict (order_id) do nothing;
  if p_kind = 'google' then
    update public.domain_site_verifications set google_meta = v_value, updated_at = now() where order_id = o.id;
  else
    update public.domain_site_verifications set bing_meta = v_value, updated_at = now() where order_id = o.id;
  end if;
  return v_value;
end;
$$;
revoke execute on function public.owner_set_site_verification(uuid, text, text) from public, anon;
grant execute on function public.owner_set_site_verification(uuid, text, text) to authenticated;

/** The meta tags of a shop's live own domain, for its pages there (never on the Cacadoo address). */
create or replace function public.site_verification_meta(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('host', o.site_host, 'google', v.google_meta, 'bing', v.bing_meta)
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  left join public.domain_site_verifications v on v.order_id = o.id
  where s.slug = p_slug and o.status = 'live' and o.site_host is not null and s.is_active and public.shop_has_plan(s.id)
  limit 1
$$;
revoke execute on function public.site_verification_meta(text) from public;
grant execute on function public.site_verification_meta(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 3. IndexNow: only changes a search result shows

alter table public.inventory add column if not exists indexnow_at timestamptz;

-- As in update 33 (changed_at: any change of quantity, price or currency), plus indexnow_at: new, price or currency,
-- or in stock ↔ sold out. Not every sale: 12 → 11 pieces changes nothing a search engine shows.
create or replace function public.track_inventory_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or new.quantity is distinct from old.quantity
     or new.price is distinct from old.price
     or new.currency is distinct from old.currency then
    new.changed_at := now();
  else
    new.changed_at := old.changed_at;
  end if;
  if tg_op = 'INSERT'
     or new.price is distinct from old.price
     or new.currency is distinct from old.currency
     or (coalesce(new.quantity, 0) > 0) is distinct from (coalesce(old.quantity, 0) > 0) then
    new.indexnow_at := now();
  else
    new.indexnow_at := old.indexnow_at;
  end if;
  return new;
end;
$$;
revoke execute on function public.track_inventory_change() from public, anon, authenticated;
drop trigger if exists inventory_track_change on public.inventory;
create trigger inventory_track_change before insert or update on public.inventory
  for each row execute function public.track_inventory_change();
create index if not exists inventory_indexnow_at_idx on public.inventory (indexnow_at);

create table if not exists public.indexnow_hosts (
  host         text primary key,
  -- Changes up to (sent_upto, sent_upto_id) were sent and answered; later ones go with the next ping. The item id
  -- breaks ties: every item of one upload has the same time, and one ping may hold only part of them.
  sent_upto    timestamptz not null,
  sent_upto_id uuid,
  last_ping_at timestamptz,
  last_status  integer,
  last_result  text,
  last_urls    integer,
  updated_at   timestamptz not null default now(),
  constraint indexnow_hosts_host check (host ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
  constraint indexnow_hosts_result check (coalesce(char_length(last_result), 0) <= 200)
);
alter table public.indexnow_hosts add column if not exists sent_upto_id uuid;
alter table public.indexnow_hosts enable row level security;
revoke all on public.indexnow_hosts from public, anon, authenticated;
grant all on public.indexnow_hosts to service_role;

create table if not exists public.indexnow_pings (
  id      bigint generated always as identity primary key,
  host    text not null,
  kind    text not null,
  urls    integer not null,
  status  integer,
  result  text,
  upto    timestamptz,
  sent_at timestamptz not null default now(),
  constraint indexnow_pings_kind check (kind in ('main', 'site')),
  constraint indexnow_pings_result check (coalesce(char_length(result), 0) <= 200)
);
alter table public.indexnow_pings enable row level security;
revoke all on public.indexnow_pings from public, anon, authenticated;
grant all on public.indexnow_pings to service_role;
create index if not exists indexnow_pings_host on public.indexnow_pings (host, sent_at desc);

/**
 * After a stock upload (stock-pull, in the background; once per upload): the host whose addresses changed — the
 * shop's live own domain, else the main Cacadoo host (p_main_host, from the function's SITE_URL) — and, at most once
 * an hour per host, the items of that host changed after the last answered ping (by indexnow_at, then the item id;
 * ≤ p_max_items, oldest first). Main host: the items of every active shop without a live own domain. Answers:
 *   null — no host (no own domain and no main host given);
 *   {host, kind, skip: "hour"} — that host was pinged less than an hour ago (the changes wait for the next ping);
 *   {host, kind, skip: "nothing"} — nothing changed since the last ping;
 *   {host, kind, lang, items: [{id, slug}], upto, upto_id} — ping these (the claim counts as the hour's ping).
 */
create or replace function public.indexnow_claim_host(p_shop_id uuid, p_main_host text, p_max_items integer default 3333)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_host text;
  v_kind text;
  v_lang text;
  h public.indexnow_hosts;
  v_items jsonb;
  v_upto timestamptz;
  v_upto_id uuid;
  v_limit integer := least(greatest(coalesce(p_max_items, 3333), 1), 10000);
begin
  select o.site_host, public.shop_site_lang(s.country) into v_host, v_lang
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  where o.shop_id = p_shop_id and o.status = 'live' and o.site_host is not null and s.is_active and public.shop_has_plan(s.id)
  limit 1;
  if v_host is not null then
    v_kind := 'site';
  else
    v_host := lower(btrim(coalesce(p_main_host, '')));
    if v_host !~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' or v_host !~ '\.' then
      return null;
    end if;
    v_kind := 'main';
    v_lang := null;
  end if;

  -- A host seen for the first time starts with the last hour's changes, never the whole catalogue.
  insert into public.indexnow_hosts (host, sent_upto) values (v_host, now() - interval '1 hour')
  on conflict (host) do nothing;
  select * into h from public.indexnow_hosts where host = v_host for update;
  if h.last_ping_at is not null and h.last_ping_at > now() - interval '1 hour' then
    return jsonb_build_object('host', v_host, 'kind', v_kind, 'skip', 'hour');
  end if;

  with picked as (
    select si.id, s.slug, inv.indexnow_at as at
    from public.shop_items si
    join public.inventory inv on inv.shop_item_id = si.id
    join public.shops s on s.id = si.shop_id
    where (inv.indexnow_at, si.id) > (h.sent_upto, coalesce(h.sent_upto_id, '00000000-0000-0000-0000-000000000000'::uuid))
      and case when v_kind = 'site' then si.shop_id = p_shop_id
               -- canonical on PPI: active shops without a live own domain
               else s.is_active and not exists (
                 select 1 from public.domain_orders o
                 where o.shop_id = s.id and o.status = 'live' and o.site_host is not null and public.shop_has_plan(s.id))
          end
    order by inv.indexnow_at, si.id
    limit v_limit
  ), last as (
    select p.at, p.id from picked p order by p.at desc, p.id desc limit 1
  )
  select coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'slug', p.slug) order by p.at, p.id) from picked p), '[]'::jsonb),
         (select l.at from last l), (select l.id from last l)
  into v_items, v_upto, v_upto_id;

  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('host', v_host, 'kind', v_kind, 'skip', 'nothing');
  end if;
  update public.indexnow_hosts set last_ping_at = now(), updated_at = now() where host = v_host;
  return jsonb_build_object('host', v_host, 'kind', v_kind, 'lang', v_lang, 'items', v_items, 'upto', v_upto, 'upto_id', v_upto_id);
end;
$$;
revoke execute on function public.indexnow_claim_host(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.indexnow_claim_host(uuid, text, integer) to service_role;

/**
 * The answer of a ping: logged (the last 100 per host kept). Answered (2xx): the changes up to (p_upto, p_upto_id)
 * are sent. Otherwise they stay and go with the next ping. An own domain's order shows the last ping too (update 33's
 * columns).
 */
create or replace function public.indexnow_done(
  p_host text, p_kind text, p_upto timestamptz, p_upto_id uuid, p_urls integer, p_status integer, p_result text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ok boolean := coalesce(p_status between 200 and 299, false);
  v_result text := left(regexp_replace(coalesce(p_result, ''), '[\x01-\x1f]', ' ', 'g'), 200);
  h public.indexnow_hosts;
  v_newer boolean;
begin
  select * into h from public.indexnow_hosts where host = lower(p_host) for update;
  v_newer := v_ok and p_upto is not null and h.host is not null
    and (p_upto, coalesce(p_upto_id, '00000000-0000-0000-0000-000000000000'::uuid))
      > (h.sent_upto, coalesce(h.sent_upto_id, '00000000-0000-0000-0000-000000000000'::uuid));
  insert into public.indexnow_pings (host, kind, urls, status, result, upto)
  values (lower(p_host), case when p_kind = 'site' then 'site' else 'main' end, greatest(coalesce(p_urls, 0), 0), p_status, v_result, p_upto);
  update public.indexnow_hosts
  set sent_upto = case when v_newer then p_upto else sent_upto end,
      sent_upto_id = case when v_newer then p_upto_id else sent_upto_id end,
      last_status = p_status, last_result = v_result, last_urls = greatest(coalesce(p_urls, 0), 0), updated_at = now()
  where host = lower(p_host);
  if p_kind = 'site' then
    update public.domain_orders
    set indexnow_at = now(), indexnow_urls = greatest(coalesce(p_urls, 0), 0), indexnow_result = v_result
    where site_host = lower(p_host) and status = 'live';
  end if;
  delete from public.indexnow_pings
  where host = lower(p_host)
    and id not in (select id from public.indexnow_pings where host = lower(p_host) order by sent_at desc, id desc limit 100);
end;
$$;
revoke execute on function public.indexnow_done(text, text, timestamptz, uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.indexnow_done(text, text, timestamptz, uuid, integer, integer, text) to service_role;

-- ------------------------------------------------------------------ 4. llms.txt: the stock file's categories, holidays

/** As in update 33, plus the categories of the shop's stock file (as written) and whether it follows public holidays. */
create or replace function public.shop_llms_facts(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'categories', coalesce(to_jsonb(s.product_categories), '[]'::jsonb),
    'brands', (
      select coalesce(jsonb_agg(b.brand order by b.n desc, b.brand), '[]'::jsonb)
      from (
        select si.brand, count(*) as n
        from public.shop_items si
        join public.inventory inv on inv.shop_item_id = si.id
        where si.shop_id = s.id and nullif(btrim(si.brand), '') is not null
        group by si.brand
        order by count(*) desc, si.brand
        limit 15
      ) b),
    'stock_categories', (
      select coalesce(jsonb_agg(c.category order by c.n desc, c.category), '[]'::jsonb)
      from (
        select p.category, count(*) as n
        from public.shop_items si
        join public.inventory inv on inv.shop_item_id = si.id
        join public.products p on p.id = si.product_id
        where si.shop_id = s.id and nullif(btrim(p.category), '') is not null
        group by p.category
        order by count(*) desc, p.category
        limit 15
      ) c),
    'auto_holidays', s.auto_holidays,
    'items', (
      select count(*)
      from public.shop_items si
      join public.inventory inv on inv.shop_item_id = si.id
      where si.shop_id = s.id))
  from public.shops s
  where s.slug = p_slug and s.is_active
$$;
revoke execute on function public.shop_llms_facts(text) from public;
grant execute on function public.shop_llms_facts(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
