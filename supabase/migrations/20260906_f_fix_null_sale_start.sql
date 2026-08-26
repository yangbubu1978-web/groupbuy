-- ============================================================
-- 遷移 20260906_f：補救幽靈商品（sale_start_at 為 null 永遠原價、永不觸底）
--
-- 背景：後台舊版允許開賣時間留空，造成商品 sale_start_at = null：
--   compute_current_price() 回原價（永不降價）
--   product_is_settled() 回 false（永不自動下架）
-- 違反核心商業模式「商品上架 → 價格逐步下降 → 到底下架」。
-- 修法：active/paused 且 sale_start_at 為 null 的商品，一律補 now()，
--       從補救當下開始走降價曲線（draft 不動）。
-- ============================================================

update public.products
   set sale_start_at = now()
 where sale_start_at is null
   and status in ('active', 'paused');
