-- 補回「開賣前不能買」的伺服器端防護（2026-09-15）
-- 由小布依線上 pg_get_functiondef('public.reserve_product(uuid,integer,text)') 的本體，
-- 只插入 not_open_yet 檢查後整份覆蓋線上函式（線上為準，非 repo 舊版）。
-- 背景：20260905_f_not_open_yet.sql 曾在 purchase_product 擋未開賣下單，
--       20260910_unify_purchase_path.sql 改成 reserve_product → checkout_reservation 後該防護消失，
--       造成呼叫 RPC 可繞過前端按鈕、在開賣前鎖走庫存。
-- 註：本檔為線上現況之完整快照，勿用更舊的 migration 覆蓋本函式。

CREATE OR REPLACE FUNCTION public.reserve_product(p_product_id uuid, p_quantity integer, p_idempotency_key text DEFAULT NULL::text)
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

  -- 尚未開賣（開賣時間在未來）→ 拒絕新預約
  -- 20260905_f 原本在 purchase_product 有這個防護，20260910 改購買入口（reserve→checkout）後掉了，這裡補回。
  -- 放在 already_reserved / 冪等重送之後：已鎖定的預約仍可重送取回，只有「新預約」被擋。
  if v_product.sale_start_at is not null and v_product.sale_start_at > v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_open_yet');
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
$function$

