-- ============================================================
-- 整合測試：20260922 降價機制改造「設定總降價時間，自動計算降價價格」
-- 前置：乾淨資料庫 → local-test-setup.sql → schema.sql →
--       migrations/20260822_b_random_pricing.sql → migrations/20260922_drop_schedule_pricing.sql
-- 概念：sale_start_at 前移＝elapsed 前進（now() 在單一交易內固定，故偏移量精確）
-- 可重跑（開頭自動清理測試資料）
-- 用法：psql -d <db> -f supabase/drop-schedule-migration-test.sql
-- ============================================================
\set ON_ERROR_STOP off

-- 不使用單一大交易：任一斷言失敗不會讓後面全部 abort（now() 在相鄰敘述間只差毫秒，
-- price_at 取「週期中段」已預留 ≥3.3 秒餘裕，floor(elapsed/間隔) 不受影響）

delete from public.products where name like 'DROPTEST-%';
delete from public.campaigns where name = '__drop_test__';
insert into public.campaigns (name, description, start_at, end_at, status)
values ('__drop_test__', '降價排程測試', now() - interval '1 day', now() + interval '365 days', 'active');

create temp table dres (scenario text, expected text, actual text, passed boolean);
create temp table dprobe (scenario text, probe_k int, ivl int, price numeric);

-- ── 測試情境表 ──
-- legacy = true 者 = 舊隨機步長模式（drop_total_seconds 留 null，用 lo~hi 隨機步長）
create temp table dsc (
  sid text primary key, orig numeric, minp numeric, total int, ivl int,
  legacy boolean default false, lo int, hi int
);
insert into dsc (sid, orig, minp, total, ivl, legacy, lo, hi) values
  ('A', 399,  99,  600,  60,  false, null, null),  -- 正常整除：N=10、每步 30
  ('B', 999,  299, 1800, 60,  false, null, null),  -- 非整除→自動調整：理想 30 次 → 28 次、每步 25
  ('C', 1000, 500, 600,  10,  false, null, null),  -- 間隔 10 秒：理想 60 次 → 50 次、每步 10
  ('D', 1000, 500, 600,  30,  false, null, null),  -- 間隔 30 秒：N=20、每步 25
  ('E', 1000, 500, 600,  60,  false, null, null),  -- 間隔 1 分鐘：N=10、每步 50
  ('F', 1000, 500, 600,  300, false, null, null),  -- 間隔 5 分鐘：N=2、每步 250
  ('G', 1500, 1000, 7200, 60, false, null, null),  -- 長時程 2 小時：理想 120 次 → 125 次、每步 4
  ('H', 500,  100, 0,    60,  true,  50,  50),     -- 舊模式對照：固定降 50
  ('I', 600,  100, 0,    100, true,  1,   20);     -- 舊模式對照：每次降 1~20 隨機

-- 固定 uuid（方便比對；md5 前 12 碼）
create or replace function pg_temp.did(sid text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || substr(md5(sid), 1, 12))::uuid;
$$;

create or replace function pg_temp.mk(sid text) returns uuid language plpgsql as $$
declare v uuid := pg_temp.did(sid); r dsc;
begin
  select * into r from dsc d where d.sid = mk.sid;
  insert into public.products (id, campaign_id, name, sku, original_price, minimum_price,
    price_interval_seconds, price_decrease, price_decrease_max, drop_total_seconds,
    initial_stock, stock, max_per_customer, status, sale_start_at)
  values (v, (select id from public.campaigns where name='__drop_test__'),
    'DROPTEST-'||sid, 'DROPTEST-'||sid, r.orig, r.minp, r.ivl,
    case when r.legacy then r.lo else greatest(1, floor((r.orig - r.minp) / greatest(1, r.total / r.ivl))) end,
    case when r.legacy then r.hi else null end,
    case when r.legacy then null else r.total end,
    100, 100, 5, 'active', now() - interval '1 hour');
  return v;
end $$;

select pg_temp.mk(sid) from dsc;

