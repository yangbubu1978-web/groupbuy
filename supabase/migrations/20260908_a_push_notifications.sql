-- ============================================================
-- 20260908_a_push_notifications
-- 推播訂閱 + 開賣通知去重日誌 + product_follows 補強
-- 安全遷移：所有變更皆用 IF NOT EXISTS / DO $$ 檢查存在性
-- ============================================================

-- ------------------------------------------------------------
-- 1. product_follows 補約束（已存在於 0000，僅做冪等補強）
-- ------------------------------------------------------------

-- 1a. 確保表存在（若被誤刪則重建；正常情況 IF NOT EXISTS 不做事）
create table if not exists public.product_follows (
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, product_id)
);

-- 1b. 補 unique(user_id, product_id) — 已由 primary key 覆蓋，若 PK 被移除則補上
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_follows'::regclass
      and contype in ('p','u')
      and array_length(conkey,1) = 2
  ) then
    -- 檢查是否已有重複資料，組不出 unique
    if not exists (
      select user_id, product_id, count(*) from public.product_follows
      group by user_id, product_id having count(*) > 1
    ) then
      alter table public.product_follows
        add constraint product_follows_user_product_unique unique (user_id, product_id);
    end if;
  end if;
end $$;

-- 1c. 補 created_at 欄位
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_follows' and column_name = 'created_at'
  ) then
    alter table public.product_follows add column created_at timestamptz not null default now();
  end if;
end $$;

-- 1d. 補 index on product_id
create index if not exists idx_follows_product on public.product_follows(product_id);
create index if not exists idx_follows_user on public.product_follows(user_id);

-- 1e. RLS
alter table public.product_follows enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='product_follows' and policyname='follows_select'
  ) then
    create policy follows_select on public.product_follows
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='product_follows' and policyname='follows_insert'
  ) then
    create policy follows_insert on public.product_follows
      for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='product_follows' and policyname='follows_delete'
  ) then
    create policy follows_delete on public.product_follows
      for delete to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. push_subscriptions 推播訂閱表
-- ------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  endpoint        text        not null unique,
  p256dh          text        not null,
  auth            text        not null,
  expiration_time timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  is_valid        boolean     not null default true
);

create index if not exists idx_push_subscriptions_user on public.push_subscriptions(user_id);
create index if not exists idx_push_subscriptions_endpoint on public.push_subscriptions(endpoint);

-- updated_at 自動更新
create or replace function public.touch_push_subscriptions_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_push_subscriptions_updated_at on public.push_subscriptions;
create trigger trg_push_subscriptions_updated_at
  before update on public.push_subscriptions
  for each row execute function public.touch_push_subscriptions_updated_at();

-- RLS
alter table public.push_subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push_subscriptions_select_own') then
    create policy push_subscriptions_select_own on public.push_subscriptions
      for select to authenticated using (user_id = auth.uid() or public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push_subscriptions_insert_own') then
    create policy push_subscriptions_insert_own on public.push_subscriptions
      for insert to authenticated with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push_subscriptions_update_own') then
    create policy push_subscriptions_update_own on public.push_subscriptions
      for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push_subscriptions_delete_own') then
    create policy push_subscriptions_delete_own on public.push_subscriptions
      for delete to authenticated using (user_id = auth.uid());
  end if;
  -- admin 可全讀（已在 select_own 中用 is_admin() 涵蓋，此處額外補全權 policy 供明確性）
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions' and policyname='push_subscriptions_admin_all') then
    create policy push_subscriptions_admin_all on public.push_subscriptions
      for all to authenticated using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. notification_logs 開賣通知發送日誌（含去重鍵）
-- ------------------------------------------------------------
create table if not exists public.notification_logs (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  product_id   uuid        not null references public.products(id) on delete cascade,
  type         text        not null default 'sale_start',
  sent_at      timestamptz not null default now(),
  push_success boolean,
  dedup_key    text        not null unique,
  created_at   timestamptz not null default now()
  -- dedup_key 格式：user_id:product_id:sale_start_at (ISO8601)
);

create index if not exists idx_notification_logs_user on public.notification_logs(user_id);
create index if not exists idx_notification_logs_product on public.notification_logs(product_id);
create index if not exists idx_notification_logs_dedup on public.notification_logs(dedup_key);
create index if not exists idx_notification_logs_sent_at on public.notification_logs(sent_at);

-- RLS：用戶只能讀自己的，寫入由 Service Role（bypass RLS）執行
alter table public.notification_logs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notification_logs' and policyname='notification_logs_select_own') then
    create policy notification_logs_select_own on public.notification_logs
      for select to authenticated using (user_id = auth.uid() or public.is_admin());
  end if;
  -- 不對 authenticated 開放 insert/update/delete，僅 service_role（bypass RLS）可寫
  -- 若需讓 admin 也能寫，另建 admin policy（可選）
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notification_logs' and policyname='notification_logs_admin_write') then
    create policy notification_logs_admin_write on public.notification_logs
      for all to authenticated using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;
