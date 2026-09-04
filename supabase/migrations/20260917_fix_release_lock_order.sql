-- 20260917 修釋放鎖順序：與 reserve_product 統一為 商品先再預約，收斂死結風險
-- 背景：reserve 先鎖 products 再鎖 cart_reservations，
-- release 舊版先鎖 reservations 再鎖 products，
-- 同一件商品一邊有人下單一邊有人棄單過期，兩邊互等會卡死。
-- 修法：先用不加鎖讀出 product_id，接著先鎖商品，再鎖預約。
-- 其餘語義不動：擁有者檢查、active 冪等、LEAST 回補封頂、單件罰則都保留。

CREATE OR REPLACE FUNCTION public.release_reservation(p_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_user_id      uuid := auth.uid();
  v_res          public.cart_reservations%rowtype;
  v_product      public.products%rowtype;
  v_pid          uuid;
  v_updated      int;
  v_interval     int;
  v_next_drop    int;
  v_penalty      int := 0;
  v_final_status text;
begin
  -- 先不加鎖找出商品編號，找不到直接回報。
  select product_id into v_pid
    from public.cart_reservations
   where id = p_reservation_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- 統一順序第一步：先鎖商品（與 reserve_product 相同）。
  select * into v_product
    from public.products
   where id = v_pid
   for update;
  if not found then
    -- 商品已刪除：鎖預約後標記釋放，與舊版行為一致。
    select * into v_res
      from public.cart_reservations
     where id = p_reservation_id
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    if v_user_id is not null and v_res.user_id <> v_user_id then
      return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
    end if;
    update public.cart_reservations
       set status = 'released', released_at = now(), restocked = true
     where id = p_reservation_id;
    return jsonb_build_object('ok', true, 'restocked', false, 'penalty_secs', 0);
  end if;

  -- 統一順序第二步：再鎖預約。
  select * into v_res
    from public.cart_reservations
   where id = p_reservation_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_user_id is not null and v_res.user_id <> v_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  end if;
  if v_user_id is null and current_user <> 'postgres' and current_user <> 'service_role' then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  if v_res.status <> 'active' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'reservation_inactive',
      'status', v_res.status,
      'restocked', coalesce(v_res.restocked, false)
    );
  end if;

  v_interval := greatest(1, v_product.price_interval_seconds);
  if v_product.sale_start_at is null then
    v_next_drop := 9999;
  else
    v_next_drop := v_interval - (
      extract(epoch from (v_res.reserved_at - v_product.sale_start_at))::bigint % v_interval
    )::int;
    if v_next_drop <= 0 or v_next_drop > v_interval then
      v_next_drop := v_interval;
    end if;
  end if;

  v_final_status := case when v_res.expires_at <= now() then 'expired' else 'released' end;
  update public.cart_reservations
     set status = v_final_status,
         released_at = now(),
         restocked = true
   where id = p_reservation_id
     and status = 'active';

  -- 回補加 LEAST 封頂，與 cancel/admin 退款一致，避免 stock 超過 initial_stock
  update public.products
     set stock = least(initial_stock, stock + v_res.quantity)
   where id = v_res.product_id;
  get diagnostics v_updated = row_count;

  if v_product.initial_stock = 1 and v_product.stock <= 1 then
    if v_next_drop <= 60 then
      v_penalty := least(v_next_drop, 60);
    else
      v_penalty := least(greatest((v_next_drop * 0.5)::int, 30), 300);
    end if;
    update public.products
       set sale_start_at = sale_start_at + make_interval(secs => v_penalty)
     where id = v_res.product_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'restocked', v_updated > 0,
    'penalty_secs', v_penalty,
    'next_drop', v_next_drop,
    'status', v_final_status
  );
exception
  when others then
    raise warning 'release_reservation failed: %', sqlerrm;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
end;
$$;

REVOKE ALL ON FUNCTION public.release_reservation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_reservation(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.release_reservation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_reservation(uuid) TO service_role;
