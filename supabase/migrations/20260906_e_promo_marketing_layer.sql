-- ============================================================
-- 遷移 20260906_e：促銷活動＝行銷展示層（定位明確化）
--
-- 核心原則（雅布大人 2026-08-26 拍板）：
--   Product 決定「商品怎麼賣」（價格/降價/庫存/上下架）
--   Promotion 只決定「商品怎麼被看見」（名稱/圖示/Banner/排序）
--   ⚠️ 本表與其關聯「不得」修改 products 的任何銷售邏輯——
--      無 trigger、無 RPC 引用、無價格干涉；活動停用＝標籤消失，商品照常販售降價
--
-- 變更（全部 nullable/default，零破壞）：
--   icon       活動圖示（emoji）
--   banner_url 活動 Banner 圖
--   theme_color 主題色（Tailwind 色票 key 或 hex）
--   sort_order  活動級顯示排序（小＝前面）
-- 冪等：if not exists
-- ============================================================

alter table public.promotions
  add column if not exists icon text,
  add column if not exists banner_url text,
  add column if not exists theme_color text,
  add column if not exists sort_order int not null default 0;

comment on table public.promotions is
  '行銷展示層：僅用於商品展示與分類，不影響商品價格、庫存、上下架及降價規則。';
