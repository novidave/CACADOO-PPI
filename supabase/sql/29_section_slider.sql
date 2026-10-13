-- PPI · 29 · Page sections: "Zobrazenie strán" – a slider (default) or the pages one under another. Paste the whole file into the Supabase SQL Editor and Run.
--  Needs update 28. Shop profile content, not stock:
--  - shop_page_sections.page_layout: 'slider' (one page at a time, default; also for the sections
--    already there) or 'stacked' ("Pod sebou"). Changed only through owner_save_section(), which
--    takes it as a ninth, optional parameter (left out: a new section gets the slider, a saved one
--    keeps its choice).
--  - shop_sections() also returns it, so the page knows how to show each section.
-- Safe to run again.

alter table public.shop_page_sections add column if not exists page_layout text not null default 'slider';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_page_sections_page_layout_check') then
    alter table public.shop_page_sections
      add constraint shop_page_sections_page_layout_check check (page_layout in ('slider', 'stacked'));
  end if;
end;
$$;

-- As in update 28, plus "Zobrazenie strán" (p_page_layout: null = a new section's slider, or keep).
drop function if exists public.owner_save_section(uuid, uuid, text, text, text, boolean, date, date);
create or replace function public.owner_save_section(
  p_shop_id uuid, p_section_id uuid, p_title text, p_display text, p_position text,
  p_allow_download boolean, p_from date, p_until date, p_page_layout text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := public.plain_text(p_title, 80);
  v_id uuid := p_section_id;
  v_old_position text;
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  if v_title is null or length(btrim(v_title)) = 0 then
    raise exception 'title' using errcode = 'P0001';
  end if;
  if coalesce(p_display, '') not in ('collapsed', 'open')
     or coalesce(p_position, '') not in ('after_details', 'after_map', 'before_items', 'end')
     or coalesce(p_page_layout, 'slider') not in ('slider', 'stacked') then
    raise exception 'bad' using errcode = 'P0001';
  end if;
  if p_from is not null and p_until is not null and p_until < p_from then
    raise exception 'dates' using errcode = 'P0001';
  end if;

  if v_id is null then
    perform 1 from public.shops where id = p_shop_id for update;
    if (select count(*) from public.shop_page_sections where shop_id = p_shop_id) >= 10 then
      raise exception 'limit' using errcode = 'P0001';
    end if;
    insert into public.shop_page_sections (shop_id, title, display, position, sort, allow_download, visible_from, visible_until,
                                           page_layout)
    values (p_shop_id, v_title, p_display, p_position,
            coalesce((select max(sort) + 1 from public.shop_page_sections where shop_id = p_shop_id and position = p_position), 0),
            coalesce(p_allow_download, false), p_from, p_until, coalesce(p_page_layout, 'slider'))
    returning id into v_id;
    return v_id;
  end if;

  select position into v_old_position from public.shop_page_sections where id = v_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.shop_page_sections
  set title = v_title, display = p_display, position = p_position, allow_download = coalesce(p_allow_download, false),
      visible_from = p_from, visible_until = p_until, page_layout = coalesce(p_page_layout, page_layout), updated_at = now(),
      sort = case when p_position = v_old_position then sort
                  else coalesce((select max(o.sort) + 1 from public.shop_page_sections o
                                 where o.shop_id = p_shop_id and o.position = p_position), 0) end
  where id = v_id;
  return v_id;
end;
$$;
revoke execute on function public.owner_save_section(uuid, uuid, text, text, text, boolean, date, date, text) from public, anon;
grant execute on function public.owner_save_section(uuid, uuid, text, text, text, boolean, date, date, text) to authenticated;


-- As in update 28, plus page_layout (last).
drop function if exists public.shop_sections(text);
create or replace function public.shop_sections(p_slug text)
returns table (id uuid, title text, display text, "position" text, sort integer, allow_download boolean,
               version integer, pages jsonb, page_layout text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.title, s.display, s.position, s.sort, s.allow_download, s.version,
         coalesce((select jsonb_agg(jsonb_build_object('page', p.page, 'width', p.width, 'height', p.height,
                                                       'ext', p.ext, 'text', p.text) order by p.page)
                   from public.shop_section_pages p
                   where p.section_id = s.id and p.version = s.version), '[]'::jsonb),
         s.page_layout
  from public.shop_page_sections s
  join public.shops sh on sh.id = s.shop_id
  where sh.slug = p_slug and public.section_shown(s.id)
  order by s.position, s.sort, s.created_at
$$;
revoke execute on function public.shop_sections(text) from public;
grant execute on function public.shop_sections(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
