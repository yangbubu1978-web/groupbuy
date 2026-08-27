-- P33 棄單罰則：stock=1 商品，棄單後延長降價週期（最後1分鐘內佔→100%，否則50%），每商品獨立間隔；同時 reserve 改為不可刷新
CREATE OR REPLACE FUNCTION public.release_reservation(p_reservation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_res     public.cart_reservations%rowtype;
  v_product public.products%rowtype;
  v_updated int;
  v_next_drop int;
  v_interval int;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  select * into v_res from public.cart_reservations where id = p_reservation_id for update;
  if not found or v_res.user_id <> v_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  end if;
  if v_res.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'reservation_inactive');
  end if;

  select * into v_product from public.products where id = v_res.product_id for update;
  -- 判斷加入時的 nextDropIn：用 reserved_at 倒推
  -- nextDropIn = interval - ((reserved_at - sale_start_at) % interval)
  if v_product.sale_start_at is not null then
    v_interval := greatest(1, v_product.price_interval_seconds);
    v_next_drop := v_interval - ((extract(epoch from (v_res.reserved_at - v_product.sale_start_at))::int % v_interval));
    if v_next_drop <= 0 then v_next_drop := v_interval; end if;
  else
    v_next_drop := 9999;
  end if;

  update public.cart_reservations set status = 'released' where id = p_reservation_id;
  update public.products set stock = stock + v_res.quantity where id = v_res.product_id;
  get diagnostics v_updated = row_count;

  -- P33 罰則：僅 stock=1 商品，棄單後延長降價週期
  if v_product.stock is not null and v_product.initial_stock = 1 and v_product.stock <= 1 then
    if v_next_drop <= 60 then
      -- A：最後1分鐘才佔 → 罰100%（完整一輪）
      update public.products set sale_start_at = sale_start_at + make_interval(secs => v_interval)
       where id = v_res.product_id;
    else
      -- B：正常時間佔 → 罰50%（半輪）
      update public.products set sale_start_at = sale_start_at + make_interval(secs => v_interval / 2)
       where id = v_res.product_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'restocked', v_updated > 0,
    'penalty', case when v_next_drop <= 60 then '100%' else '50%' end);
end;
$function$


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
    return jsonb_build_object(
      'ok', false,
      'reason', 'already_reserved',
      'reservation_id', v_existing.id,
      'expires_at', v_existing.expires_at
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


-- cron command:
-- 
  -- 1. 逾期標記
  update public.cart_reservations set status = 'expired', released_at = now()
   where status = 'active' and expires_at < now();

  -- 2. 罰則：僅 stock=1 商品，依加入時的 nextDropIn 罰 100%/50%（需在回補前算）
  --    用 reserved_at 推算 nextDropIn
  update public.products p set sale_start_at = sale_start_at + make_interval(secs =>
    case when (
      greatest(1, p.price_interval_seconds) - ((extract(epoch from (r.reserved_at - p.sale_start_at))::int % greatest(1, p.price_interval_seconds)))
    ) <= 60 then greatest(1, p.price_interval_seconds)
    else greatest(1, p.price_interval_seconds) / 2 end
  )
  from public.cart_reservations r
  where r.product_id = p.id and r.status = 'expired' and r.restocked = false
    and p.initial_stock = 1 and p.stock <= 1 and p.sale_start_at is not null;

  -- 3. 回補庫存
  update public.products p set stock = stock + r.quantity
   from public.cart_reservations r
   where r.product_id = p.id and r.status = 'expired' and r.restocked = false;
  update public.cart_reservations set restocked = true where status = 'expired' and restocked = false;

  -- 4. settled / forced 下架
  update public.products set status = 'ended' where status = 'active' and public.product_is_settled(products);
  update public.products set status = 'ended' where status in ('active','paused') and forced_delist_at is not null and forced_delist_at <= now();
  
