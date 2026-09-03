-- Phase 1 / Reservation 過期與棄單統一
-- 主動取消與背景過期都呼叫同一個核心函式；核心只處理 active 狀態，
-- 因此重複呼叫不會重複回補庫存或重複套用 penalty。

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
  v_updated      int;
  v_interval     int;
  v_next_drop    int;
  v_penalty      int := 0;
  v_final_status text;
begin
  -- Cron 透過 SECURITY DEFINER 執行時沒有 auth.uid()；只有 user 呼叫才要求擁有者。
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

  -- 冪等：已處理的 Reservation 只回傳現況，不再次動庫存或 sale_start_at。
  if v_res.status <> 'active' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'reservation_inactive',
      'status', v_res.status,
      'restocked', coalesce(v_res.restocked, false)
    );
  end if;

  select * into v_product
    from public.products
   where id = v_res.product_id
   for update;
  if not found then
    update public.cart_reservations
       set status = 'released', released_at = now(), restocked = true
     where id = p_reservation_id;
    return jsonb_build_object('ok', true, 'restocked', false, 'penalty_secs', 0);
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

  -- 先改 Reservation 狀態，再回補與套 penalty；同一交易且已持有兩筆 row lock。
  v_final_status := case when v_res.expires_at <= now() then 'expired' else 'released' end;
  update public.cart_reservations
     set status = v_final_status,
         released_at = now(),
         restocked = true
   where id = p_reservation_id
     and status = 'active';

  update public.products
     set stock = stock + v_res.quantity
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

-- 背景清理專用：逐筆呼叫同一核心，避免原本 cron 另寫一套 penalty。
CREATE OR REPLACE FUNCTION public.expire_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select id
      from public.cart_reservations
     where status = 'active'
       and expires_at <= now()
     order by expires_at, id
     for update skip locked
  loop
    if coalesce((public.release_reservation(v_id)->>'ok')::boolean, false) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

REVOKE ALL ON FUNCTION public.release_reservation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_reservation(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.release_reservation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_reservation(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.expire_reservations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_reservations() FROM anon;
REVOKE ALL ON FUNCTION public.expire_reservations() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_reservations() TO service_role;

DO $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'expire-cart-reservations';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;

SELECT cron.schedule(
  'expire-cart-reservations',
  '* * * * *',
  $$select public.expire_reservations();$$
);

-- 移除舊的 auto-delist job，避免它再次自行回補／修改 penalty。
-- 重建時只保留商品下架判斷，Reservation 一律由 expire_reservations() 處理。
DO $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'auto-delist-settled-products';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;

SELECT cron.schedule(
  'auto-delist-settled-products',
  '* * * * *',
  $$
  update public.products set status = 'ended'
   where status = 'active' and public.product_is_settled(products);
  update public.products set status = 'ended'
   where status in ('active','paused')
     and forced_delist_at is not null
     and forced_delist_at <= now();
  $$
);
