-- 修復取消/退款回補導致 stock > initial_stock（圖中 2/1、4/2）
-- 根因：0000_init_schema 註解「chk_stock_range 已移除」後，所有回補都是 stock + quantity 無上限
-- 修法：全部改為 LEAST(initial_stock, stock + quantity)

-- 1) 會員自行取消
create or replace function public.cancel_own_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_user_id is null then return jsonb_build_object('ok', false, 'reason', 'unauthenticated'); end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id <> v_user_id then return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner'); end if;
  if v_order.status not in ('pending', 'confirmed') then return jsonb_build_object('ok', false, 'reason', 'invalid_status'); end if;
  update public.orders set status='cancelled', cancelled_by='member', cancel_reason=coalesce(cancel_reason,'member_cancelled'), updated_at=now() where id=p_order_id;
  if v_order.product_id is not null then
    update public.products set stock = least(initial_stock, stock + v_order.quantity) where id=v_order.product_id;
    update public.products p set last_order_at=(select max(o.purchased_at) from public.orders o where o.product_id=p.id and o.status not in ('cancelled','refunded')) where p.id=v_order.product_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 2) 後台取消/退款（admin_transition_order）v4：回補加 LEAST 上限
create or replace function public.admin_transition_order(p_order_id uuid, p_next text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_order public.orders%rowtype; begin
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason','not_found'); end if;
  if not ((v_order.status='pending' and p_next in ('confirmed','cancelled')) or (v_order.status='confirmed' and p_next in ('paid','cancelled')) or (v_order.status='paid' and p_next in ('shipped','refunding')) or (v_order.status='shipped' and p_next in ('completed','refunding')) or (v_order.status='completed' and p_next in ('refunding')) or (v_order.status='refunding' and p_next in ('refunded','shipped'))) then return jsonb_build_object('ok', false, 'reason','invalid_transition','from',v_order.status,'to',p_next); end if;
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
    else update public.orders set status=p_next::public.order_status, cancel_reason=coalesce(p_reason,cancel_reason), updated_at=now() where id=p_order_id;
  end case;
  return jsonb_build_object('ok', true);
end;
$$;

-- 3) 既有膨脹資料修復：超過上限的一律壓回 initial_stock
update public.products set stock = least(stock, initial_stock) where stock > initial_stock;
