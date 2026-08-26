-- ============================================================
-- P28：pending 訂單自動過期（30 分鐘未確認 → 自動取消＋回補庫存）
-- ============================================================
-- 問題：客戶結帳後不確認訂單 → pending 永不過期 →
--       ①庫存被佔住（stock 已扣）②限購額度被吃掉（status<>'cancelled' 全算）→ 商品卡死無法再售
-- 解法：cron 每分鐘掃描，pending 超 30 分鐘 → cancelled（cancelled_by='timeout'）＋庫存回補。
--       庫存回補後 product_is_settled 判定恢復運作（觸底＋一輪無人買 → 正常下架流程），
--       管理員也可從後台手動「重新上架」立即恢復販售。
--
-- ⚠️ 不影響：confirmed 以後的訂單不受此限（已確認＝有效交易）；
--           last_order_at 不動——降價曲線錨點不因棄單而重置。

-- 1) 過期取消函式：冪等、可獨立測試
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
       and o.purchased_at < now() - interval '30 minutes'
       and o.product_id is not null
     for update skip locked
  loop
    update public.orders set
      status = 'cancelled',
      cancelled_by = 'timeout',
      cancel_reason = coalesce(cancel_reason, '逾時未確認（30 分鐘），系統自動取消並釋回庫存'),
      updated_at = now()
     where id = r.id and status = 'pending';
    if found then
      v_count := v_count + 1;
      -- 回補庫存（與會員取消同一語義）
      update public.products set stock = stock + r.quantity
       where id = r.product_id;
    end if;
  end loop;
  return v_count;
end;
$$;

-- 2) cron：每分鐘執行（與 auto-delist 同一節奏）
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'expire-stale-pending-orders';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'expire-stale-pending-orders',
  '* * * * *',
  $job$select public.expire_stale_pending_orders();$job$
);
