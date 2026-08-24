-- product item_no (商品品號, 選填) — 前端表單/訂單匯出依賴此欄位
-- 修復「Could not find the 'item_no' column of 'products' in the schema cache」
alter table public.products add column if not exists item_no text;