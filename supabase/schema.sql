-- ============================================================
-- 封閉式動態降價團購平台 — Supabase PostgreSQL Schema
-- 版本: v1.0
-- 執行方式: Supabase Dashboard → SQL Editor → 貼上執行
--
-- 內容:
--   1. 列舉與資料表（companies / customer_groups / customers /
--      campaigns / products / orders）
--   2. 動態降價函式 compute_current_price()
--   3. 原子搶購函式 purchase_product()（單一 SQL 交易，防超賣）
--   4. RLS 政策（客戶只能看授權活動、admin 全權）
--   5. Realtime 發布設定
--   6. 種子資料（示範公司、群組、客戶、活動、商品）
-- ============================================================

-- ============================================================
-- 0. 清除（重複執行用）
-- ============================================================
drop function if exists public.purchase_product(uuid, int);
drop function if exists public.compute_current_price(public.products) cascade;
drop table if exists public.orders cascade;
drop table if exists public.products cascade;
drop table if exists public.campaign_customers cascade;
drop table if exists public.campaign_groups cascade;
drop table if exists public.campaign_companies cascade;
drop table if exists public.campaigns cascade;
drop table if exists public.customers cascade;
drop table if exists public.customer_groups cascade;
drop table if exists public.companies cascade;
drop table if exists public.admins cascade;
drop type if exists public.user_status, public.campaign_status,
  public.product_status, public.order_status;

-- ============================================================
-- 1. 列舉型別
-- ============================================================
create type public.user_status as enum ('active', 'inactive', 'blocked');
create type public.campaign_status as enum (
  'draft', 'scheduled', 'active', 'ended', 'cancelled'
);
create type public.product_status as enum ('active', 'paused');
create type public.order_status as enum (
  'pending', 'confirmed', 'paid', 'shipped', 'completed', 'cancelled'
);

-- ============================================================
-- 2. 資料表
-- ============================================================

-- 公司／組織（多公司預留）
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  note        text,
  status      text not null default 'active',
  created_at  timestamptz not null default now()
);

-- 客戶群組（可屬於某公司，或 null 代表跨公司通用群組）
create table public.customer_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company_id  uuid references public.companies(id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now(),
  unique (name, company_id)
);

-- 客戶（白名單；禁止自行註冊）
-- 手機號碼統一儲存為 09XXXXXXXX（寫入前經 normalize_phone() 正規化）
create table public.customers (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users(id) on delete set null,
  name          text not null,
  phone         text unique
                check (phone is null or phone ~ '^09\d{8}$'),
  company_id    uuid not null references public.companies(id),
  group_id      uuid references public.customer_groups(id),
  role          text not null default 'customer',
  status        public.user_status not null default 'active',
  last_login_at timestamptz,
  created_at    timestamptz not null default now()
);
create index idx_customers_company on public.customers(company_id);
create index idx_customers_auth    on public.customers(auth_user_id);

-- 團購活動
create table public.campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  status      public.campaign_status not null default 'draft',
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  constraint chk_campaign_time check (end_at > start_at)
);

-- 活動 ↔ 公司（多對多）
create table public.campaign_companies (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  primary key (campaign_id, company_id)
);

-- 活動 ↔ 客戶群組（多對多）
create table public.campaign_groups (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  group_id    uuid not null references public.customer_groups(id) on delete cascade,
  primary key (campaign_id, group_id)
);

-- 活動 ↔ 個別客戶（多對多）
create table public.campaign_customers (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  primary key (campaign_id, customer_id)
);

-- 商品
create table public.products (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references public.campaigns(id) on delete cascade,
  name                  text not null,
  description           text,
  image_url             text,
  sku                   text not null,
  original_price        numeric(12,2) not null check (original_price >= 0),
  minimum_price         numeric(12,2) not null check (minimum_price >= 0),
  price_interval_seconds int not null default 60 check (price_interval_seconds > 0),
  price_decrease        numeric(12,2) not null default 10 check (price_decrease >= 0),
  initial_stock         int not null default 0 check (initial_stock >= 0),
  stock                 int not null default 0 check (stock >= 0),
  max_per_customer      int not null default 1 check (max_per_customer >= 1),
  status                public.product_status not null default 'active',
  sale_start_at         timestamptz,
  sale_end_at           timestamptz,
  last_order_at         timestamptz,
  created_at            timestamptz not null default now(),
  constraint chk_price_range check (minimum_price <= original_price)
);
-- chk_stock_range 已移除（2026-08-23）：取消/退款回補庫存可超過 initial_stock
-- （補貨或後台調整後，「初始庫存」不再是庫存上限）
create index idx_products_campaign on public.products(campaign_id);

