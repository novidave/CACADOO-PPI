-- PPI · database update 82: the kitchen's times for the owner's AI tools (Objednávky jedla feed, phase F5d)
--
-- The Telegram bot's "Meškanie" button (0 · +10 · +20 · +30 · +45) and the AI pomocník propose set_food_delay with
-- before → after, like every write. "Before" needs the shop's times, and every read of the bot goes through the owner
-- MCP's one door — so list_food_orders (shop.read, update 74) now also answers with them:
--   times = food_times() (prep_minutes, delivery_minutes, delay_minutes, delay_reset, warn_long_delay,
--           ready_pickup_min, ready_delivery_min, long_delay) + parts = food_parts() (delivery, courier_app, payments,
--           register, qr_terminal, on)
-- Nothing else changes: update 81's door is kept as owner_mcp_call_81 and decides every call (the token, the scope,
-- the shop, the plan); this one only adds the two objects to list_food_orders' answer for the shop that door named.
-- No table, no data change.

do $$
begin
  if to_regprocedure('public.owner_mcp_call_81(text, text, jsonb)') is null
     and to_regprocedure('public.owner_mcp_call(text, text, jsonb)') is not null then
    alter function public.owner_mcp_call(text, text, jsonb) rename to owner_mcp_call_81;
  end if;
end;
$$;
revoke execute on function public.owner_mcp_call_81(text, text, jsonb) from public, anon, authenticated;

create or replace function public.owner_mcp_call(p_token text, p_tool text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_shop uuid;
begin
  r := public.owner_mcp_call_81(p_token, p_tool, p_args);
  if p_tool = 'list_food_orders' and jsonb_typeof(r -> 'result') = 'object' then
    -- the shop update 81's door checked and named (the grant's own shop)
    select id into v_shop from public.shops where slug = r ->> 'shop';
    if v_shop is not null then
      r := jsonb_set(r, '{result}', (r -> 'result')
             || jsonb_build_object('times', public.food_times(v_shop), 'parts', public.food_parts(v_shop)));
    end if;
  end if;
  return r;
end;
$$;
revoke execute on function public.owner_mcp_call(text, text, jsonb) from public;
grant execute on function public.owner_mcp_call(text, text, jsonb) to anon, authenticated, service_role;
