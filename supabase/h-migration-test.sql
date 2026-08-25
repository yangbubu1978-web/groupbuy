-- ============================================================
-- 整合測試：20260905_h 有人下單歸零計時 ＋ 到底價等一輪才下架
-- 直接測 product_is_settled(public.products)
-- 概念：sale_start_at 前移＝elapsed 前進；last_order_at＝最後下單時刻
-- 前置：乾淨資料庫 → local-test-setup.sql → schema.sql → migrations/* → 本檔案
-- 可重跑（開頭自動清理測試資料）
-- ============================================================
\set ON_ERROR_STOP off

delete from public.products where name like 'H-%';
delete from public.campaigns where name = '__h_test__';

insert into public.campaigns (name, description, start_at, end_at, status)
values ('__h_test__', 'h 測試', now() - interval '1 hour', now() + interval '1 hour', 'active');

create temp table hres (scenario text, passed boolean);

-- helper：建立測試商品並回傳是否「已定案應下架」
-- 商品：原 1000 / 底 500 / 每 10 秒降 100（固定）→ S=5 步，floor_at = sale_start+50s
do $$
declare
  v_id uuid;
  r boolean;
begin
  insert into public.products
    (campaign_id, name, sku, original_price, minimum_price,
     price_interval_seconds, price_decrease, initial_stock, stock,
     max_per_customer, status, sale_start_at, last_order_at)
  values
    ((select id from public.campaigns where name='__h_test__'),
     'H1','H-1', 1000, 500, 10, 100, 100, 100, 5, 'active',
     now() - interval '60 seconds', null)
  returning id into v_id;
  r := public.product_is_settled((select p from public.products p where p.id = v_id));
  insert into hres values ('1: 到底滿一輪沒人下單 → 下架', r = true);
end $$;

do $$
declare
  v_id uuid;
  r boolean;
begin
  insert into public.products
    (campaign_id, name, sku, original_price, minimum_price,
     price_interval_seconds, price_decrease, initial_stock, stock,
     max_per_customer, status, sale_start_at, last_order_at)
  values
    ((select id from public.campaigns where name='__h_test__'),
     'H2','H-2', 1000, 500, 10, 100, 100, 100, 5, 'active',
     now() - interval '60 seconds', now() - interval '10 seconds')
  returning id into v_id;
  r := public.product_is_settled((select p from public.products p where p.id = v_id));
  insert into hres values ('2: 到底後 10s前下單（滿一輪）→ 下架', r = true);
end $$;

do $$
declare
  v_id uuid;
  r boolean;
begin
  insert into public.products
    (campaign_id, name, sku, original_price, minimum_price,
     price_interval_seconds, price_decrease, initial_stock, stock,
     max_per_customer, status, sale_start_at, last_order_at)
  values
    ((select id from public.campaigns where name='__h_test__'),
     'H3','H-3', 1000, 500, 10, 100, 100, 100, 5, 'active',
     now() - interval '60 seconds', now() - interval '5 seconds')
  returning id into v_id;
  r := public.product_is_settled((select p from public.products p where p.id = v_id));
  insert into hres values ('3: 到底後 5s前下單（未滿一輪）→ 不下架', r = false);
end $$;

do $$
declare
  v_id uuid;
  r boolean;
begin
  insert into public.products
    (campaign_id, name, sku, original_price, minimum_price,
     price_interval_seconds, price_decrease, initial_stock, stock,
     max_per_customer, status, sale_start_at, last_order_at)
  values
    ((select id from public.campaigns where name='__h_test__'),
     'H4','H-4', 1000, 500, 10, 100, 100, 100, 5, 'active',
     now() - interval '60 seconds', now() - interval '1 second')
  returning id into v_id;
  r := public.product_is_settled((select p from public.products p where p.id = v_id));
  insert into hres values ('4: 到底後 1s前下單（歸零）→ 不下架', r = false);
end $$;

do $$
declare
  v_id uuid;
  r boolean;
begin
  insert into public.products
    (campaign_id, name, sku, original_price, minimum_price,
     price_interval_seconds, price_decrease, initial_stock, stock,
     max_per_customer, status, sale_start_at, last_order_at)
  values
    ((select id from public.campaigns where name='__h_test__'),
     'H5','H-5', 1000, 500, 10, 100, 100, 100, 5, 'active',
     now() - interval '5 seconds', null)
  returning id into v_id;
  r := public.product_is_settled((select p from public.products p where p.id = v_id));
  insert into hres values ('5: 尚未到底 → 不下架', r = false);
end $$;

do $$
declare
  v_id uuid;
  r boolean;
begin
  insert into public.products
    (campaign_id, name, sku, original_price, minimum_price,
     price_interval_seconds, price_decrease, initial_stock, stock,
     max_per_customer, status, sale_start_at, last_order_at)
  values
    ((select id from public.campaigns where name='__h_test__'),
     'H6','H-6', 1000, 500, 10, 100, 100, 100, 5, 'active',
     now() - interval '60 seconds', now() - interval '60 seconds')
  returning id into v_id;
  r := public.product_is_settled((select p from public.products p where p.id = v_id));
  insert into hres values ('6: 開賣即下單（60s前，底部前）→ 到價後已等一輪 → 下架', r = true);
end $$;

select scenario, case when passed then 'PASS ✅' else 'FAIL ❌' end as result from hres;
select case when bool_and(passed) then 'ALL H TESTS PASSED 🎉'
            else 'SOME H TESTS FAILED ❌' end as final
from hres;