-- PPI · 25 · Custom domains (Pro): a domain bought through Websupport in the shop's own name
-- (13: find on websupport.sk, paste, pay once) or the shop's own domain connected (14).
--  - domain_settings (one row): the Websupport search page, the "same price as Websupport"
--    switch, the low-credit threshold, the last seen credit, the test domain (test mode)
--  - domain_prices: the price table per TLD that shops see and pay (admin writes it)
--  - shop_legal: the domain owner's details; the shop is the registrant, never Cacadoo
--  - domain_orders: one row per bought or connected domain, every step logged
--  - shop_for_host() / shop_site() / live_shop_sites(): the only public part (hostname -> shop)
--  - admin_*: the admin page "Predplatné a domény" (is_admin only)
--  - jobs: ppi-domains-tick (every 5 minutes) and ppi-domains-daily (renewals, reminders)
-- Only the domains Edge Function (service role) moves an order; owners and visitors read.
-- Needs updates 18 (subscriptions) and 22 (Vault secrets, assistant_cron_ok). Safe to run again.

-- ------------------------------------------------------------------ settings

create table if not exists public.domain_settings (
  id                      boolean primary key default true constraint domain_settings_one_row check (id),
  search_url              text not null default 'https://www.websupport.sk',
  same_price_as_registrar boolean not null default false,
  low_credit_eur          numeric(10, 2) not null default 50,
  -- REGISTRAR_MODE=test: nothing is bought; the website is set up on this domain instead
  -- (one the admin already has in the Websupport account), so the whole flow can be tried.
  test_domain             text,
  credit_eur              numeric(12, 2),
  credit_checked_at       timestamptz,
  credit_alert_at         timestamptz,
  updated_at              timestamptz not null default now(),
  constraint domain_settings_search_url check (search_url ~ '^https://[^[:space:]/]+(/[^[:space:]]*)?$' and length(search_url) <= 300),
  constraint domain_settings_low_credit check (low_credit_eur >= 0),
  constraint domain_settings_test_domain check (
    test_domain is null
    or (test_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' and length(test_domain) <= 253))
);
insert into public.domain_settings (id) values (true) on conflict (id) do nothing;

alter table public.domain_settings enable row level security;
revoke all on public.domain_settings from public, anon, authenticated;
grant select, update on public.domain_settings to authenticated;
grant all on public.domain_settings to service_role;
drop policy if exists "domain_settings: admin" on public.domain_settings;
create policy "domain_settings: admin" on public.domain_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- What a shop's page needs: the search page and the switch. Never the credit or threshold.
create or replace function public.domain_shop_settings()
returns table (search_url text, same_price_as_registrar boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.search_url, s.same_price_as_registrar from public.domain_settings s where s.id
$$;
revoke execute on function public.domain_shop_settings() from public, anon;
grant execute on function public.domain_shop_settings() to authenticated, service_role;

-- ------------------------------------------------------------------ price table

-- What shops see and pay, per TLD ("sk", "eu", "co.uk"). No prices are built in: the admin
-- fills the table. Websupport's own (partner) price is never stored or shown here.
create table if not exists public.domain_prices (
  tld           text primary key,
  price_cents   integer not null,
  renewal_cents integer not null,
  vat_included  boolean not null default true,
  currency      text not null default 'EUR',
  sort_order    integer not null default 100,
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),
  constraint domain_prices_tld check (tld ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)?$'),
  constraint domain_prices_price check (price_cents between 1 and 10000000 and renewal_cents between 1 and 10000000),
  constraint domain_prices_currency check (currency = 'EUR')
);

alter table public.domain_prices enable row level security;
revoke all on public.domain_prices from public, anon, authenticated;
grant select on public.domain_prices to anon, authenticated;
grant all on public.domain_prices to service_role;
drop policy if exists "domain_prices: read active" on public.domain_prices;
create policy "domain_prices: read active" on public.domain_prices
  for select to anon, authenticated using (active or public.is_admin());

-- The price of a name: the longest TLD of the table it ends with ("shop.co.uk" -> "co.uk").
create or replace function public.domain_price_for(p_hostname text)
returns public.domain_prices
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.domain_prices p
  where p.active and lower(p_hostname) like '%.' || p.tld
    and position('.' in left(lower(p_hostname), length(p_hostname) - length(p.tld) - 1)) = 0
  order by length(p.tld) desc
  limit 1
$$;
revoke execute on function public.domain_price_for(text) from public, anon;
grant execute on function public.domain_price_for(text) to authenticated, service_role;

-- ------------------------------------------------------------------ the domain owner

-- The registrant's details: the shop's own company, never Cacadoo. Missing ones are asked
-- for on the page (step 3); PPI never invents or completes them.
create table if not exists public.shop_legal (
  shop_id      uuid primary key references public.shops (id) on delete cascade,
  company_name text,
  contact_name text,
  street       text,
  city         text,
  zip          text,
  country      text,
  ico          text,
  dic          text,
  ic_dph       text,
  email        text,
  phone        text,
  updated_at   timestamptz not null default now(),
  constraint shop_legal_country check (country is null or country ~ '^[A-Z]{2}$'),
  constraint shop_legal_email check (email is null or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint shop_legal_phone check (phone is null or phone ~ '^\+?[0-9 ()./-]{6,30}$'),
  constraint shop_legal_ids check (
    (ico is null or ico ~ '^[A-Za-z0-9 ./-]{4,20}$')
    and (dic is null or dic ~ '^[A-Za-z0-9 ./-]{4,20}$')
    and (ic_dph is null or ic_dph ~ '^[A-Za-z0-9 ./-]{4,20}$'))
);

alter table public.shop_legal enable row level security;
revoke all on public.shop_legal from public, anon, authenticated;
grant select on public.shop_legal to authenticated;
grant all on public.shop_legal to service_role;
drop policy if exists "shop_legal: members or admin read" on public.shop_legal;
create policy "shop_legal: members or admin read" on public.shop_legal
  for select to authenticated using (public.is_shop_member(shop_id) or public.is_admin());

-- The owner fills in what is missing (or corrects it). Only the fields sent are changed.
create or replace function public.owner_save_legal(p_shop_id uuid, p_details jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text  text;
  v_key   text;
  v_clean jsonb := '{}'::jsonb;
  v_max   constant jsonb := '{"company_name":200,"contact_name":120,"street":200,"city":120,"zip":20,
                              "country":2,"ico":20,"dic":20,"ic_dph":20,"email":200,"phone":30}';
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'Details expected' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_details) loop
    if not v_max ? v_key then
      raise exception 'Unknown field %', v_key using errcode = '22023';
    end if;
    v_text := btrim(regexp_replace(coalesce(p_details ->> v_key, ''), '[[:cntrl:]<>]', ' ', 'g'));
    if v_text = '' then continue; end if;
    if length(v_text) > (v_max ->> v_key)::int then
      raise exception 'Too long: %', v_key using errcode = '22001';
    end if;
    if v_key = 'country' then v_text := upper(v_text); end if;
    if v_key = 'email' then v_text := lower(v_text); end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_text);
  end loop;

  insert into public.shop_legal as l (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  update public.shop_legal l set
    company_name = coalesce(v_clean ->> 'company_name', l.company_name),
    contact_name = coalesce(v_clean ->> 'contact_name', l.contact_name),
    street       = coalesce(v_clean ->> 'street', l.street),
    city         = coalesce(v_clean ->> 'city', l.city),
    zip          = coalesce(v_clean ->> 'zip', l.zip),
    country      = coalesce(v_clean ->> 'country', l.country),
    ico          = coalesce(v_clean ->> 'ico', l.ico),
    dic          = coalesce(v_clean ->> 'dic', l.dic),
    ic_dph       = coalesce(v_clean ->> 'ic_dph', l.ic_dph),
    email        = coalesce(v_clean ->> 'email', l.email),
    phone        = coalesce(v_clean ->> 'phone', l.phone),
    updated_at   = now()
  where l.shop_id = p_shop_id;
end;
$$;
revoke execute on function public.owner_save_legal(uuid, jsonb) from public, anon;
grant execute on function public.owner_save_legal(uuid, jsonb) to authenticated;

-- The registrant as known: the owner's details, else the shop's own profile (its IČO,
-- address, e-mail and phone are the same company's). "missing" lists what must be asked for.
create or replace function public.domain_owner_details(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop  public.shops;
  v_legal public.shop_legal;
  v_out   jsonb;
begin
  -- A logged-in caller only for their own shop (or the admin); the service role (no login) for any.
  if auth.uid() is not null and not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  if not found then return null; end if;
  select * into v_legal from public.shop_legal where shop_id = p_shop_id;
  v_out := jsonb_build_object(
    'company_name', v_legal.company_name,
    'contact_name', v_legal.contact_name,
    'street',       coalesce(v_legal.street, nullif(btrim(v_shop.address), '')),
    'city',         coalesce(v_legal.city, nullif(btrim(v_shop.city), '')),
    'zip',          v_legal.zip,
    'country',      coalesce(v_legal.country, case when v_shop.country ~ '^[A-Za-z]{2}$' then upper(v_shop.country) end),
    'ico',          coalesce(v_legal.ico, nullif(btrim(v_shop.ico), '')),
    'dic',          v_legal.dic,
    'ic_dph',       v_legal.ic_dph,
    'email',        coalesce(v_legal.email, nullif(btrim(v_shop.email), '')),
    'phone',        coalesce(v_legal.phone, nullif(btrim(v_shop.phone), '')));
  return v_out || jsonb_build_object('missing', (
    select coalesce(jsonb_agg(k order by ord), '[]'::jsonb)
    from unnest(array['company_name', 'contact_name', 'street', 'city', 'zip', 'country', 'ico', 'email', 'phone'])
         with ordinality as f(k, ord)
    where nullif(btrim(coalesce(v_out ->> k, '')), '') is null));
end;
$$;
revoke execute on function public.domain_owner_details(uuid) from public, anon;
grant execute on function public.domain_owner_details(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ domain orders

-- Bought:    quoted -> checkout -> paid -> registering -> configuring -> securing -> live
-- Connected: waiting_dns -> verified -> securing -> live
-- Ends:      taken (refunded), failed, dns_timeout (7 days), lapsed (not renewed), ended, canceled
create table if not exists public.domain_orders (
  id                    uuid primary key default gen_random_uuid(),
  shop_id               uuid not null references public.shops (id) on delete cascade,
  kind                  text not null,
  hostname              text not null,
  -- the host the website is served on (= hostname; in test mode the admin's test domain)
  site_host             text,
  -- bare + www (the bare one is the address, www redirects to it); false: one host only
  www                   boolean not null default true,
  status                text not null default 'quoted',
  -- the price the shop saw in step 2, frozen: exactly this is charged (bought only)
  price_cents           integer,
  renewal_cents         integer,
  vat_included          boolean,
  currency              text not null default 'EUR',
  quoted_at             timestamptz,
  with_pro              boolean not null default false,
  site_url              text,
  stripe_session        text,
  stripe_invoice        text,
  stripe_payment_intent text,
  invoice_url           text,
  paid_at               timestamptz,
  refunded_at           timestamptz,
  refund_id             text,
  registrar             text not null default 'websupport',
  registrar_profile_id  text,
  registrar_order_id    text,
  registrar_service_id  text,
  registrar_paid_at     timestamptz,
  test_mode             boolean not null default false,
  waiting_credit        boolean not null default false,
  dns_records           jsonb,
  vercel_added_at       timestamptz,
  checks                integer not null default 0,
  last_check_at         timestamptz,
  next_check_at         timestamptz,
  attempts              integer not null default 0,
  next_attempt_at       timestamptz,
  claimed_until         timestamptz,
  live_at               timestamptz,
  live_email_at         timestamptz,
  dns_reminder_at       timestamptz,
  stuck_alert_at        timestamptz,
  failure_alert_at      timestamptz,
  expires_at            timestamptz,
  renewal_state         text not null default 'none',
  renewal_invoice       text,
  renewal_invoice_url   text,
  renewal_paid_until    timestamptz,
  notice_30_at          timestamptz,
  notice_7_at           timestamptz,
  renewal_reminder_at   timestamptz,
  auth_code             text,
  ended_at              timestamptz,
  last_error            text,
  last_error_at         timestamptz,
  needs_admin           boolean not null default false,
  resolved_at           timestamptz,
  log                   jsonb not null default '[]'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint domain_orders_kind check (kind in ('bought', 'connected')),
  constraint domain_orders_status check (status in ('quoted', 'checkout', 'paid', 'registering', 'configuring', 'securing',
    'live', 'waiting_dns', 'verified', 'taken', 'failed', 'dns_timeout', 'lapsed', 'ended', 'canceled')),
  constraint domain_orders_hostname check (
    hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' and length(hostname) <= 253),
  constraint domain_orders_site_host check (
    site_host is null
    or (site_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' and length(site_host) <= 253)),
  constraint domain_orders_renewal check (renewal_state in ('none', 'due', 'paid', 'failed')),
  constraint domain_orders_bought_price check (kind = 'connected' or (price_cents > 0 and renewal_cents > 0 and vat_included is not null))
);

-- One domain at a time per shop, and a host belongs to one shop at a time.
create unique index if not exists domain_orders_open_per_shop on public.domain_orders (shop_id)
  where status in ('checkout', 'paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified');
create unique index if not exists domain_orders_open_host on public.domain_orders (hostname)
  where status in ('checkout', 'paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified');
create unique index if not exists domain_orders_open_site_host on public.domain_orders (site_host)
  where status in ('paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified');
create index if not exists domain_orders_shop on public.domain_orders (shop_id, created_at desc);
create index if not exists domain_orders_work on public.domain_orders (status, next_attempt_at);

alter table public.domain_orders enable row level security;
revoke all on public.domain_orders from public, anon, authenticated;
grant select on public.domain_orders to authenticated;
grant all on public.domain_orders to service_role;
drop policy if exists "domain_orders: members or admin read" on public.domain_orders;
create policy "domain_orders: members or admin read" on public.domain_orders
  for select to authenticated using (public.is_shop_member(shop_id) or public.is_admin());

-- Every step with its time; the last error stays on the row (the admin page shows it).
create or replace function public.domain_log(p_id uuid, p_step text, p_ok boolean, p_detail text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.domain_orders o set
    log = (select coalesce(jsonb_agg(e order by n), '[]'::jsonb)
           from (select e, n from jsonb_array_elements(
                   o.log || jsonb_build_array(jsonb_build_object(
                     'at', now(), 'step', left(p_step, 60), 'ok', p_ok, 'detail', left(p_detail, 400))))
                   with ordinality as x(e, n)
                 order by n desc limit 60) kept),
    last_error    = case when p_ok then o.last_error else left(coalesce(p_detail, p_step), 400) end,
    last_error_at = case when p_ok then o.last_error_at else now() end,
    updated_at    = now()
  where o.id = p_id
$$;
revoke execute on function public.domain_log(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.domain_log(uuid, text, boolean, text) to service_role;

-- Step 2: the name is free (the function asked Websupport) -> its price is frozen here. A new
-- check replaces the shop's earlier one. Refused: a TLD not in the table, a shop that already
-- has a domain (or one on the way).
create or replace function public.domain_quote(
  p_shop_id uuid, p_hostname text, p_site_url text, p_test_mode boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price public.domain_prices;
  v_id    uuid;
begin
  v_price := public.domain_price_for(p_hostname);
  if v_price.tld is null then
    raise exception 'TLD not sold' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.domain_orders where shop_id = p_shop_id
             and status in ('checkout', 'paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified')) then
    raise exception 'The shop already has a domain' using errcode = '55000';
  end if;
  delete from public.domain_orders where shop_id = p_shop_id and status = 'quoted';
  insert into public.domain_orders
    (shop_id, kind, hostname, status, price_cents, renewal_cents, vat_included, currency, quoted_at, site_url, test_mode)
  values
    (p_shop_id, 'bought', lower(p_hostname), 'quoted', v_price.price_cents, v_price.renewal_cents, v_price.vat_included,
     v_price.currency, now(), left(p_site_url, 200), coalesce(p_test_mode, false))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'hostname', lower(p_hostname), 'tld', v_price.tld,
    'price_cents', v_price.price_cents, 'renewal_cents', v_price.renewal_cents,
    'vat_included', v_price.vat_included, 'currency', v_price.currency);
end;
$$;
revoke execute on function public.domain_quote(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.domain_quote(uuid, text, text, boolean) to service_role;

-- Flow 14: the shop's own domain. Pro only; one domain per shop; a host of another shop is refused.
create or replace function public.domain_connect_start(p_shop_id uuid, p_hostname text, p_www boolean, p_site_url text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'Pro plan required' using errcode = '55000';
  end if;
  if exists (select 1 from public.domain_orders where shop_id = p_shop_id
             and status in ('checkout', 'paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified')) then
    raise exception 'The shop already has a domain' using errcode = '55000';
  end if;
  if exists (select 1 from public.domain_orders where (hostname = lower(p_hostname) or site_host = lower(p_hostname))
             and status in ('checkout', 'paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified')) then
    raise exception 'The domain is used by another shop' using errcode = '23505';
  end if;
  delete from public.domain_orders where shop_id = p_shop_id and status = 'quoted';
  insert into public.domain_orders (shop_id, kind, hostname, site_host, www, status, site_url, next_check_at)
  values (p_shop_id, 'connected', lower(p_hostname), lower(p_hostname), coalesce(p_www, true), 'waiting_dns',
          left(p_site_url, 200), now())
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.domain_connect_start(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.domain_connect_start(uuid, text, boolean, text) to service_role;

-- Stripe confirmed the payment (the webhook, or the one-click payment itself). Idempotent:
-- the second call for the same order changes nothing and answers 'duplicate', so a repeated
-- webhook never orders the domain twice. 'orphan': the order was given up meanwhile (another
-- domain was started) -> the function refunds it.
create or replace function public.domain_payment_received(
  p_id uuid, p_session text, p_invoice text, p_payment_intent text, p_invoice_url text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.domain_orders;
begin
  select * into v_row from public.domain_orders where id = p_id for update;
  if not found or v_row.kind <> 'bought' then
    return 'not_found';
  end if;
  if v_row.paid_at is not null then
    -- Fill in what a later event knows (the invoice of a Checkout payment), never re-run.
    update public.domain_orders set
      stripe_invoice        = coalesce(stripe_invoice, p_invoice),
      stripe_payment_intent = coalesce(stripe_payment_intent, p_payment_intent),
      invoice_url           = coalesce(invoice_url, p_invoice_url),
      updated_at            = now()
    where id = p_id;
    return 'duplicate';
  end if;
  if v_row.status not in ('quoted', 'checkout')
     or exists (select 1 from public.domain_orders o where o.shop_id = v_row.shop_id and o.id <> p_id
                and o.status in ('checkout', 'paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified')) then
    update public.domain_orders set
      paid_at = now(), status = 'canceled', stripe_session = coalesce(p_session, stripe_session),
      stripe_invoice = coalesce(p_invoice, stripe_invoice), stripe_payment_intent = coalesce(p_payment_intent, stripe_payment_intent),
      invoice_url = coalesce(p_invoice_url, invoice_url), updated_at = now()
    where id = p_id;
    perform public.domain_log(p_id, 'paid', false, 'Paid for an order that was given up: refund');
    return 'orphan';
  end if;
  update public.domain_orders set
    status = 'paid', paid_at = now(), next_attempt_at = now(), attempts = 0,
    stripe_session = coalesce(p_session, stripe_session), stripe_invoice = coalesce(p_invoice, stripe_invoice),
    stripe_payment_intent = coalesce(p_payment_intent, stripe_payment_intent),
    invoice_url = coalesce(p_invoice_url, invoice_url), updated_at = now()
  where id = p_id;
  perform public.domain_log(p_id, 'paid', true, null);
  return 'recorded';
end;
$$;
revoke execute on function public.domain_payment_received(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.domain_payment_received(uuid, text, text, text, text) to service_role;

-- A renewal invoice was paid (the webhook, or the daily job's own charge): once only.
create or replace function public.domain_renewal_paid(p_id uuid, p_invoice text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_done boolean;
begin
  update public.domain_orders set renewal_state = 'paid', renewal_invoice = coalesce(p_invoice, renewal_invoice),
         renewal_paid_until = expires_at + interval '1 year', updated_at = now()
  where id = p_id and kind = 'bought' and renewal_state in ('due', 'failed')
    and (p_invoice is null or renewal_invoice is null or renewal_invoice = p_invoice)
  returning true into v_done;
  if coalesce(v_done, false) then
    perform public.domain_log(p_id, 'renewal paid', true, p_invoice);
  end if;
  return coalesce(v_done, false);
end;
$$;
revoke execute on function public.domain_renewal_paid(uuid, text) from public, anon, authenticated;
grant execute on function public.domain_renewal_paid(uuid, text) to service_role;

-- Where the shop's e-mails go: the shop's own address, else its owners' login addresses.
create or replace function public.domain_shop_emails(p_shop_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select array[s.email] from public.shops s where s.id = p_shop_id and nullif(btrim(s.email), '') is not null),
    (select array_agg(distinct u.email::text) from public.shop_members m join auth.users u on u.id = m.user_id
     where m.shop_id = p_shop_id and u.email is not null),
    '{}')
$$;
revoke execute on function public.domain_shop_emails(uuid) from public, anon, authenticated;
grant execute on function public.domain_shop_emails(uuid) to service_role;

-- The work that is due: one worker at a time per order (claimed for 3 minutes).
create or replace function public.domain_claim(p_limit integer default 10)
returns setof uuid
language sql
security definer
set search_path = ''
as $$
  update public.domain_orders o set claimed_until = now() + interval '3 minutes'
  where o.id in (
    select d.id from public.domain_orders d
    where d.status in ('paid', 'registering', 'configuring', 'securing', 'waiting_dns', 'verified')
      and (d.next_attempt_at is null or d.next_attempt_at <= now())
      and (d.claimed_until is null or d.claimed_until < now())
    order by d.next_attempt_at nulls first, d.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked)
  returning o.id
$$;
revoke execute on function public.domain_claim(integer) from public, anon, authenticated;
grant execute on function public.domain_claim(integer) to service_role;

-- The last seen Websupport credit; true once a day while it is under the threshold (e-mail the admin).
create or replace function public.domain_set_credit(p_credit numeric)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert boolean;
begin
  update public.domain_settings s set credit_eur = p_credit, credit_checked_at = now()
  where s.id
  returning p_credit < s.low_credit_eur and (s.credit_alert_at is null or s.credit_alert_at < now() - interval '24 hours')
  into v_alert;
  if coalesce(v_alert, false) then
    update public.domain_settings set credit_alert_at = now() where id;
  end if;
  return coalesce(v_alert, false);
end;
$$;
revoke execute on function public.domain_set_credit(numeric) from public, anon, authenticated;
grant execute on function public.domain_set_credit(numeric) to service_role;

-- ------------------------------------------------------------------ public: hostname -> shop

-- The language of the domain's front page: the shop's country (sk, hu), else English.
create or replace function public.shop_site_lang(p_country text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case upper(coalesce(p_country, '')) when 'SK' then 'sk' when 'HU' then 'hu' else 'en' end
$$;
grant execute on function public.shop_site_lang(text) to anon, authenticated, service_role;

-- Only live domains of active shops with the plan (a Pro that ended, or a domain that was
-- not renewed, takes the shop back to its Cacadoo address). Bare or www, both answer.
create or replace function public.shop_for_host(p_host text)
returns table (slug text, primary_host text, site_lang text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.slug, o.site_host, public.shop_site_lang(s.country)
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  where o.status = 'live'
    and s.is_active
    and public.shop_has_plan(s.id)
    and (o.site_host = lower(btrim(p_host)) or (o.www and 'www.' || o.site_host = lower(btrim(p_host))))
  limit 1
$$;
revoke execute on function public.shop_for_host(text) from public;
grant execute on function public.shop_for_host(text) to anon, authenticated, service_role;

-- The shop's own address for canonical links (null while it has none).
create or replace function public.shop_site(p_slug text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select o.site_host
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  where s.slug = p_slug and o.status = 'live' and s.is_active and public.shop_has_plan(s.id)
  limit 1
$$;
revoke execute on function public.shop_site(text) from public;
grant execute on function public.shop_site(text) to anon, authenticated, service_role;

create or replace function public.live_shop_sites()
returns table (slug text, primary_host text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.slug, o.site_host
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  where o.status = 'live' and s.is_active and public.shop_has_plan(s.id)
$$;
revoke execute on function public.live_shop_sites() from public;
grant execute on function public.live_shop_sites() to anon, authenticated, service_role;

-- ------------------------------------------------------------------ admin

-- Every shop with its plan and its domain (the open one, else the latest).
create or replace function public.admin_domain_overview(p_q text default null, p_status text default null, p_kind text default null)
returns table (
  shop_id uuid, shop_name text, shop_slug text, plan_status text, has_plan boolean,
  period_end timestamptz, cancel_at timestamptz,
  domain_id uuid, kind text, hostname text, site_host text, status text, test_mode boolean,
  last_error text, last_error_at timestamptz, expires_at timestamptz,
  paid_at timestamptz, refunded_at timestamptz, stripe_invoice text, invoice_url text,
  registrar_order_id text, live_email_sent boolean, needs_admin boolean, resolved_at timestamptz,
  waiting_credit boolean, renewal_state text, price_cents integer, created_at timestamptz)
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
  select s.id, s.name, s.slug, coalesce(sub.status, 'none'), public.shop_has_plan(s.id),
         sub.current_period_end, sub.cancel_at,
         o.id, o.kind, o.hostname, o.site_host, o.status, o.test_mode,
         o.last_error, o.last_error_at, o.expires_at,
         o.paid_at, o.refunded_at, o.stripe_invoice, o.invoice_url,
         o.registrar_order_id, o.live_email_at is not null, coalesce(o.needs_admin, false), o.resolved_at,
         coalesce(o.waiting_credit, false), o.renewal_state, o.price_cents, o.created_at
  from public.shops s
  left join public.subscriptions sub on sub.shop_id = s.id
  left join lateral (
    select d.* from public.domain_orders d
    where d.shop_id = s.id and d.status <> 'quoted'
    order by (d.status in ('checkout', 'paid', 'registering', 'configuring', 'securing', 'live', 'waiting_dns', 'verified')) desc,
             d.created_at desc
    limit 1) o on true
  where (nullif(btrim(p_q), '') is null
         or s.name ilike '%' || btrim(p_q) || '%' or s.slug ilike '%' || btrim(p_q) || '%'
         or o.hostname ilike '%' || btrim(p_q) || '%')
    and (nullif(p_status, '') is null
         or (p_status = 'problem' and (o.needs_admin or o.waiting_credit or o.status in ('failed', 'dns_timeout')))
         or (p_status = 'none' and o.id is null)
         or o.status = p_status)
    and (nullif(p_kind, '') is null or o.kind = p_kind)
  order by (o.needs_admin or o.waiting_credit) desc nulls last, o.created_at desc nulls last, s.name;
end;
$$;
revoke execute on function public.admin_domain_overview(text, text, text) from public, anon;
grant execute on function public.admin_domain_overview(text, text, text) to authenticated;

-- Counts (Websupport gives volume discounts at 30, 50 and 100 domains) and the credit.
create or replace function public.admin_domain_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'bought', (select count(*) from public.domain_orders where kind = 'bought' and not test_mode
                 and status in ('paid', 'registering', 'configuring', 'securing', 'live')),
      'connected', (select count(*) from public.domain_orders where kind = 'connected'
                    and status in ('waiting_dns', 'verified', 'securing', 'live')),
      'live', (select count(*) from public.domain_orders where status = 'live'),
      'credit_eur', s.credit_eur, 'credit_checked_at', s.credit_checked_at, 'low_credit_eur', s.low_credit_eur,
      'search_url', s.search_url, 'same_price_as_registrar', s.same_price_as_registrar, 'test_domain', s.test_domain)
    from public.domain_settings s where s.id);
end;
$$;
revoke execute on function public.admin_domain_stats() from public, anon;
grant execute on function public.admin_domain_stats() to authenticated;

create or replace function public.admin_save_domain_settings(
  p_search_url text, p_same_price boolean, p_low_credit numeric, p_test_domain text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  update public.domain_settings set
    search_url = btrim(p_search_url),
    same_price_as_registrar = coalesce(p_same_price, false),
    low_credit_eur = coalesce(p_low_credit, low_credit_eur),
    test_domain = nullif(lower(btrim(coalesce(p_test_domain, ''))), ''),
    updated_at = now()
  where id;
end;
$$;
revoke execute on function public.admin_save_domain_settings(text, boolean, numeric, text) from public, anon;
grant execute on function public.admin_save_domain_settings(text, boolean, numeric, text) to authenticated;

create or replace function public.admin_save_domain_price(
  p_tld text, p_price_cents integer, p_renewal_cents integer, p_vat_included boolean, p_sort integer, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  insert into public.domain_prices as p (tld, price_cents, renewal_cents, vat_included, sort_order, active, updated_at)
  values (lower(btrim(p_tld, '. ')), p_price_cents, p_renewal_cents, coalesce(p_vat_included, true),
          coalesce(p_sort, 100), coalesce(p_active, true), now())
  on conflict (tld) do update set
    price_cents = excluded.price_cents, renewal_cents = excluded.renewal_cents, vat_included = excluded.vat_included,
    sort_order = excluded.sort_order, active = excluded.active, updated_at = now();
end;
$$;
revoke execute on function public.admin_save_domain_price(text, integer, integer, boolean, integer, boolean) from public, anon;
grant execute on function public.admin_save_domain_price(text, integer, integer, boolean, integer, boolean) to authenticated;

create or replace function public.admin_delete_domain_price(p_tld text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  delete from public.domain_prices where tld = lower(btrim(p_tld));
end;
$$;
revoke execute on function public.admin_delete_domain_price(text) from public, anon;
grant execute on function public.admin_delete_domain_price(text) to authenticated;

-- "Vyriešené": the problem flag is cleared (the step log keeps what happened).
create or replace function public.admin_resolve_domain(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  update public.domain_orders set needs_admin = false, resolved_at = now(), updated_at = now() where id = p_id;
  perform public.domain_log(p_id, 'resolved', true, 'Marked resolved by the admin');
end;
$$;
revoke execute on function public.admin_resolve_domain(uuid) from public, anon;
grant execute on function public.admin_resolve_domain(uuid) to authenticated;

-- ------------------------------------------------------------------ jobs (pg_cron + pg_net)

-- Every 5 minutes: the steps of paid orders, DNS checks of connected domains, HTTPS checks.
-- Once a day: credit, renewals, reminders, domains whose plan ended. Uses the Vault secrets
-- ppi_project_url and ppi_assistant_cron (update 22).
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/domains',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_assistant_cron')),
      body := jsonb_build_object('action', '%s'),
      timeout_milliseconds := 120000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-domains-tick', '4-59/5 * * * *', format(v_call, 'tick'));
  perform cron.schedule('ppi-domains-daily', '17 3 * * *', format(v_call, 'daily'));
end;
$$;
