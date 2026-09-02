-- 支援 5 勾勾：上架 + 30/50/70 獨立勾選
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name='product_follows' and column_name='notify_sale') then
    alter table product_follows add column notify_sale boolean not null default true;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='product_follows' and column_name='notify_30') then
    alter table product_follows add column notify_30 boolean not null default false;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='product_follows' and column_name='notify_50') then
    alter table product_follows add column notify_50 boolean not null default false;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='product_follows' and column_name='notify_70') then
    alter table product_follows add column notify_70 boolean not null default false;
  end if;
end $$;
-- 遷移舊資料：once => 30, all => 30+50+70
update product_follows set notify_30=true where notify_price_drop=true and price_drop_mode='once' and notify_30=false;
update product_follows set notify_30=true, notify_50=true, notify_70=true where notify_price_drop=true and price_drop_mode='all' and notify_30=false;
