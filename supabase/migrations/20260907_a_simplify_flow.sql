-- ============================================================
-- P30 訂單流程簡化（雅布拍板）：放入購物車 → 確認 → 付款 → 完成
-- ============================================================
-- 正向流程不再經過 shipped；shipped 狀態保留（舊資料相容）但可跳過。
-- 退款鏈簡化：refunding → refunded（成立）或 paid（被拒復活）。

create or replace function public.admin_transition_order(
  p_order_id uuid,
  p_next     text,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- 合法狀態機（P30 簡化版：4 步正向流程，shipped 僅供舊資料）
  if not (
       (v_order.status = 'pending'   and p_next in ('confirmed','cancelled'))
    or (v_order.status = 'confirmed' and p_next in ('paid','cancelled'))
    or (v_order.status = 'paid'      and p_next in ('completed','shipped','refunding'))  -- shipped 保留給特殊情境
    or (v_order.status = 'shipped'   and p_next in ('completed','refunding'))            -- 舊資料出路
    or (v_order.status = 'completed' and p_next in ('refunding'))
    or (v_order.status = 'refunding' and p_next in ('refunded','paid'))  -- 退款被拒→回已付款
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition',
                              'from', v_order.status, 'to', p_next);
  end if;

  case
    when p_next = 'cancelled' then
      update public.orders set
        status = 'cancelled',
        cancelled_by = coalesce(nullif(p_reason, ''), 'admin'),
        cancel_reason = nullif(p_reason, ''),
        updated_at = now()
      where id = p_order_id;
      -- 未出貨取消 → 回補庫存
      if v_order.product_id is not null and v_order.status in ('pending','confirmed') then
        update public.products set stock = stock + v_order.quantity where id = v_order.product_id;
      end if;
    when p_next = 'refunded' then
      update public.orders set
        status = 'refunded',
        cancel_reason = coalesce(p_reason, cancel_reason),
        updated_at = now()
      where id = p_order_id;
      -- 退款成立 → 回補庫存
      if v_order.product_id is not null then
        update public.products set stock = stock + v_order.quantity where id = v_order.product_id;
      end if;
    else
      update public.orders set
        status = p_next::public.order_status,
        cancel_reason = coalesce(p_reason, cancel_reason),
        updated_at = now()
      where id = p_order_id;
  end case;
  return jsonb_build_object('ok', true);
end;
$$;
