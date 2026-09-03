-- 20260916 修 pending 過期回補無上限：與 cancel/admin/release 統一用 LEAST(initial_stock, ...) 封頂
-- 對應 PHASE 18 健檢：expire_stale_pending_orders 原本 stock + quantity 無上限，
-- 只要出現一筆 pending 單就會灌出 stock > initial_stock。只改回補這一行，其餘不動。

create or replace function public.expire_stale_pending_orders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select o.id, o.product_id, o.quantity
      from public.orders o
     where o.status = 'pending'
       and o.purchased_at < now() - interval '1 minute'
       and o.product_id is not null
     for update skip locked
  loop
    update public.orders set
      status = 'cancelled',
      cancelled_by = 'timeout',
      cancel_reason = coalesce(cancel_reason, '逾時未確認（1 分鐘），系統自動取消並釋回庫存'),
      updated_at = now()
     where id = r.id and status = 'pending';
    if found then
      v_count := v_count + 1;
      -- 回補庫存（與會員取消同一語義）：LEAST 封頂，避免灌超過初始庫存
      update public.products set stock = least(initial_stock, stock + r.quantity)
       where id = r.product_id;
    end if;
  end loop;
  return v_count;
end;
$$;