-- 依情境把 sale_start_at 前移成「第 k 步之後的中段」，回傳該時刻的價格
create or replace function pg_temp.price_at(sid text, k int, frac numeric default 0.33) returns numeric
language plpgsql as $$
declare r dsc; v numeric;
begin
  select * into r from dsc d where d.sid = price_at.sid;
  update public.products set sale_start_at = now() - make_interval(secs => (k * r.ivl + r.ivl * frac)::double precision)
    where id = pg_temp.did(sid);
  select public.compute_current_price(p) into v from public.products p where p.id = pg_temp.did(sid);
  return v;
end $$;

create or replace function pg_temp.settled_at(sid text, elapsed numeric) returns boolean
language plpgsql as $$
declare r dsc; v boolean;
begin
  select * into r from dsc d where d.sid = settled_at.sid;
  update public.products set sale_start_at = now() - make_interval(secs => elapsed::double precision)
    where id = pg_temp.did(sid);
  select public.product_is_settled(p) into v from public.products p where p.id = pg_temp.did(sid);
  return v;
end $$;

create or replace function pg_temp.chk(scenario text, expected text, actual text) returns void
language sql as $$
  insert into dres values (scenario, expected, actual, expected = actual);
$$;

-- 價格 → 文字（去掉 numeric 尾零：399.00 → 399）
create or replace function pg_temp.pts(sid text, k int, frac numeric default 0.33) returns text
language sql as $$
  select trim_scale(pg_temp.price_at(sid, k, frac))::text;
$$;

-- ══════════════════════════════════════════════════════════════
-- ① 正常整除：399 → 99、總 10 分鐘、間隔 1 分鐘
--    變價 10 次、每步 30 → 399→369→339→…→129→99
-- ══════════════════════════════════════════════════════════════
select pg_temp.chk('①(1) k=0（未滿一期）＝起始價 399', '399', pg_temp.pts('A',0,0.5));
select pg_temp.chk('①(2) k=1 ＝ 369', '369', pg_temp.pts('A', 1));
select pg_temp.chk('①(3) k=2 ＝ 339', '339', pg_temp.pts('A', 2));
select pg_temp.chk('①(4) k=5 ＝ 249', '249', pg_temp.pts('A', 5));
select pg_temp.chk('①(5) k=9 ＝ 129', '129', pg_temp.pts('A', 9));
select pg_temp.chk('①(6) k=10 ＝ 99（剛好底價）', '99', pg_temp.pts('A', 10));
select pg_temp.chk('①(7) 整條序列 399→369→…→99',
  '399,369,339,309,279,249,219,189,159,129,99',
  (select string_agg(pg_temp.pts('A',g), ',' order by g) from generate_series(0,10) g));

-- ══════════════════════════════════════════════════════════════
-- ② 非整除 → 自動調整次數（2026-09-15 雅布拍板）：999 → 299、總 30 分鐘、間隔 1 分鐘
--    理想 30 次；總降價 700 無法被 30 整除 → 取最接近的因數 28（每步 25、實際總時間 28 分鐘）
-- ══════════════════════════════════════════════════════════════
select pg_temp.chk('②(1) k=1 ＝ 974（每步 25）', '974', pg_temp.pts('B', 1));
select pg_temp.chk('②(2) k=27 ＝ 324（999−27×25）', '324', pg_temp.pts('B', 27));
select pg_temp.chk('②(3) k=28 ＝ 299（第 28 次剛好到底價）', '299', pg_temp.pts('B', 28));
select pg_temp.chk('②(6) k=29 之後不再降（維持 299）', '299', pg_temp.pts('B', 29));
select pg_temp.chk('②(7) drop_schedule_steps(700,30) ＝ 28（取最接近因數）', '28', public.drop_schedule_steps(700,30)::text);
select pg_temp.chk('②(4) 全程不低於底價（k=0..90 最小值 ≥ 299）', 'true',
  (select (min(pg_temp.price_at('B',g)) >= 299)::text from generate_series(0,90) g));
select pg_temp.chk('②(5) 起點仍是起始價 999', '999', pg_temp.pts('B',0,0.9));

