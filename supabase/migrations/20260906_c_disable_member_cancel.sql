-- ============================================================
-- 遷移 20260906_c：移除會員自助取消（方案 A，雅布大人 2026-08-25 拍板）
--
-- 背景：降價商城的套利洞——會員先買 1 件，等降價後取消重買，
--       等於「零風險等到最低價」，破壞整個降價曲線的激勵設計
--
-- 變更：
--   1. cancel_own_order() 改為一律回傳 cancelled_disabled（API 層防禦；
--      前端按鈕已同步移除）。函數保留簽名不刪除，避免舊版前端呼叫直接炸
--   2. cancelled_by='member' 的歷史訂單語義保留不動
--
-- 誤購救濟：請客人聯絡管理員，由後台 admin_transition_order() 取消
-- 冪等：create or replace
-- ============================================================

create or replace function public.cancel_own_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 方案 A：會員自助取消已停用（降價商城防「取消→等降價→重買」套利）
  -- 一律回 false；真實取消需求走管理員後台 admin_transition_order()
  return jsonb_build_object(
    'ok', false,
    'reason', 'cancelled_disabled',
    'message', '如需取消訂單，請聯絡管理員為您處理'
  );
end;
$$;

grant execute on function public.cancel_own_order(uuid) to authenticated;
