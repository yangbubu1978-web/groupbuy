-- 20260919 補狀態機斷裂：DB 開通 paid→completed 與 refunding→paid，對齊前台與 P30 簡化流程
-- 背景：前台 orderStatus.ts（P30 雅布拍板：確認→付款→完成，不再經出貨）
--   提供 paid→completed、refunding→paid 兩個按鈕，
--   但 DB admin_transition_order 的狀態機沒有這兩條，按下去必回 invalid_transition。
-- 修法：只加兩條邊，其餘狀態機、罰則、回補封頂全部保留（只寬不緊，不影響舊單收尾）。
--   paid: completed（新增）＋ shipped / refunding（保留，舊單出路）
--   refunding: refunded ＋ paid（新增，退款被拒復活）＋ shipped（保留，舊單出路）

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
    or (v_order.status='paid' and p_next in ('completed','shipped','refunding'))
    or (v_order.status='shipped' and p_next in ('completed','refunding'))
    or (v_order.status='completed' and p_next in ('refunding'))
    or (v_order.status='refunding' and p_next in ('refunded','paid','shipped'))
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

  -- 單件商品被管理員取消/退款時，比照棄單罰則延後降價（防買下再取消繞罰）。
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
