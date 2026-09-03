-- Phase 9 / 確認訂單函式權限收斂
--
-- confirm_own_order 仍是前台「待確認→已確認」按鈕需要的入口，不可停用。
-- 但線上 GRANT 包含 anon 與 PUBLIC，不需要這麼寬。
-- 函式本體會驗證持有人，匿名會被擋下；此處把門面縮到已登入會員，
-- 減少不必要的對外暴露。已登入使用者的行為完全不變。
REVOKE ALL ON FUNCTION public.confirm_own_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_own_order(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.confirm_own_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_own_order(uuid) TO service_role;