-- 訂單（快照制：成立後不受商品改價影響）
create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_no          text not null unique,
  user_id           uuid not null references auth.users(id),
  customer_id       uuid references public.customers(id),
  product_id        uuid references public.products(id),
  campaign_id       uuid references public.campaigns(id),
  product_name_snapshot text not null,
  sku_snapshot      text not null,
  unit_price        numeric(12,2) not null,
  quantity          int not null check (quantity >= 1),
  total_amount      numeric(12,2) not null,
  status            public.order_status not null default 'pending',
  purchased_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_orders_user     on public.orders(user_id);
create index idx_orders_product  on public.orders(product_id);
create index idx_orders_campaign on public.orders(campaign_id);

-- 訂單明細（成交當下快照；之後商品改價不影響歷史訂單）
create table public.order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders(id) on delete cascade,
  product_id            uuid references public.products(id),
  product_name_snapshot text not null,
  sku_snapshot          text not null,
  unit_price            numeric(12,2) not null,
  quantity              int not null check (quantity >= 1),
  subtotal              numeric(12,2) not null,
  created_at            timestamptz not null default now()
);
create index idx_order_items_order on public.order_items(order_id);

-- ============================================================
-- 3. 動態降價計算（Server 端唯一權威）
--    current = max(minimum, original - floor(elapsed/interval)*decrease)
-- ============================================================
create or replace function public.compute_current_price(p public.products)
returns numeric
language sql stable
as $$
  select greatest(
    p.minimum_price,
    p.original_price
      - floor(
          greatest(0, extract(epoch from (now() - coalesce(p.sale_start_at, now()))))
          / p.price_interval_seconds
        ) * p.price_decrease
  );
$$;

