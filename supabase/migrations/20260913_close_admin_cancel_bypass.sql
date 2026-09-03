-- 20260913 補買下再取消繞懲罰的洞（健檢 PHASE 10 高風險項）
-- 背景：棄單走 release_reservation 會延後 sale_start_at + 3 分鐘冷卻，
--   但結帳後走 admin_transition_order 取消/退款只還庫存，不罰也不冷卻。
-- 修法（只加罰則與冷卻標記，不動原有狀態機與回補上限）：
--   A) admin 取消/退款單件商品時，比照棄單公式延後 sale_start_at
--   B) reserve_product 冷卻檢查追加「近 10 分鐘被管理員取消/退款的訂單」
-- 線上本體基準：2026-09-04 當前 pg_get_functiondef（LEAST 回補已有、無 sale_start_at 罰則）

-- ============ A) admin_transition_order：加單件罰則 ============
CREATE OR REPLACE FUNCTION public.admin_transition_order(p_order_id uuid, p_next text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders%rowtype;
  v_product public.products%rowtype;
  v_interval int;
  v_next_drop int;
  v_penalty int := 0;
  v_anchor timestamptz;
begin
  -- 一般呼叫仍須是 admins 成員；後台代理使用 service_role。
  if auth.role() <> 'service_role' and (auth.uid() is null or not public.is_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select * into v_order
    from public.orders
   where id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not (
    (v_order.status='pending' and p_next in ('confirmed','cancelled'))
    or (v_order.status='confirmed' and p_next in ('paid','cancelled'))
    or (v_order.status='paid' and p_next in ('shipped','refunding'))
    or (v_order.status='shipped' and p_next in ('completed','refunding'))
    or (v_order.status='completed' and p_next in ('refunding'))
    or (v_order.status='refunding' and p_next in ('refunded','shipped'))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition', 'from', v_order.status, 'to', p_next);
  end if;

  case
    when p_next='cancelled' then
      update public.orders set status='cancelled', cancelled_by='admin', cancel_reason=nullif(p_reason,''), updated_at=now() where id=p_order_id;
      if v_order.product_id is not null and v_order.status in ('pending','confirmed') then
        update public.products set stock=least(initial_stock, stock + v_order.quantity) where id=v_order.product_id;
        update public.products p set last_order_at=(select max(o.purchased_at) from public.orders o where o.product_id=p.id and o.status not in ('cancelled','refunded')) where p.id=v_order.product_id;
      end if;
    when p_next='refunded' then
      update public.orders set status='refunded', cancel_reason=coalesce(p_reason,cancel_reason), updated_at=now() where id=p_order_id;
      if v_order.product_id is not null then
        update public.products set stock=least(initial_stock, stock + v_order.quantity) where id=v_order.product_id;
        update public.products p set last_order_at=(select max(o.purchased_at) from public.orders o where o.product_id=p.id and o.status not in ('cancelled','refunded')) where p.id=v_order.product_id;
      end if;
    else
      update public.orders set status=p_next::public.order_status, cancel_reason=coalesce(p_reason,cancel_reason), updated_at=now() where id=p_order_id;
  end case;

  -- 新增：單件商品被管理員取消/退款時，比照棄單罰則延後降價（防買下再取消繞罰）。
  -- 僅 cancelled / refunded 才罰；其餘狀態流轉不影響價格曲線。
  if p_next in ('cancelled','refunded') and v_order.product_id is not null then
    select * into v_product from public.products where id = v_order.product_id for update;
    if found and v_product.initial_stock = 1 and v_product.stock <= 1 then
      v_interval := greatest(1, v_product.price_interval_seconds);
      v_anchor := coalesce(v_order.purchased_at, now());
      if v_product.sale_start_at is null then
        v_next_drop := 9999;
      else
        v_next_drop := v_interval - (
          extract(epoch from (v_anchor - v_product.sale_start_at))::bigint % v_interval
        )::int;
        if v_next_drop <= 0 or v_next_drop > v_interval then
          v_next_drop := v_interval;
        end if;
      end if;
      if v_next_drop <= 60 then
        v_penalty := least(v_next_drop, 60);
      else
        v_penalty := least(greatest((v_next_drop * 0.5)::int, 30), 300);
      end if;
      if v_penalty > 0 then
        update public.products
           set sale_start_at = sale_start_at + make_interval(secs => v_penalty)
         where id = v_order.product_id;
      end if;
    end if;
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;
-- 注意：CREATE OR REPLACE 保留原有授權，不動 GRANT，避免鎖住後台。

-- ============ B) reserve_product：冷卻追加近 10 分鐘管理員取消/退款 ============
CREATE OR REPLACE FUNCTION public.reserve_product(p_product_id uuid, p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id       uuid := auth.uid();
  v_product       public.products%rowtype;
  v_campaign      public.campaigns%rowtype;
  v_existing      public.cart_reservations%rowtype;
  v_reservation_id uuid;
  v_now           timestamptz := now();
  v_price         numeric(12,2);
  v_updated       int;
  v_last_abandon  timestamptz;
  v_last_cancel   timestamptz;
  v_retry         int;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_quantity < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- 關鍵順序：先鎖商品，再查 active reservation。
  select * into v_product
    from public.products
   where id = p_product_id
   for update;
  if not found or v_product.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'product_paused');
  end if;

  select * into v_existing
    from public.cart_reservations
   where user_id = v_user_id
     and product_id = p_product_id
     and status = 'active'
   order by reserved_at, id
   limit 1
   for update;
  if found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'already_reserved',
      'reservation_id', v_existing.id,
      'locked_unit_price', v_existing.locked_unit_price,
      'quantity', v_existing.quantity,
      'expires_at', v_existing.expires_at
    );
  end if;

  -- 單件商品冷卻：近 10 分鐘棄單後，冷卻 3 分鐘。
  -- 新增：近 10 分鐘被管理員取消/退款的訂單也視同棄單（防買下再取消秒回搶）。
  if v_product.initial_stock = 1 then
    select max(coalesce(released_at, reserved_at + interval '1 minute'))
      into v_last_abandon
      from public.cart_reservations
     where user_id = v_user_id
       and product_id = p_product_id
       and status in ('released','expired')
       and coalesce(released_at, reserved_at + interval '1 minute') > v_now - interval '10 minutes';

    select max(updated_at)
      into v_last_cancel
      from public.orders
     where user_id = v_user_id
       and product_id = p_product_id
       and status in ('cancelled','refunded')
       and updated_at > v_now - interval '10 minutes';

    if v_last_cancel is not null
       and (v_last_abandon is null or v_last_cancel > v_last_abandon) then
      v_last_abandon := v_last_cancel;
    end if;

    if v_last_abandon is not null
       and v_now < v_last_abandon + interval '3 minutes' then
      v_retry := greatest(1, extract(epoch from (v_last_abandon + interval '3 minutes' - v_now))::int);
      return jsonb_build_object(
        'ok', false,
        'reason', 'cooldown',
        'retry_after', v_retry,
        'retry_at', v_last_abandon + interval '3 minutes'
      );
    end if;
  end if;

  select * into v_campaign
    from public.campaigns
   where id = v_product.campaign_id
   for share;
  if not found or v_campaign.status <> 'active'
     or v_now < v_campaign.start_at
     or v_now > v_campaign.end_at then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_active');
  end if;

  if public.product_is_settled(v_product) then
    update public.products
       set status = 'ended'
     where id = v_product.id
       and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  select coalesce(sum(quantity), 0)
    into v_updated
    from (
      select quantity
        from public.orders
       where user_id = v_user_id
         and product_id = p_product_id
         and status <> 'cancelled'
      union all
      select quantity
        from public.cart_reservations
       where user_id = v_user_id
         and product_id = p_product_id
         and status = 'active'
    ) t;
  if v_updated + p_quantity > v_product.max_per_customer then
    return jsonb_build_object(
      'ok', false,
      'reason', 'limit_reached',
      'limit', v_product.max_per_customer,
      'purchased', v_updated
    );
  end if;

  update public.products
     set stock = stock - p_quantity
   where id = p_product_id
     and stock >= p_quantity;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'reason', 'sold_out');
  end if;

  v_price := public.compute_current_price(v_product);
  insert into public.cart_reservations
    (user_id, product_id, quantity, locked_unit_price, reserved_at, expires_at, status)
  values
    (v_user_id, p_product_id, p_quantity, v_price, v_now, v_now + interval '1 minute', 'active')
  returning id into v_reservation_id;

  return jsonb_build_object(
    'ok', true,
    'reservation_id', v_reservation_id,
    'locked_unit_price', v_price,
    'quantity', p_quantity,
    'expires_at', v_now + interval '1 minute'
  );
exception
  when unique_violation then
    select * into v_existing
      from public.cart_reservations
     where user_id = v_user_id
       and product_id = p_product_id
       and status = 'active'
     order by reserved_at, id
     limit 1;
    if found then
      return jsonb_build_object(
        'ok', false,
        'reason', 'already_reserved',
        'reservation_id', v_existing.id,
        'locked_unit_price', v_existing.locked_unit_price,
        'quantity', v_existing.quantity,
        'expires_at', v_existing.expires_at
      );
    end if;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
  when others then
    raise warning 'reserve_product failed: %', sqlerrm;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
end;
$function$;
-- 注意：CREATE OR REPLACE 保留原有授權，不動 GRANT。
