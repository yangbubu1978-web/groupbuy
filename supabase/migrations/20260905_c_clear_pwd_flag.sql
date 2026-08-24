-- ============================================================
-- 遷移 20260905_c：修復首登改密碼卡死循環
-- 症狀：會員完成改密碼後仍被要求再改一次（must_change_password 清不掉）
-- 原因：customers RLS 只有 SELECT 自己、沒有 UPDATE 自己，
--       前端直接 update 被靜默攔截。
-- 修法：security definer 函式，讓會員只能清「自己的」旗標。
-- ============================================================

create or replace function public.clear_must_change_password()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  update public.customers
     set must_change_password = false
   where auth_user_id = v_uid;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.clear_must_change_password() to authenticated;