-- ============================================================
-- 4. 原子搶購（防超賣核心）
--    在「同一個 SQL 交易」內完成：
--    驗證 → 計價 → 條件式扣庫存 → 建立訂單
--    回傳 jsonb: { ok, reason?, order_no?, unit_price?, ... }
-- ============================================================
create or replace function public.purchase_product(
  p_product_id uuid,
  p_quantity   int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id       uuid := auth.uid();
  v_customer      public.customers%rowtype;
  v_product       public.products%rowtype;
  v_campaign      public.campaigns%rowtype;
  v_now           timestamptz := now();
  v_unit_price    numeric(12,2);
  v_order_no      text;
  v_order_id      uuid;
  v_already       int;
  v_updated       int;
begin
  -- (1) 必須登入
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  -- (2) 白名單客戶必須存在且 active
  select * into v_customer from public.customers
    where auth_user_id = v_user_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_whitelisted');
  end if;
  if v_customer.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'account_' || v_customer.status::text);
  end if;

  -- (3) 取得商品並鎖定該列（同商品搶購在此排隊，確保序列化）
  select * into v_product from public.products
    where id = p_product_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'product_not_found');
  end if;
  if v_product.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'product_paused');
  end if;

  -- (4) 活動必須是 active 且在時間範圍內
  select * into v_campaign from public.campaigns
    where id = v_product.campaign_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_found');
  end if;
  if v_campaign.status <> 'active' or v_now < v_campaign.start_at or v_now > v_campaign.end_at then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_active');
  end if;

  -- (5) 授權檢查：全部客戶 / 指定公司 / 指定群組 / 指定個人
  if exists (select 1 from public.campaign_companies cc where cc.campaign_id = v_campaign.id)
     and not exists (
       select 1 from public.campaign_companies cc
       where cc.campaign_id = v_campaign.id and cc.company_id = v_customer.company_id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if exists (select 1 from public.campaign_groups cg where cg.campaign_id = v_campaign.id)
     and not exists (
       select 1 from public.campaign_groups cg
       where cg.campaign_id = v_campaign.id and cg.group_id = v_customer.group_id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if exists (select 1 from public.campaign_customers cx where cx.campaign_id = v_campaign.id)
     and not exists (
       select 1 from public.campaign_customers cx
       where cx.campaign_id = v_campaign.id and cx.customer_id = v_customer.id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  -- (6) Server 端重新計算當下價格（絕不相信前端價格）
  v_unit_price := public.compute_current_price(v_product);

  -- (7) 每人限購檢查
  select coalesce(sum(quantity), 0) into v_already
    from public.orders
    where user_id = v_user_id
      and product_id = p_product_id
      and status <> 'cancelled';
  if v_already + p_quantity > v_product.max_per_customer then
    return jsonb_build_object(
      'ok', false, 'reason', 'limit_reached',
      'limit', v_product.max_per_customer,
      'purchased', v_already
    );
  end if;

  -- (8) 數量合理性
  if p_quantity < 1 or p_quantity > v_product.max_per_customer then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- (4b) FOMO 超時結束：已到達底價，且又過了一個降價週期仍無人買完 → 自動結束檔次
  if v_now >= coalesce(v_product.sale_start_at, v_now)
     and public.compute_current_price(v_product) <= v_product.minimum_price
     and v_now > coalesce(v_product.sale_start_at, v_now)
         + (extract(epoch from (v_now - coalesce(v_product.sale_start_at, v_now)))::int
            / greatest(v_product.price_interval_seconds, 1)) * interval '1 second'
         + make_interval(secs => v_product.price_interval_seconds)
  then
    update public.products set status = 'ended' where id = p_product_id;
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  -- (9) 條件式原子扣庫存（防超賣關鍵）：
  --     只有 stock >= 購買數量時才會更新成功
  update public.products
    set stock = stock - p_quantity
    where id = p_product_id
      and stock >= p_quantity;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'reason', 'sold_out');
  end if;

  -- (10) 建立訂單（主檔快照）
  v_order_no := 'ORDER-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.orders (
    order_no, user_id, customer_id, product_id, campaign_id,
    product_name_snapshot, sku_snapshot,
    unit_price, quantity, total_amount, status, purchased_at
  ) values (
    v_order_no, v_user_id, v_customer.id, p_product_id, v_campaign.id,
    v_product.name, v_product.sku,
    v_unit_price, p_quantity, v_unit_price * p_quantity,
    'pending', v_now
  ) returning id into v_order_id;

  -- (10b) 建立訂單明細（order_items 快照）
  insert into public.order_items (
    order_id, product_id, product_name_snapshot, sku_snapshot,
    unit_price, quantity, subtotal
  ) values (
    v_order_id, p_product_id, v_product.name, v_product.sku,
    v_unit_price, p_quantity, v_unit_price * p_quantity
  );

  return jsonb_build_object(
    'ok', true,
    'order_no', v_order_no,
    'unit_price', v_unit_price,
    'quantity', p_quantity,
    'total_amount', v_unit_price * p_quantity,
    'remaining_stock', v_product.stock - p_quantity
  );
exception
  when others then
    return jsonb_build_object('ok', false, 'reason', 'server_error', 'detail', sqlerrm);
end;
$$;

-- ============================================================
-- 5. RLS
-- ============================================================
alter table public.companies         enable row level security;
alter table public.customer_groups   enable row level security;
alter table public.customers         enable row level security;
alter table public.campaigns         enable row level security;
alter table public.campaign_companies enable row level security;
alter table public.campaign_groups   enable row level security;
alter table public.campaign_customers enable row level security;
alter table public.products          enable row level security;
alter table public.orders            enable row level security;

-- helper: 是否為管理員（admins 資料表；service_role 永遠繞過 RLS）
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a where a.user_id = auth.uid()
  );
$$;

create policy admins_self_read on public.admins
  for select using (user_id = auth.uid() or public.is_admin());

