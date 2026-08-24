-- ============================================================
-- 本機 PostgreSQL 測試用：模擬 Supabase 環境
-- （auth.users / auth.uid() / roles / request.jwt.claims）
-- 僅供 tests.sql 執行環境使用，正式環境請直接用 Supabase
-- ============================================================

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  encrypted_password text,
  last_sign_in_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 模擬 auth.uid()：讀取目前交易的 JWT claims（Supabase 同款行為）
create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid;
$$;

-- PostgREST 角色模擬
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

grant usage on schema public to authenticated, anon, service_role;
