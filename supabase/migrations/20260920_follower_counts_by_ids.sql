-- 20260920 關注人數批次查詢：只算畫面上的商品，不掃全表
-- 背景：product_follower_counts() 無參數，全表聚合，
--   首頁與詳情頁每進一次各掃一次，關注表一大就拖慢列表。
-- 修法：新增 product_follower_counts_by_ids(p_ids uuid[])，
--   只統計傳入清單內的商品；舊函式保留（單品頁仍在用，不動）。
-- 前端改為傳畫面上商品 id 陣列呼叫新函式，空陣列直接跳過不查。

CREATE OR REPLACE FUNCTION public.product_follower_counts_by_ids(p_ids uuid[])
RETURNS table (product_id uuid, follower_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  select product_id, count(*)::bigint
    from public.product_follows
   where product_id = any (p_ids)
   group by product_id;
$$;

REVOKE ALL ON FUNCTION public.product_follower_counts_by_ids(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.product_follower_counts_by_ids(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.product_follower_counts_by_ids(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.product_follower_counts_by_ids(uuid[]) TO service_role;