-- helper: 目前使用者是否可見某活動（RLS 共用邏輯）
create or replace function public.can_see_campaign(p_campaign uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.campaigns ca
    where ca.id = p_campaign
      and (
        public.is_admin()
        or (
          ca.status in ('active', 'ended')
          and exists (
            select 1 from public.customers c
            where c.auth_user_id = auth.uid() and c.status = 'active'
          )
          and (
            -- 全部客戶：沒有任何限定條件
            (
              not exists (select 1 from public.campaign_companies x where x.campaign_id = ca.id)
              and not exists (select 1 from public.campaign_groups x where x.campaign_id = ca.id)
              and not exists (select 1 from public.campaign_customers x where x.campaign_id = ca.id)
            )
            -- 或符合任一指定條件
            or exists (
              select 1 from public.campaign_companies x
              join public.customers c on c.company_id = x.company_id
              where x.campaign_id = ca.id and c.auth_user_id = auth.uid()
            )
            or exists (
              select 1 from public.campaign_groups x
              join public.customers c on c.group_id = x.group_id
              where x.campaign_id = ca.id and c.auth_user_id = auth.uid()
            )
            or exists (
              select 1 from public.campaign_customers x
              join public.customers c on c.id = x.customer_id
              where x.campaign_id = ca.id and c.auth_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

-- ---------- companies ----------
create policy companies_read on public.companies
  for select to authenticated using (true);

-- ---------- customer_groups ----------
create policy groups_read on public.customer_groups
  for select to authenticated using (true);

-- ---------- customers ----------
create policy customers_self on public.customers
  for select to authenticated
  using (auth_user_id = auth.uid() or public.is_admin());
create policy customers_admin_all on public.customers
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- campaigns ----------
create policy campaigns_read_authorized on public.campaigns
  for select to authenticated
  using (public.can_see_campaign(id));

-- ---------- campaign 授權明細表 ----------
create policy cc_read on public.campaign_companies
  for select to authenticated using (true);
create policy cg_read on public.campaign_groups
  for select to authenticated using (true);
create policy cx_read on public.campaign_customers
  for select to authenticated using (true);

-- ---------- products ----------
create policy products_read on public.products
  for select to authenticated
  using (public.can_see_campaign(campaign_id));

-- ---------- orders ----------
create policy orders_own on public.orders
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- ---------- order_items（跟著所屬訂單的權限）----------
create policy order_items_read on public.order_items
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_items.order_id
        and (o.user_id = auth.uid() or public.is_admin())
    )
  );

-- ---------- admin 寫入權 ----------
create policy campaigns_admin_write on public.campaigns
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy cc_admin_write on public.campaign_companies
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy cg_admin_write on public.campaign_groups
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy cx_admin_write on public.campaign_customers
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy products_admin_write on public.products
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy orders_admin_write on public.orders
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy companies_admin_write on public.companies
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy groups_admin_write on public.customer_groups
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 6. Realtime（publication 不存在時（如本機測試）自動略過）
-- ============================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.products';
    execute 'alter publication supabase_realtime add table public.orders';
  end if;
exception
  when duplicate_object then null; -- 已加入過（重複執行 schema 時）
end $$;

-- ============================================================
-- 7. 種子資料
-- ============================================================
insert into public.companies (name, note) values
  ('公司 A', '示範用'),
  ('公司 B', '示範用');

insert into public.customer_groups (name, company_id) values
  ('一般員工', (select id from public.companies where name='公司 A')),
  ('主管群',   (select id from public.companies where name='公司 A')),
  ('一般員工', (select id from public.companies where name='公司 B'));

insert into public.customers (name, phone, company_id, group_id, status) values
  ('王小明', '0975389197',
   (select id from public.companies where name='公司 A'),
   (select id from public.customer_groups where name='一般員工' and company_id=(select id from public.companies where name='公司 A')),
   'active'),
  ('李小華', '0912000002',
   (select id from public.companies where name='公司 A'),
   (select id from public.customer_groups where name='主管群' and company_id=(select id from public.companies where name='公司 A')),
   'active'),
  ('陳大同', '0912000003',
   (select id from public.companies where name='公司 B'),
   (select id from public.customer_groups where name='一般員工' and company_id=(select id from public.companies where name='公司 B')),
   'inactive');

-- 示範活動（現在起 7 天）
insert into public.campaigns (name, description, start_at, end_at, status)
values (
  '夏季感恩團購',
  '全公司限時回饋，價格每分鐘下降，先搶先贏！',
  now(), now() + interval '7 days',
  'active'
);

insert into public.products
  (campaign_id, name, description, image_url, sku,
   original_price, minimum_price, price_interval_seconds, price_decrease,
   initial_stock, stock, max_per_customer, status, sale_start_at)
values
  ((select id from public.campaigns where name='夏季感恩團購'),
   '精品咖啡禮盒', '嚴選莊園咖啡豆 2 入禮盒', null, 'SKU-COFFEE-01',
   1500, 1000, 60, 10, 20, 20, 2, 'active', now()),
  ((select id from public.campaigns where name='夏季感恩團購'),
   '有機堅果拼盤', '每日營養堅果 30 包組', null, 'SKU-NUTS-01',
   980, 600, 45, 8, 15, 15, 3, 'active', now()),
  ((select id from public.campaigns where name='夏季感恩團購'),
   '保溫瓶 500ml', '316 不鏽鋼保溫瓶', null, 'SKU-BOTTLE-01',
   690, 390, 30, 5, 8, 8, 1, 'active', now());

-- ============================================================
-- 8. 伺服器時間 RPC（前端時鐘校準用，避免相信本機時間）
-- ============================================================
create or replace function public.server_now()
returns timestamptz
language sql volatile
as $$
  select now();
$$;
grant execute on function public.server_now() to authenticated;

-- ============================================================
-- 8b. Server 權威價格查詢（get-current-price API 的後端）
--     回傳 jsonb: { price, next_drop_in_seconds, stock, server_time }
--     前端顯示可自行估算，但「下單前確認」一律以此為準
-- ============================================================
create or replace function public.get_current_price(p_product_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
begin
  select * into v_product from public.products where id = p_product_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'product_not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'price', public.compute_current_price(v_product),
    'next_drop_in_seconds',
      v_product.price_interval_seconds
      - (greatest(0, extract(epoch from (now() - coalesce(v_product.sale_start_at, now()))))::bigint
         % v_product.price_interval_seconds),
    'stock', v_product.stock,
    'max_per_customer', v_product.max_per_customer,
    'server_time', now()
  );
end;
$$;
grant execute on function public.get_current_price(uuid) to authenticated;

-- ============================================================
-- 9. 最後登入時間（登入成功時自動寫入 customers.last_login_at）
-- ============================================================
create or replace function public.handle_last_login()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.customers
    set last_login_at = now()
    where auth_user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_login on auth.users;
create trigger on_auth_user_login
  after update of last_sign_in_at on auth.users
  for each row
  when (old.last_sign_in_at is distinct from new.last_sign_in_at)
  execute function public.handle_last_login();

-- ============================================================
-- 10. 手機號碼正規化（25. 手機格式）
--     0912-345-678 / 0912345678 / +886912345678 → 0912345678
--     避免同一個人因格式不同產生兩個帳號
-- ============================================================
create or replace function public.normalize_phone(raw text)
returns text
language plpgsql immutable
as $$
declare
  v text := regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g');
begin
  -- +886 / 886 開頭：去掉國碼，補回前導 0
  if v like '886%' and length(v) = 12 then
    v := '0' || substr(v, 4);
  elsif v like '886%' and length(v) = 11 then
    v := '0' || substr(v, 4);
  end if;
  return v;
end;
$$;

-- 種子資料與 admin 建立客戶時，一律先正規化再寫入：
--   insert into customers (phone, ...) values (public.normalize_phone($1), ...);

-- ============================================================
-- 會員關注商品（2026-08-22 新增）
-- ============================================================
create table if not exists public.product_follows (
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, product_id)
);
create index if not exists idx_follows_product on public.product_follows(product_id);
alter table public.product_follows enable row level security;
create policy follows_select on public.product_follows
  for select to authenticated using (true);
create policy follows_insert on public.product_follows
  for insert to authenticated with check (user_id = auth.uid());
create policy follows_delete on public.product_follows
  for delete to authenticated using (user_id = auth.uid());
create or replace function public.product_follower_count(p_product_id uuid)
returns int language sql security definer set search_path = public stable
as $$ select count(*)::int from public.product_follows where product_id = p_product_id; $$;
create or replace function public.product_follower_counts()
returns table (product_id uuid, follower_count bigint)
language sql security definer set search_path = public stable
as $$ select product_id, count(*)::bigint from public.product_follows group by product_id; $$;
alter publication supabase_realtime add table public.product_follows;

-- ============================================================
-- 特價倒數平台規則擴充（2026-08-22）
-- ============================================================
alter table public.products add column if not exists unit text not null default '件';
alter table public.products add column if not exists items_per_unit int not null default 1;
alter table public.customers add column if not exists must_change_password boolean not null default false;
create table if not exists public.banners (
  id          uuid primary key default gen_random_uuid(),
  title       text,
  image_url   text not null,
  target_url  text,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.banners enable row level security;
drop policy if exists banners_read on public.banners;
create policy banners_read on public.banners
  for select to authenticated using (is_active or public.is_admin());
drop policy if exists banners_admin_write on public.banners;
create policy banners_admin_write on public.banners
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

-- storage 上傳權限（管理員可寫，所有人可讀）
drop policy if exists media_public_read on storage.objects;
create policy media_public_read on storage.objects
  for select using (bucket_id = 'media');
drop policy if exists media_admin_write on storage.objects;
create policy media_admin_write on storage.objects
  for insert with check (bucket_id = 'media' and public.is_admin());
drop policy if exists media_admin_update on storage.objects;
create policy media_admin_update on storage.objects
  for update using (bucket_id = 'media' and public.is_admin());
drop policy if exists media_admin_delete on storage.objects;
create policy media_admin_delete on storage.objects
  for delete using (bucket_id = 'media' and public.is_admin());
