-- P32 修復 reserve_product 重按漏庫存：同商品已有 active 預約時刷新期限，不重扣庫存
CREATE OR REPLACE FUNCTION public.reserve_product(p_product_id uuid, p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id    uuid := auth.uid();
  v_product    public.products%rowtype;
  v_campaign   public.campaigns%rowtype;
  v_now        timestamptz := now();
  v_price      numeric(12,2);
  v_updated    int;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_quantity < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- 同商品同時只能有一筆有效預訂（重複按＝刷新期限，不重扣庫存）
  -- P32 修復：舊邏輯 delete 不還庫存，每重按一次漏 1 件
  declare v_existing public.cart_reservations%rowtype; begin
  select * into v_existing from public.cart_reservations
   where user_id = v_user_id and product_id = p_product_id and status = 'active' for update;
  if found then
    v_price := public.compute_current_price(v_product);
    update public.cart_reservations
       set reserved_at = v_now, expires_at = v_now + interval '1 minute', locked_unit_price = v_price
     where id = v_existing.id;
    return jsonb_build_object(
      'ok', true,
      'reservation_id', v_existing.id,
      'locked_unit_price', v_price,
      'quantity', v_existing.quantity,
      'expires_at', v_now + interval '1 minute'
    );
  end if;
  end;

  select * into v_product from public.products
    where id = p_product_id for update;
  if not found or v_product.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'product_paused');
  end if;

  select * into v_campaign from public.campaigns
    where id = v_product.campaign_id for share;
  if not found or v_campaign.status <> 'active'
     or v_now < v_campaign.start_at or v_now > v_campaign.end_at then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_active');
  end if;

  -- A：幽靈商品阻絕——已到底+滿一輪 → 立即下架收檔，拒絕預訂
  if public.product_is_settled(v_product) then
    update public.products set status = 'ended'
      where id = v_product.id and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  -- 每人限購檢查（含預訂中的數量）
  select coalesce(sum(quantity),0) into v_updated from (
    select quantity from public.orders
     where user_id = v_user_id and product_id = p_product_id
       and status <> 'cancelled'
    union all
    select quantity from public.cart_reservations
     where user_id = v_user_id and product_id = p_product_id
       and status = 'active'
  ) t;
  if v_updated + p_quantity > v_product.max_per_customer then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached',
      'limit', v_product.max_per_customer, 'purchased', v_updated);
  end if;

  -- 原子扣庫存
  update public.products set stock = stock - p_quantity
   where id = p_product_id and stock >= p_quantity;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'reason', 'sold_out');
  end if;

  -- 鎖定當下價格，3 分鐘效期
  v_price := public.compute_current_price(v_product);
  insert into public.cart_reservations
    (user_id, product_id, quantity, locked_unit_price, reserved_at, expires_at, status)
  values
    (v_user_id, p_product_id, p_quantity, v_price, v_now, v_now + interval '1 minute', 'active');

  return jsonb_build_object(
    'ok', true,
    'reservation_id', (select id from public.cart_reservations
                        where user_id = v_user_id and product_id = p_product_id
                          and status = 'active' limit 1),
    'locked_unit_price', v_price,
    'quantity', p_quantity,
    'expires_at', v_now + interval '1 minute'
  );
exception
  when others then
    raise warning 'reserve_product failed: %', sqlerrm;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
end;
$function$

