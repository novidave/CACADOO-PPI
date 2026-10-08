-- PPI · 18 · Paid plan per shop (Stripe; test mode first).
--  - subscriptions: one row per shop with its Stripe customer and subscription. Owners
--    read their own row; only the service role writes it, through two functions used by
--    the Edge Functions: link_stripe_customer() (stripe-checkout, before the first payment
--    page) and apply_stripe_subscription() (stripe-webhook, after Stripe's signed event)
--  - shop_has_plan(shop): the one check for every paid feature = status active or
--    trialing and not past current_period_end
--  - owner_delete_shop() refuses a shop whose paid plan still renews
-- Safe to run again.

create table if not exists public.subscriptions (
  shop_id                uuid primary key references public.shops (id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  -- 'none': the shop has a Stripe customer (payment page opened) but no subscription yet;
  -- every other value is the subscription's status in Stripe
  status                 text not null default 'none'
                         check (status in ('none', 'incomplete', 'incomplete_expired', 'trialing', 'active',
                                           'past_due', 'canceled', 'unpaid', 'paused')),
  plan                   text,
  current_period_end     timestamptz,
  -- set when the subscription will end instead of renewing (cancelled in the customer portal)
  cancel_at              timestamptz,
  updated_at             timestamptz not null default now(),
  constraint subscriptions_status_needs_subscription check (status = 'none' or stripe_subscription_id is not null)
);

alter table public.subscriptions enable row level security;

-- Privileges first (the policy only narrows them): visitors nothing, owners read only,
-- writes only by the service role (it bypasses RLS).
revoke all on public.subscriptions from public, anon, authenticated;
grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

drop policy if exists "subscriptions: owner or admin read" on public.subscriptions;
create policy "subscriptions: owner or admin read" on public.subscriptions
  for select to authenticated
  using (public.is_shop_member(shop_id) or public.is_admin());

-- The one check for every paid feature.
create or replace function public.shop_has_plan(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.shop_id = p_shop_id
      and s.status in ('active', 'trialing')
      and s.current_period_end > now()
  )
$$;

revoke execute on function public.shop_has_plan(uuid) from public;
grant execute on function public.shop_has_plan(uuid) to anon, authenticated, service_role;

-- stripe-checkout: remember the shop's Stripe customer before its first payment page.
-- The first customer stays; returns the one to use.
create or replace function public.link_stripe_customer(p_shop_id uuid, p_customer text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_customer text;
begin
  if p_customer is null or p_customer !~ '^cus_[A-Za-z0-9]+$' then
    raise exception 'Invalid Stripe customer id' using errcode = '22023';
  end if;
  insert into public.subscriptions as s (shop_id, stripe_customer_id)
  values (p_shop_id, p_customer)
  on conflict (shop_id) do update
    set stripe_customer_id = coalesce(s.stripe_customer_id, excluded.stripe_customer_id),
        updated_at = now()
  returning s.stripe_customer_id into v_customer;
  return v_customer;
end;
$$;

revoke execute on function public.link_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.link_stripe_customer(uuid, text) to service_role;

-- stripe-webhook: the subscription as Stripe has it now (the function fetches it fresh for
-- every event, so the order of events does not matter). A live subscription is never
-- replaced by an older one that has ended. Returns false when nothing was written: the
-- shop no longer exists, or the event is about an ended subscription the shop replaced.
create or replace function public.apply_stripe_subscription(
  p_shop_id uuid,
  p_customer text,
  p_subscription text,
  p_status text,
  p_plan text,
  p_current_period_end timestamptz,
  p_cancel_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_live constant text[] := array['trialing', 'active', 'past_due', 'unpaid', 'paused'];
  v_row public.subscriptions;
begin
  if p_subscription is null or p_subscription !~ '^sub_[A-Za-z0-9]+$' then
    raise exception 'Invalid Stripe subscription id' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('incomplete', 'incomplete_expired', 'trialing', 'active',
                                           'past_due', 'canceled', 'unpaid', 'paused') then
    raise exception 'Unknown subscription status %', p_status using errcode = '22023';
  end if;
  if not exists (select 1 from public.shops where id = p_shop_id) then
    return false;
  end if;

  select * into v_row from public.subscriptions where shop_id = p_shop_id for update;
  if found
     and v_row.stripe_subscription_id is not null
     and v_row.stripe_subscription_id <> p_subscription
     and v_row.status = any (v_live)
     and not (p_status = any (v_live)) then
    return false;
  end if;

  insert into public.subscriptions as s
    (shop_id, stripe_customer_id, stripe_subscription_id, status, plan, current_period_end, cancel_at, updated_at)
  values
    (p_shop_id, p_customer, p_subscription, p_status, p_plan, p_current_period_end, p_cancel_at, now())
  on conflict (shop_id) do update
    set stripe_customer_id     = coalesce(excluded.stripe_customer_id, s.stripe_customer_id),
        stripe_subscription_id = excluded.stripe_subscription_id,
        status                 = excluded.status,
        plan                   = excluded.plan,
        current_period_end     = excluded.current_period_end,
        cancel_at              = excluded.cancel_at,
        updated_at             = now();
  return true;
end;
$$;

revoke execute on function public.apply_stripe_subscription(uuid, text, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription(uuid, text, text, text, text, timestamptz, timestamptz)
  to service_role;

-- The owner deletes one of their shops (items, stock, stock source and plan row go with
-- it) — but not while its paid plan still renews, or it would keep being charged: cancel
-- it first under Plan → Manage subscription.
create or replace function public.owner_delete_shop(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.subscriptions s
    where s.shop_id = p_shop_id
      and s.status in ('trialing', 'active', 'past_due', 'unpaid', 'paused')
      and s.cancel_at is null
  ) then
    raise exception 'Cancel the paid plan first' using errcode = '55000';
  end if;
  delete from public.shops where id = p_shop_id;
end;
$$;

revoke execute on function public.owner_delete_shop(uuid) from public, anon;
grant execute on function public.owner_delete_shop(uuid) to authenticated;
