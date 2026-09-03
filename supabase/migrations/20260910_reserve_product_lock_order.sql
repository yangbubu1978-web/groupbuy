-- Phase 1 / Reservation 行為修復
-- 先鎖定商品資料列，再檢查同一使用者／商品的 active Reservation。
-- 這讓同一商品的並發 reserve request 串行化，並與 partial unique index 雙重保護。

CREATE OR REPLACE FUNCTION public.reserve_product(p_product_id uuid, p_quantity integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_retry         int;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_quantity < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- 關鍵順序：先鎖商品，再查 active reservation。
  -- 同一 product 的並發請求會在此排隊，避免兩個請求同時通過既有檢查。
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
    -- 重試／重按不可重扣庫存；回傳真正鎖定的價格與數量。
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
  if v_product.initial_stock = 1 then
    select max(coalesce(released_at, reserved_at + interval '1 minute'))
      into v_last_abandon
      from public.cart_reservations
     where user_id = v_user_id
       and product_id = p_product_id
       and status in ('released','expired')
       and coalesce(released_at, reserved_at + interval '1 minute') > v_now - interval '10 minutes';

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

  -- 每人限購：已購買量 + active reservation 數量。
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
    -- 與既有 partial unique index 的最後一道防線相容；安全回傳既有 Reservation。
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
$$;

REVOKE ALL ON FUNCTION public.reserve_product(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_product(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.reserve_product(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_product(uuid, integer) TO service_role;
