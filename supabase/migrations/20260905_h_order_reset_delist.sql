-- ============================================================
-- 遷移 20260905_h P0：有人下單歸零計時 ＋ 到底價等一輪沒人下單才下架
-- （雅布大人 2026-08-25 拍板）
-- 規則：
--   1. 價格仍錠定 sale_start_at（只降不漲、單程到底）—— compute_current_price 不變
--   2. 新增 products.last_order_at：每次成功下單寫入 now()
--   3. product_is_settled 改為「已到底價」**且**「距最後一次下單已滿整整一個降價週期」
--      → 有人下單就把「等候下架」的倒數歸零重置，直到整整一輪都沒人下單才自動下架
-- 冪等：create or replace / if not exists
-- ============================================================

-- 1) 新增欄位：最後一次成功下單時間（NULL＝尚有下單）
alter table public.products
  add column if not exists last_order_at timestamptz;

-- 2) purchase_product 成功時寫入 last_order_at
--    （在既有 20260905_g 版本上覆寫，加入歸零計時）
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
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select * into v_customer from public.customers
    where auth_user_id = v_user_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_whitelisted');
  end if;
  if v_customer.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'account_' || v_customer.status::text);
  end if;

  select * into v_product from public.products
    where id = p_product_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'product_not_found');
  end if;
  if v_product.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'product_paused');
  end if;

  select * into v_campaign from public.campaigns
    where id = v_product.campaign_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_found');
  end if;
  if v_campaign.status <> 'active' or v_now < v_campaign.start_at or v_now > v_campaign.end_at then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_active');
  end if;

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

  v_unit_price := public.compute_current_price(v_product);

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

  if p_quantity < 1 or p_quantity > v_product.max_per_customer then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- 已到底價且整整一輪（自上次下單起）無人下單 → 自動下架收檔
  if public.product_is_settled(v_product) then
    update public.products set status = 'ended'
      where id = v_product.id and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  update public.products
    set stock = stock - p_quantity
    where id = p_product_id
      and stock >= p_quantity;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'reason', 'sold_out');
  end if;

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

  insert into public.order_items (
    order_id, product_id, product_name_snapshot, sku_snapshot,
    unit_price, quantity, subtotal
  ) values (
    v_order_id, p_product_id, v_product.name, v_product.sku,
    v_unit_price, p_quantity, v_unit_price * p_quantity
  );

  -- ★ 歸零計時：成功下單 → 寫下最後下單時間（重置下架倒數）
  update public.products
    set last_order_at = v_now
    where id = p_product_id;

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

-- 3) product_is_settled：已到底價 ＋ 距最後下單滿一輪（無下單）才 true
create or replace function public.product_is_settled(p public.products)
returns boolean
language plpgsql stable
as $$
declare
  v_start     timestamptz := p.sale_start_at;
  v_interval  int := greatest(1, p.price_interval_seconds);
  v_min       numeric(12,2) := least(p.minimum_price, p.original_price);
  v_range     numeric(12,2) := p.original_price - v_min;
  v_lo        int;
  v_hi        int;
  v_s         int;                 -- 一輪到底的最大步數
  v_elapsed   double precision;
  v_k         int;                 -- 已完成降價次數
  v_anchor    timestamptz;         -- 歸零錨定（最後下單 或 開賣）
  v_floor_at  timestamptz;         -- 抵達底價的時刻
begin
  if v_start is null then
    return false;
  end if;
  v_lo := greatest(0, round(p.price_decrease)::int);
  v_hi := case
            when p.price_decrease_max is not null then greatest(v_lo, round(p.price_decrease_max)::int)
            else v_lo
          end;
  if v_hi <= 0 or v_range <= 0 then
    return false;
  end if;

  v_s := ceil(v_range / greatest(1, case when v_lo > 0 then v_lo else v_hi end))::int;
  v_elapsed := greatest(0, extract(epoch from (now() - v_start)));
  v_k := floor(v_elapsed / v_interval)::int;

  -- 尚未到底價 → 不會下架
  if v_k < v_s then
    return false;
  end if;

  -- 到底價時刻 = 開賣 + s*interval
  v_floor_at := v_start + make_interval(secs => v_s * v_interval);
  -- 歸零錨定 = max(最後下單, 開賣)；（先到 floor 才開始計時）
  v_anchor := greatest(v_floor_at, coalesce(p.last_order_at, v_start));

  -- 已到底價，且自「最後下單／抵達底價」起已滿整整一輪且無人下單 → 下架
  return extract(epoch from (now() - v_anchor)) >= v_interval;
end;
$$;

grant execute on function public.product_is_settled(public.products) to anon, authenticated;
