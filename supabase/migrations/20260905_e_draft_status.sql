-- ============================================================
-- 遷移 20260905_e：草稿暫存（VIP 站）
--  1) 商品：product_status 加 'draft'（草稿商品完全不上前台）
--  2) 促銷：新增 status (draft/active) 欄位；草稿促銷完全不上前台
--  3) RLS：公開查詢排除草稿（不影響商品過濾、不顯示橫幅）
-- 冪等：可安全重跑
-- ============================================================

-- ---------- 1) 商品草稿狀態 ----------
alter type public.product_status add value if not exists 'draft';

-- ---------- 2) 促銷草稿狀態 ----------
create type public.promotion_status as enum ('draft', 'active');
alter table public.promotions add column if not exists status public.promotion_status not null default 'active';

-- ---------- 3) RLS：公開查詢排除草稿促銷 ----------
alter table public.promotions enable row level security;
alter table public.promotion_items enable row level security;

drop policy if exists "promo_public_read" on public.promotions;
create policy "promo_public_read" on public.promotions
  for select using (is_active = true and status = 'active');

drop policy if exists "promo_items_public_read" on public.promotion_items;
create policy "promo_items_public_read" on public.promotion_items
  for select using (
    exists (
      select 1 from public.promotions p
      where p.id = promotion_id and p.is_active = true and p.status = 'active'
    )
  );