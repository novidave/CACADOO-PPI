-- PPI · 2/5 · Tables (docs/PRD.md section 5)

-- Login profile, one per auth user. Created automatically on sign-up.
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  language     text not null default 'sk' check (language in ('sk', 'hu', 'en')),
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table public.shops (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                text not null,
  ico                 text,
  address             text,
  city                text not null default 'Michalovce',
  location            extensions.geography(Point, 4326),
  phone               text,
  website             text,
  -- {"mon":[["08:00","17:00"]], ..., "sun":[]}
  opening_hours       jsonb not null default '{}'::jsonb,
  visibility_mode     text not null default 'in_stock'
                      check (visibility_mode in ('exact', 'in_stock', 'yes_no')),
  low_stock_threshold integer not null default 3 check (low_stock_threshold between 1 and 50),
  logo_url            text,
  is_active           boolean not null default false,
  created_at          timestamptz not null default now()
);

create index shops_location_idx on public.shops using gist (location);

create table public.shop_members (
  shop_id    uuid not null references public.shops (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);

create index shop_members_user_idx on public.shop_members (user_id);

-- One row per real product, matched across shops by EAN.
create table public.products (
  id         uuid primary key default gen_random_uuid(),
  ean        text unique,
  brand      text,
  name       text not null,
  category   text,
  created_at timestamptz not null default now()
);

-- One row per item in a shop's own software (source_code = the shop's item code).
create table public.shop_items (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops (id) on delete cascade,
  source_code text not null,
  product_id  uuid references public.products (id) on delete set null,
  name        text not null,
  ean         text,
  brand       text,
  is_public   boolean not null default true,
  updated_at  timestamptz not null default now(),
  unique (shop_id, source_code)
);

create index shop_items_shop_idx on public.shop_items (shop_id);
create index shop_items_ean_idx on public.shop_items (ean);
create index shop_items_name_search_idx
  on public.shop_items using gin (public.search_text(name) extensions.gin_trgm_ops);
create index shop_items_brand_search_idx
  on public.shop_items using gin (public.search_text(brand) extensions.gin_trgm_ops);

-- Current stock per item. Written only by the stock-pull function (service role).
create table public.inventory (
  shop_item_id      uuid primary key references public.shop_items (id) on delete cascade,
  quantity          numeric not null default 0,
  price             numeric check (price is null or price >= 0),
  currency          text not null default 'EUR',
  source_updated_at timestamptz,
  received_at       timestamptz not null default now()
);

-- Where and how each shop's stock file is pulled. Admin and service role only.
create table public.sync_sources (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null unique references public.shops (id) on delete cascade,
  file_format      text not null default 'xml' check (file_format in ('xml', 'csv', 'xlsx')),
  field_mapping    jsonb,
  mapping_status   text not null default 'proposed' check (mapping_status in ('proposed', 'confirmed')),
  file_url         text,
  latest_file_time timestamptz,
  last_checked_at  timestamptz,
  last_error       text,
  created_at       timestamptz not null default now()
);

-- Public API / MCP request log (hashed IP only, no personal data).
create table public.api_usage (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  endpoint   text not null,
  created_at timestamptz not null default now()
);

create index api_usage_ip_time_idx on public.api_usage (ip_hash, created_at desc);