-- ══════════════════════════════════════════════════════════════
-- ③ 降價間隔 10 秒／30 秒／1 分鐘／5 分鐘（同樣 1000→500、總 10 分鐘）
-- ══════════════════════════════════════════════════════════════
select pg_temp.chk('③(1) 間隔 10 秒：k=1 ＝ 990（理想 60 → 調整 50 次、每步 10）', '990', pg_temp.pts('C', 1));
select pg_temp.chk('③(2) 間隔 10 秒：k=50 ＝ 500（第 50 次到底價）', '500', pg_temp.pts('C', 50));
select pg_temp.chk('③(3) 間隔 30 秒：k=1 ＝ 975（N=20、每步 25）', '975', pg_temp.pts('D', 1));
select pg_temp.chk('③(4) 間隔 30 秒：k=20 ＝ 500', '500', pg_temp.pts('D', 20));
select pg_temp.chk('③(5) 間隔 1 分鐘：k=1 ＝ 950（N=10、每步 50）', '950', pg_temp.pts('E', 1));
select pg_temp.chk('③(6) 間隔 1 分鐘：k=10 ＝ 500', '500', pg_temp.pts('E', 10));
select pg_temp.chk('③(7) 間隔 5 分鐘：k=1 ＝ 750（N=2、每步 250）', '750', pg_temp.pts('F', 1));
select pg_temp.chk('③(8) 間隔 5 分鐘：k=2 ＝ 500', '500', pg_temp.pts('F', 2));
select pg_temp.chk('③(9) 四種節奏的第 1 步價格都不同', '990|975|950|750',
  pg_temp.pts('C', 1) || '|' || pg_temp.pts('D', 1) || '|' || pg_temp.pts('E', 1) || '|' || pg_temp.pts('F', 1));
select pg_temp.chk('③(10) 長時程 2 小時：k=1 ＝ 1496（理想 120 → 調整 125 次、每步 4）', '1496', pg_temp.pts('G', 1));
select pg_temp.chk('③(11) 長時程 2 小時：k=120 ＝ 1020（尚未到底價）', '1020', pg_temp.pts('G', 120));
select pg_temp.chk('③(12) 長時程 2 小時：k=125 ＝ 1000（第 125 次到底價）', '1000', pg_temp.pts('G', 125));

-- ══════════════════════════════════════════════════════════════
-- ④ 到達底價後不再繼續降價（價格永不回彈）
-- ══════════════════════════════════════════════════════════════
select pg_temp.chk('④(1) k=11 仍是 99', '99', pg_temp.pts('A', 11));
select pg_temp.chk('④(2) k=100 仍是 99', '99', pg_temp.pts('A', 100));
select pg_temp.chk('④(3) k=1000 仍是 99', '99', pg_temp.pts('A', 1000));
select pg_temp.chk('④(4) 觸底後不會低於底價（k=0..500 步進 7 最小值 = 99）', '99',
  (select trim_scale(min(pg_temp.price_at('A',g)))::text from generate_series(0,500,7) g));

-- ══════════════════════════════════════════════════════════════
-- ⑤ 商品被購買後正常停止降價（下單不改變價格曲線；觸底滿一輪才下架）
-- ══════════════════════════════════════════════════════════════
-- (a) 有人下單（last_order_at = now()）不影響價格曲線
update public.products set last_order_at = now() where id = pg_temp.did('A');
select pg_temp.chk('⑤(1) 有人下單後價格仍照曲線（k=6 ＝ 219）', '219', pg_temp.pts('A', 6));
update public.products set last_order_at = null where id = pg_temp.did('A');

-- (b) 觸底時刻 = 開賣 + N × 間隔 = +600 秒；未滿一輪不判 settled
select pg_temp.chk('⑤(2) 未觸底（599 秒）不判下架', 'false', pg_temp.settled_at('A',599)::text);
select pg_temp.chk('⑤(3) 觸底當下（600 秒）不判下架', 'false', pg_temp.settled_at('A',600)::text);
select pg_temp.chk('⑤(4) 觸底後不滿一輪（630 秒）不判下架', 'false', pg_temp.settled_at('A',630)::text);
select pg_temp.chk('⑤(5) 觸底後滿一輪（661 秒）→ 應下架', 'true', pg_temp.settled_at('A',661)::text);

-- (c) 觸底後有人下單 → 下架倒數歸零重算
update public.products set last_order_at = now() where id = pg_temp.did('A');
select pg_temp.chk('⑤(6) 觸底後剛有人下單 → 不判下架', 'false', pg_temp.settled_at('A',700)::text);
update public.products set last_order_at = now() - interval '61 seconds' where id = pg_temp.did('A');
select pg_temp.chk('⑤(7) 該筆下單已滿一輪 → 應下架', 'true', pg_temp.settled_at('A',700)::text);
update public.products set last_order_at = null where id = pg_temp.did('A');

