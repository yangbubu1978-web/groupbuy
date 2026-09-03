-- 20260915 預約冪等鍵：整流程重送不再生第二筆訂單（健檢 PHASE 9 HIGH）
-- 背景：reserve + checkout 是兩次 RPC，整單重試會建第二個預約再生第二筆訂單。
-- 修法：reserve_product 吃 p_idempotency_key（前端每次購買意圖產生一個 UUID）。
--   同人同 key 只有一筆 active（部分唯一索引），重送回傳原預約；結帳本就認預約冪等。
--   key 綁商品加數量，拿舊 key 買別的東西會被擋 idempotency_key_mismatch。
--   key 為空走舊路（Edge 相容），不影響現有流程。
-- 線上本體基準：20260914（含冷卻與退款額度修正）

ALTER TABLE public.cart_reservations
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_res_active_idem
  ON public.cart_reservations(user_id, idempotency_key)
  WHERE status = 'active' AND idempotency_key IS NOT NULL;

-- ============ B) reserve_product：冷卻追加近 10 分鐘管理員取消/退款 ============
CREATE OR REPLACE FUNCTION public.reserve_product(p_product_id uuid, p_quantity integer, p_idempotency_key text DEFAULT NULL)
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
  v_keyed         public.cart_reservations%rowtype;
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

  -- 冪等鍵：同一購買意圖重送回傳原預約，不重扣庫存。
  if p_idempotency_key is not null then
    select * into v_keyed
      from public.cart_reservations
     where user_id = v_user_id
       and idempotency_key = p_idempotency_key
       and status = 'active'
     order by reserved_at, id
     limit 1
     for update;
    if found then
      if v_keyed.product_id <> p_product_id or v_keyed.quantity <> p_quantity then
        return jsonb_build_object('ok', false, 'reason', 'idempotency_key_mismatch');
      end if;
      return jsonb_build_object(
        'ok', true,
        'replayed', true,
        'reservation_id', v_keyed.id,
        'locked_unit_price', v_keyed.locked_unit_price,
        'quantity', v_keyed.quantity,
        'expires_at', v_keyed.expires_at
      );
    end if;
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
         and status not in ('cancelled','refunded')
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
    (user_id, product_id, quantity, locked_unit_price, reserved_at, expires_at, status, idempotency_key)
  values
    (v_user_id, p_product_id, p_quantity, v_price, v_now, v_now + interval '1 minute', 'active', p_idempotency_key)
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
    if p_idempotency_key is not null then
      select * into v_keyed
        from public.cart_reservations
       where user_id = v_user_id
         and idempotency_key = p_idempotency_key
         and status = 'active'
       order by reserved_at, id
       limit 1;
      if found then
        return jsonb_build_object(
          'ok', true,
          'replayed', true,
          'reservation_id', v_keyed.id,
          'locked_unit_price', v_keyed.locked_unit_price,
          'quantity', v_keyed.quantity,
          'expires_at', v_keyed.expires_at
        );
      end if;
    end if;
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
