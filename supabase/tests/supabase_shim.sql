-- Minimal stand-in for the parts of Supabase the migrations rely on
-- (auth schema, auth.uid(), anon/authenticated/service_role roles), so the
-- migrations and tests can run on a plain local Postgres with PostGIS.
-- NOT for use on Supabase: Supabase already has all of this.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  -- Same as Supabase: the old per-claim setting (used by the SQL tests) or the
  -- JSON claims PostgREST sets for each request.
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Minimal Supabase Vault stand-in (real Vault encrypts; this only mimics the API).
create schema if not exists vault;
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text,
  secret text
);
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as $$
  insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id
$$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null)
returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id
$$;
create or replace view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
revoke all on schema vault from anon, authenticated;

-- Minimal pg_cron stand-in (real pg_cron runs the jobs; this only mimics cron.job and
-- cron.unschedule). It starts with the old 15-minute download job, as in a project that
-- followed the old SETUP.md part G4, plus an unrelated job that must survive.
create schema if not exists cron;
create table if not exists cron.job (
  jobid bigserial primary key,
  jobname text,
  schedule text,
  command text
);
create or replace function cron.unschedule(job_id bigint)
returns boolean language sql as $$
  with gone as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from gone)
$$;
-- cron.schedule(name, schedule, command): a job with the same name is replaced, as in pg_cron.
create or replace function cron.schedule(p_job_name text, p_schedule text, p_command text)
returns bigint language plpgsql as $$
declare
  v_id bigint;
begin
  update cron.job set schedule = p_schedule, command = p_command where jobname = p_job_name returning jobid into v_id;
  if v_id is null then
    insert into cron.job (jobname, schedule, command) values (p_job_name, p_schedule, p_command) returning jobid into v_id;
  end if;
  return v_id;
end;
$$;
insert into cron.job (jobname, schedule, command) values
  ('ppi-stock-pull', '*/15 * * * *', 'select 1'),
  ('some-other-job', '0 3 * * *', 'select 1');
revoke all on schema cron from anon, authenticated;
