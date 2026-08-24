-- ============================================================
-- 遷移 20260905_a：促銷活動（VIP 站）
-- promotions：活動主檔（名稱、起訖時間、狀態）
-- promotion_items：活動商品（多選）
-- 規則：
--   - 活動期間內，活動中的商品才可購買（首頁只陳列進行中活動的商品）
--   - 活動結束 → 停止販售（商品卡從首頁消失；活動頁標記已結束）
--   - 價格照原定 12 小時隨機遞減規則運作，促銷不改價
--   - 支援多個活動並行；同一商品可同時屬於多個活動
-- ============================================================

create table if not exists public.promotions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint chk_promo_time check (ends_at > starts_at)
);

create table if not exists public.promotion_items (
  id           uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  sort_order   int not null default 0,
  unique (promotion_id, product_id)
);

create index if not exists idx_promo_items_promo on public.promotion_items(promotion_id);
create index if not exists idx_promo_items_product on public.promotion_items(product_id);
create index if not exists idx_promotions_time on public.promotions(starts_at, ends_at);

-- RLS：公開讀取（僅 active），管理員寫入
alter table public.promotions enable row level security;
alter table public.promotion_items enable row level security;

drop policy if exists "promo_public_read" on public.promotions;
create policy "promo_public_read" on public.promotions
  for select using (is_active = true);

drop policy if exists "promo_admin_all" on public.promotions;
create policy "promo_admin_all" on public.promotions
  for all using (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

drop policy if exists "promo_items_public_read" on public.promotion_items;
create policy "promo_items_public_read" on public.promotion_items
  for select using (
    exists (
      select 1 from public.promotions p
      where p.id = promotion_id and p.is_active = true
    )
  );

drop policy if exists "promo_items_admin_all" on public.promotion_items;
create policy "promo_items_admin_all" on public.promotion_items
  for all using (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  );
