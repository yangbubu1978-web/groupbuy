-- Phase 1 / 完成交易入口收斂
-- purchase_product 不再是公開交易入口；前台正式流程只使用
-- reserve_product → checkout_reservation。
-- 保留函式名稱避免舊 migration 相依，但只允許 service_role 內部相容呼叫。

REVOKE ALL ON FUNCTION public.purchase_product(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchase_product(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.purchase_product(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_product(uuid, integer) TO service_role;
