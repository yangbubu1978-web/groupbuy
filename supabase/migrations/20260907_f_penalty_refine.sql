-- P33b 棄單罰則精修：按 nextDropIn 比例罰；正常 clamp(50%,30s,5min)，最後1分 = nextDropIn(cap60s)；僅 stock=1
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
  v_interval int;
  v_next_drop int;
  v_penalty int;
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

  -- P33b 罰則：僅 stock=1 商品，棄單後延長
  -- 正常：clamp(nextDropIn*50%, 30s, 5min)；最後1分：nextDropIn (cap 60s)
  if v_product.initial_stock = 1 and v_product.stock <= 1 then
    if v_next_drop <= 60 then
      v_penalty := least(v_next_drop, 60);
    else
      v_penalty := least(greatest((v_next_drop * 0.5)::int, 30), 300);
    end if;
    update public.products set sale_start_at = sale_start_at + make_interval(secs => v_penalty)
     where id = v_res.product_id;
  else
    v_penalty := 0;
  end if;

  return jsonb_build_object('ok', true, 'restocked', v_updated > 0, 'penalty_secs', v_penalty, 'next_drop', v_next_drop);
end;
$function$


-- cron:

  update public.cart_reservations set status = 'expired', released_at = now()
   where status = 'active' and expires_at < now();

  -- P33b 罰則：依 nextDropIn 比例罰（僅 initial_stock=1）
  -- 先為每個逾期預約計算 penalty，再套到對應商品
  with penalties as (
    select r.id as rid, r.product_id,
      greatest(1, p.price_interval_seconds) as iv,
      greatest(1, p.price_interval_seconds) - ((extract(epoch from (r.reserved_at - p.sale_start_at))::int % greatest(1, p.price_interval_seconds))) as raw_next,
      p.sale_start_at
    from public.cart_reservations r join public.products p on p.id = r.product_id
    where r.status = 'expired' and r.restocked = false and p.initial_stock = 1 and p.stock <= 1 and p.sale_start_at is not null
  ), computed as (
    select rid, product_id,
      case when raw_next <= 0 then iv when raw_next <= 60 then least(raw_next, 60)
      else least(greatest((raw_next * 0.5)::int, 30), 300) end as penalty
    from penalties
  )
  update public.products p set sale_start_at = p.sale_start_at + make_interval(secs => c.penalty)
  from computed c where c.product_id = p.id;

  update public.products p set stock = stock + r.quantity
   from public.cart_reservations r
   where r.product_id = p.id and r.status = 'expired' and r.restocked = false;
  update public.cart_reservations set restocked = true where status = 'expired' and restocked = false;

  update public.products set status = 'ended' where status = 'active' and public.product_is_settled(products);
  update public.products set status = 'ended' where status in ('active','paused') and forced_delist_at is not null and forced_delist_at <= now();
  
