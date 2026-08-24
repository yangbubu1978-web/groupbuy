-- ============================================================
-- 遷移 20260823_a：電商級訂單流程
-- 1. order_status 列舉擴充：refunding（退款中）、refunded（已退款）
--    完整生命週期：
--    pending → confirmed → paid → shipped → completed（正向流程）
--        ↘ cancelled（會員取消／管理員取消，僅未出貨前）
--    shipped/completed → refunding → refunded（退貨退款）
-- 2. orders 新欄位：
--    cancelled_by   text   取消者：member／admin／system
--    cancel_reason  text   取消／退款原因
--    note           text   管理員備註（不對會員顯示）
-- 3. cancel_own_order()：會員取消自己的訂單（限 pending/confirmed，
--    Server 端驗證所有權＋狀態；取消即回補庫存，防超賣語義一致）
-- 4. admin_transition_order()：管理員狀態轉移（含合法狀態機檢查＋回補庫存）
-- ============================================================

-- 1) 列舉擴充（PostgreSQL alter type add value 無法包在交易，用條件式）
do $$ begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'order_status' and e.enumlabel = 'refunding'
  ) then
    alter type public.order_status add value 'refunding' after 'completed';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'order_status' and e.enumlabel = 'refunded'
  ) then
    alter type public.order_status add value 'refunded' after 'refunding';
  end if;
end $$;

-- 2) 新欄位
alter table public.orders
  add column if not exists cancelled_by text,
  add column if not exists cancel_reason text,
  add column if not exists note text;

comment on column public.orders.cancelled_by is '取消者：member/admin/system';
comment on column public.orders.cancel_reason is '取消或退款原因';
comment on column public.orders.note is '管理員內部備註';

-- 3) 會員取消自己的訂單（pending / confirmed 可取消；庫存回補）
create or replace function public.cancel_own_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid := auth.uid();
  v_order    public.orders%rowtype;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.user_id <> v_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  end if;

  -- 只有「待確認」「已確認」可自行取消（已付款請走退款流程）
  if v_order.status not in ('pending', 'confirmed') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;

  update public.orders set
    status = 'cancelled',
    cancelled_by = 'member',
    updated_at = now()
  where id = p_order_id;

  -- 庫存回補（原子）
  if v_order.product_id is not null then
    update public.products
       set stock = stock + v_order.quantity
     where id = v_order.product_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- 4) 管理員狀態機轉移（service role 於 Edge Function 內呼叫；
--    直接以 SQL 執行時需以 p_force 繞過 auth 檢查——Edge Function 用 service role 不經 RLS）
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

  -- 合法狀態機（電商標準）
  if not (
       (v_order.status = 'pending'   and p_next in ('confirmed','cancelled'))
    or (v_order.status = 'confirmed' and p_next in ('paid','cancelled'))
    or (v_order.status = 'paid'      and p_next in ('shipped','refunding'))
    or (v_order.status = 'shipped'   and p_next in ('completed','refunding'))
    or (v_order.status = 'completed' and p_next in ('refunding'))
    or (v_order.status = 'refunding' and p_next in ('refunded','shipped'))  -- 退款被拒→回到出貨態
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

grant execute on function public.cancel_own_order(uuid) to authenticated;
