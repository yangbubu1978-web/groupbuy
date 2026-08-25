-- ============================================================
-- 遷移 20260905_g P0：價格永不倒退＋超時自動下架
-- （單程到底，雅布大人 2026-08-25 拍板）
-- 規則：
--   1. 降價「只降一輪」：到底後維持最低價，價格永不回彈
--   2. 到底後「停留 1 個降價週期」仍未售罄 → 自動下架（status=ended）
--   3. 成交價 Server 權威（仍走 compute_current_price），與前端同公式
-- 冪等：create or replace / if not exists
-- ============================================================

-- 1) 降價引擎：單程到底
create or replace function public.compute_current_price(p public.products)
returns numeric
language plpgsql stable
as $$
declare
  v_start     timestamptz := p.sale_start_at;
  v_elapsed   double precision;
  v_interval  int := greatest(1, p.price_interval_seconds);
  v_min       numeric(12,2) := least(p.minimum_price, p.original_price);
  v_range     numeric(12,2);
  v_lo        int;
  v_hi        int;
  v_s         int;
  v_k         int;
  v_round     int := 0;
  v_m         int;
  v_acc       numeric(12,2);
  v_i         int;
begin
  if v_start is null then
    return p.original_price;
  end if;

  v_lo := greatest(0, round(p.price_decrease)::int);
  v_hi := case
            when p.price_decrease_max is not null then greatest(v_lo, round(p.price_decrease_max)::int)
            else v_lo
          end;
  v_range := p.original_price - v_min;

  if v_hi <= 0 or v_range <= 0 then
    return p.original_price;
  end if;

  v_elapsed := greatest(0, extract(epoch from (now() - v_start)));
  v_k := floor(v_elapsed / v_interval)::int;
  if v_k < 1 then
    return p.original_price;
  end if;

  -- 單程：只降第一輪；到底後維持最低價（價格永不回彈）
  v_s := ceil(v_range / greatest(1, case when v_lo > 0 then v_lo else v_hi end))::int;
  v_m := least(v_k, v_s);

  v_acc := 0;
  v_i   := 0;
  while v_i < v_m and v_acc < v_range loop
    v_acc := v_acc + public.rand_step(
      p.id::text || '|' || v_round::text || '|' || v_i::text,
      v_lo,
      v_hi
    );
    v_i := v_i + 1;
  end loop;

  return round(greatest(v_min, p.original_price - v_acc), 2);
end;
$$;

-- 2) 「已到底且停留 ≥1 個週期」→ 應自動下架
create or replace function public.product_is_settled(p public.products)
returns boolean
language plpgsql stable
as $$
declare
  v_start     timestamptz := p.sale_start_at;
  v_interval  int := greatest(1, p.price_interval_seconds);
  v_min       numeric(12,2) := least(p.minimum_price, p.original_price);
  v_range     numeric(12,2);
  v_lo        int;
  v_hi        int;
  v_s         int;
  v_k         int;
begin
  if v_start is null then
    return false;
  end if;
  v_lo := greatest(0, round(p.price_decrease)::int);
  v_hi := case
            when p.price_decrease_max is not null then greatest(v_lo, round(p.price_decrease_max)::int)
            else v_lo
          end;
  v_range := p.original_price - v_min;
  if v_hi <= 0 or v_range <= 0 then
    return false;
  end if;
  v_s := ceil(v_range / greatest(1, case when v_lo > 0 then v_lo else v_hi end))::int;
  v_k := floor(greatest(0, extract(epoch from (now() - v_start))) / v_interval)::int;
  return v_k >= v_s + 1; -- 已到底並多停留一個週期
end;
$$;

grant execute on function public.product_is_settled(public.products) to anon, authenticated;

-- 3) purchase_product：成交前檢查「已達底價且停留一個週期」→ 自動下架收檔
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

  -- (8.5) P0：已到底且停留一個週期未售罄 → 自動下架收檔，拒絕購買
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