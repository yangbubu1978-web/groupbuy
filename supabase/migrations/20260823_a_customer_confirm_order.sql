-- ============================================================
-- 遷移 20260823_a：客戶自行確認訂單
-- 需求：我的訂單要有「確認訂單」功能（客戶端按下後 pending → confirmed）
-- 安全設計：
--   1. SECURITY DEFINER 函式繞過 RLS，但內部嚴格檢查訂單持有人
--   2. 只允許 pending → confirmed 這一步；其他流轉仍是 admin 專屬
--   3. 回傳 jsonb: { ok, reason? }（對齊 purchase_product 慣例）
-- ============================================================

create or replace function public.confirm_own_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_current public.order_status;
begin
  -- (1) 必須登入
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  -- (2) 鎖定該列並確認持有人（防越權：不能確認別人的訂單）
  select status into v_current
  from public.orders
  where id = p_order_id and user_id = v_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  end if;

  -- (3) 只允許 待確認 → 已確認
  if v_current <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;

  update public.orders
  set status = 'confirmed', updated_at = now()
  where id = p_order_id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.confirm_own_order(uuid) to authenticated;
