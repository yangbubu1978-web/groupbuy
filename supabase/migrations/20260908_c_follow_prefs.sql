-- ============================================================
-- 20260908_c_follow_prefs
-- product_follows 降價通知選項 + notification_logs 降價 dedup 支援
-- 安全遷移：所有變更皆用 IF NOT EXISTS / DO $$ 檢查存在性
-- ============================================================

-- ------------------------------------------------------------
-- 1. product_follows.notify_price_drop
--    讓使用者可選「是否也通知降價」
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'product_follows'
      and column_name = 'notify_price_drop'
  ) then
    alter table public.product_follows
      add column notify_price_drop boolean not null default false;
  end if;
end $$;

comment on column public.product_follows.notify_price_drop is
  '是否通知降價：true=此追蹤也接收降價通知，false=僅開賣通知';

-- 選配：查詢「有開啟降價通知的追蹤」時加速
create index if not exists idx_follows_notify_price_drop
  on public.product_follows(product_id)
  where notify_price_drop = true;

-- ------------------------------------------------------------
-- 2. notification_logs 降價通知 dedup 支援
-- ------------------------------------------------------------
-- 已有結構：
--   notification_logs.type  text  default 'sale_start'
--   notification_logs.dedup_key  text  unique
--   開賣 dedup_key 格式：user_id:product_id:sale_start_at (ISO8601)
--
-- 降價通知約定（不改表結構，僅文件/應用層約束）：
--   type      = 'price_drop_30' / 'price_drop_50' / 'price_drop_70'
--             命名規則：price_drop_{門檻pct}  例：price_drop_30 表示「降價達 30% 門檻」
--             未來若需彈性門檻亦可寫 price_drop_25 等
--   dedup_key = user_id:product_id:price_drop:30pct
--             例：550e8400-...:660e8400-...:price_drop:30pct
--             同一使用者 × 同一商品 × 同一門檻僅發送一次；再次降價觸發更高門檻時
--             dedup_key 不同（:price_drop:50pct）可再次通知。
--   寫入時請以 INSERT ... ON CONFLICT (dedup_key) DO NOTHING 達成去重。
--
-- 為避免未來 type 欄位被誤用為任意字串，可選加 CHECK（此處僅註解說明，不強制）：
--   check (type in ('sale_start','price_drop_30','price_drop_50','price_drop_70')
--          or type like 'price_drop\_%' escape '\')

-- ------------------------------------------------------------
-- 3. 查詢索引：加速「查某商品的降價通知發送紀錄」
-- ------------------------------------------------------------
create index if not exists idx_notification_logs_price_drop
  on public.notification_logs(product_id, type)
  where type like 'price_drop%';
