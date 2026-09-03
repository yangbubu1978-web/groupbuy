-- Phase 0 / 安全：訂單狀態轉移必須由管理員執行
-- Database 層再次驗證，避免繞過 Edge Function 直接呼叫 SECURITY DEFINER RPC。
CREATE OR REPLACE FUNCTION public.admin_transition_order(
  p_order_id uuid,
  p_next text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_order public.orders%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
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
    or (v_order.status='paid' and p_next in ('shipped','refunding'))
    or (v_order.status='shipped' and p_next in ('completed','refunding'))
    or (v_order.status='completed' and p_next in ('refunding'))
    or (v_order.status='refunding' and p_next in ('refunded','shipped'))
  ) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'invalid_transition',
      'from', v_order.status,
      'to', p_next
    );
  end if;

  case
    when p_next='cancelled' then
      update public.orders
         set status='cancelled',
             cancelled_by='admin',
             cancel_reason=nullif(p_reason,''),
             updated_at=now()
       where id=p_order_id;
      if v_order.product_id is not null and v_order.status in ('pending','confirmed') then
        update public.products
           set stock=least(initial_stock, stock + v_order.quantity)
         where id=v_order.product_id;
        update public.products p
           set last_order_at=(
             select max(o.purchased_at)
               from public.orders o
              where o.product_id=p.id
                and o.status not in ('cancelled','refunded')
           )
         where p.id=v_order.product_id;
      end if;
    when p_next='refunded' then
      update public.orders
         set status='refunded',
             cancel_reason=coalesce(p_reason,cancel_reason),
             updated_at=now()
       where id=p_order_id;
      if v_order.product_id is not null then
        update public.products
           set stock=least(initial_stock, stock + v_order.quantity)
         where id=v_order.product_id;
        update public.products p
           set last_order_at=(
             select max(o.purchased_at)
               from public.orders o
              where o.product_id=p.id
                and o.status not in ('cancelled','refunded')
           )
         where p.id=v_order.product_id;
      end if;
    else
      update public.orders
         set status=p_next::public.order_status,
             cancel_reason=coalesce(p_reason,cancel_reason),
             updated_at=now()
       where id=p_order_id;
  end case;

  return jsonb_build_object('ok', true);
end;
$$;

REVOKE ALL ON FUNCTION public.admin_transition_order(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_transition_order(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_transition_order(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_transition_order(uuid, text, text) TO service_role;