-- (d) 有活預訂 → 不判下架
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'drop-test@example.com')
  on conflict (id) do nothing;
insert into public.cart_reservations (product_id, user_id, quantity, locked_unit_price, status, expires_at)
values (pg_temp.did('A'), '11111111-1111-1111-1111-111111111111', 1, 99, 'active', now() + interval '1 minute')
on conflict do nothing;
select pg_temp.chk('⑤(8) 有活預訂 → 不判下架（結帳時間神聖不可侵犯）', 'false', pg_temp.settled_at('A',661)::text);
delete from public.cart_reservations where product_id = pg_temp.did('A');

-- ══════════════════════════════════════════════════════════════
-- ⑥ 新舊並存：H／I 走舊隨機步長模式，結果與舊公式完全一致（不被新分支污染）
-- ══════════════════════════════════════════════════════════════
select pg_temp.chk('⑥(1) 舊模式商品 drop_total_seconds 為 null', 'null',
  (select coalesce(drop_total_seconds::text, 'null') from public.products where id = pg_temp.did('H')));
select pg_temp.chk('⑥(2) 舊模式固定降 50：k=1 ＝ 450', '450', pg_temp.pts('H', 1));
select pg_temp.chk('⑥(3) 舊模式固定降 50：k=8 觸底 100', '100', pg_temp.pts('H', 8));
do $$
declare v_price numeric; v_expected numeric;
begin
  v_price := pg_temp.price_at('I', 5);   -- 舊模式隨機步長：前移到第 5 步中段後取值
  select greatest(100::numeric,
           600 - coalesce(sum(public.rand_step(pg_temp.did('I')::text || '|0|' || g::text, 1, 20)), 0))
    into v_expected from generate_series(0, 4) g;
  insert into dres values ('⑥(4) 舊模式隨機步長 1~20：與舊公式獨立重算一致',
    'rand_step 累加 = ' || v_expected, 'compute_current_price = ' || v_price, v_price = v_expected);
end $$;

-- ══════════════════════════════════════════════════════════════
-- ⑦ check 約束：drop_total_seconds 不得為 0 或負數
-- ══════════════════════════════════════════════════════════════
do $$
declare v_ok boolean;
begin
  v_ok := false;
  begin
    update public.products set drop_total_seconds = 0 where id = pg_temp.did('A');
  exception when check_violation then v_ok := true;
  end;
  insert into dres values ('⑦(1) drop_total_seconds=0 被 check 擋下', 'true', v_ok::text, v_ok);

  v_ok := false;
  begin
    update public.products set drop_total_seconds = -5 where id = pg_temp.did('A');
  exception when check_violation then v_ok := true;
  end;
  insert into dres values ('⑦(2) drop_total_seconds=-5 被 check 擋下', 'true', v_ok::text, v_ok);
end $$;

-- ══════════════════════════════════════════════════════════════
-- ⑧ 前後端同公式比對用：(情境, 第 k 步, 價格) 全部倒出來給 JS 端比對
-- ══════════════════════════════════════════════════════════════
insert into dprobe (scenario, probe_k, ivl, price)
select s.sid, g, s.ivl, pg_temp.price_at(s.sid, g)
from dsc s cross join lateral generate_series(0, (s.total / s.ivl) + 2) g
where not s.legacy;

-- ══════════════════════════════════════════════════════════════
-- 結果
-- ══════════════════════════════════════════════════════════════
select '=== 斷言結果 ===' as out;
select case when passed then 'PASS' else 'FAIL' end as status, scenario, expected, actual from dres order by scenario;
select '=== 總結 ===' as out;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from dres;
select '=== PROBE_TSV ===' as out;
select 'PROBE' || chr(9) || scenario || chr(9) || probe_k || chr(9) || ivl || chr(9) || price from dprobe order by scenario, probe_k;

-- 收尾：清掉測試資料（保留 schema 與函式）
delete from public.cart_reservations where product_id in (select id from public.products where name like 'DROPTEST-%');
delete from public.products where name like 'DROPTEST-%';
delete from public.campaigns where name = '__drop_test__';
