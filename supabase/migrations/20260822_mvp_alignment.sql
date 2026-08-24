-- ============================================================
-- M1 Migration：MVP 規格對齊（2026-08-22）
-- 1) companies.status
-- 2) customers.role（admin/customer，從 admins 表回填）
-- 3) order_items 表（訂單明細快照）＋RLS
-- 4) purchase_product() 升級：同時寫入 orders + order_items
-- 可重複執行（冪等）
-- ============================================================

-- 1) companies.status
alter table public.companies
  add column if not exists status text not null default 'active';

-- 2) customers.role
alter table public.customers
  add column if not exists role text not null default 'customer';

update public.customers c
  set role = 'admin'
  where exists (
    select 1 from public.admins a where a.user_id = c.auth_user_id
  );

-- 3) order_items
create table if not exists public.order_items (
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
create index if not exists idx_order_items_order on public.order_items(order_id);

alter table public.order_items enable row level security;

drop policy if exists order_items_read on public.order_items;
create policy order_items_read on public.order_items
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_items.order_id
        and (o.user_id = auth.uid() or public.is_admin())
    )
  );

-- 4) purchase_product() 升級版
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

  -- (9) 條件式原子扣庫存（防超賣關鍵）
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

  -- (10b) 建立訂單明細（order_items 快照；規格十二）
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
