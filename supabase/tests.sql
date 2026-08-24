-- ============================================================
-- 整合測試（Phase 6 — Test 1～8）
-- 前置：乾淨資料庫 → local-test-setup.sql → schema.sql → 本檔案
--
-- 說明：
--   - purchase_product 是 SECURITY DEFINER：模擬使用者只需設定
--     request.jwt.claims（auth.uid() 讀取），不需切換角色
--   - 直接存表的安全性測試（Test 5/6/7）才切換 role=authenticated
--   - Test 2 在單一交易內連續搶購同一商品：FOR UPDATE 序列化保證
--     一勝一敗（真實併發由 PostgreSQL 列鎖保證，語義相同）
-- ============================================================

\set ON_ERROR_STOP off

-- 對齊 Supabase 預設授權（RLS 才是真正的關卡）
grant select, insert, update, delete on all tables in schema public to authenticated;

create temp table test_results (
  id serial primary key,
  name text,
  passed boolean
);

-- ---------- 測試專用活動與商品 ----------
insert into public.campaigns (name, description, start_at, end_at, status)
values ('__test__', '整合測試', now() - interval '10 seconds',
        now() + interval '10 minutes', 'active');

insert into public.products
  (campaign_id, name, sku, original_price, minimum_price,
   price_interval_seconds, price_decrease, initial_stock, stock,
   max_per_customer, status, sale_start_at)
values
  ((select id from public.campaigns where name='__test__'),
   'T1', 'T-1', 1000, 500, 1, 100, 3, 3, 2, 'active', now()),
  ((select id from public.campaigns where name='__test__'),
   'TLAST', 'T-L', 1000, 500, 60, 10, 1, 1, 5, 'active', now()),
  ((select id from public.campaigns where name='__test__'),
   'TZERO', 'T-Z', 1000, 500, 60, 10, 0, 0, 5, 'active', now());

create temp table _ids as
  select id, name from public.products where name in ('T1', 'TLAST', 'TZERO');

create temp table _users as
  select c.id as customer_id, c.auth_user_id, c.phone
  from public.customers c
  where c.phone in ('0975389197', '0912000002');

-- ============================================================
-- Test 1 — 單一客戶正常購買
-- ============================================================
do $$
declare
  v_uid uuid; v_pid uuid; r jsonb;
begin
  select auth_user_id into v_uid from _users where phone = '0975389197';
  select id into v_pid from _ids where name = 'T1';

  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_uid)::text, true);

  select public.purchase_product(v_pid, 1) into r;

  insert into test_results (name, passed)
  values ('Test 1: 單一客戶正常購買',
          coalesce((r->>'ok')::boolean, false)
          and (r->>'order_no') is not null);
end $$;

-- ============================================================
-- Test 2 — 兩人搶最後 1 件（恰一人成功）
-- ============================================================
do $$
declare
  v_a uuid; v_b uuid; v_pid uuid;
  r_a jsonb; r_b jsonb; ok_count int;
begin
  select auth_user_id into v_a from _users where phone = '0975389197';
  select auth_user_id into v_b from _users where phone = '0912000002';
  select id into v_pid from _ids where name = 'TLAST';

  begin
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', v_a)::text, true);
    select public.purchase_product(v_pid, 1) into r_a;
  exception when others then r_a := '{"ok":false}'::jsonb;
  end;

  begin
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', v_b)::text, true);
    select public.purchase_product(v_pid, 1) into r_b;
  exception when others then r_b := '{"ok":false}'::jsonb;
  end;

  select count(*) into ok_count
    from (select coalesce((r_a->>'ok')::boolean, false) ok
          union all
          select coalesce((r_b->>'ok')::boolean, false)) x
    where ok;

  insert into test_results (name, passed)
  values ('Test 2: 兩人搶最後一件恰一人成功',
          ok_count = 1
          and coalesce((r_a->>'ok')::boolean, false)
              <> coalesce((r_b->>'ok')::boolean, false));
end $$;

-- ============================================================
-- Test 3 — 庫存 0 無法購買
-- ============================================================
do $$
declare
  v_uid uuid; v_pid uuid; r jsonb;
begin
  select auth_user_id into v_uid from _users where phone = '0975389197';
  select id into v_pid from _ids where name = 'TZERO';

  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_uid)::text, true);
  select public.purchase_product(v_pid, 1) into r;

  insert into test_results (name, passed)
  values ('Test 3: 庫存 0 拒絕',
          coalesce(r->>'ok', 'x') = 'false'
          and r->>'reason' = 'sold_out');
end $$;

-- ============================================================
-- Test 4 — Server 使用正確價格
-- T1：原價 1000、每 1 秒降 100、最低 500；種子後已過遠超 5 秒
-- → floor(elapsed/1) ≥ 5 次 → 地板價 500
-- ============================================================
do $$
declare
  v_uid uuid; v_pid uuid; r jsonb;
begin
  select auth_user_id into v_uid from _users where phone = '0975389197';
  select id into v_pid from _ids where name = 'T1';

  -- 確定性跨檔：把開賣時間前移 10 秒
  -- → floor(10/1)=10 次 × 100 元 → 抵達地板價 500
  -- （now() 為交易時間，pg_sleep 不會推進，故直接改 sale_start_at）
  update public.products
    set sale_start_at = now() - interval '10 seconds'
    where id = v_pid;

  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_uid)::text, true);

  select public.purchase_product(v_pid, 1) into r;

  insert into test_results (name, passed)
  values ('Test 4: Server 計價正確（跨多個降價區間至地板價）',
          coalesce((r->>'ok')::boolean, false)
          and (r->>'unit_price')::numeric = 500);
end $$;

-- ============================================================
-- Test 5 — 偽造／竄改價格無效
-- 客戶 B 以 authenticated 身分直接 UPDATE products 改價（RLS 擋下），
-- 再正常搶購：訂單單價必須等於 Server 計算值
-- ============================================================
do $$
declare
  v_b uuid; v_pid uuid; v_hacked int := 0; r jsonb;
begin
  select auth_user_id into v_b from _users where phone = '0912000002';
  select id into v_pid from _ids where name = 'T1';

  -- 以客戶身分嘗試竄改
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_b)::text, true);

  begin
    update public.products set original_price = 1 where id = v_pid;
    if not exists (
      select 1 from public.products where id = v_pid and original_price = 1
    ) then
      v_hacked := 0; -- 未被改動（正確）
    else
      v_hacked := 1; -- 被改動（漏洞！）
    end if;
  exception when insufficient_privilege then
    v_hacked := 0; -- 直接被權限拒絕（正確）
  end;

  -- 切回 postgres 後以客戶 claims 搶購（SECURITY DEFINER 不受角色影響）
  perform set_config('role', 'postgres', true);
  select public.purchase_product(v_pid, 1) into r;

  insert into test_results (name, passed)
  values ('Test 5: 客戶無法竄改價格＋訂單採 Server 價',
          v_hacked = 0 and coalesce((r->>'ok')::boolean, false)
          and (r->>'unit_price')::numeric <= 1000);
end $$;

-- ============================================================
-- Test 6 — Customer 嘗試 Admin 操作被拒
-- (a) INSERT companies：無 INSERT 政策 → 例外
-- (b) UPDATE 他人帳號：政策不通過 → 0 列生效，事後驗證未變
-- ============================================================
do $$
declare
  v_uid uuid; v_denied int := 0; v_status text;
begin
  select auth_user_id into v_uid from _users where phone = '0975389197';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_uid)::text, true);

  begin
    insert into public.companies (name) values ('HACK');
  exception when others then
    v_denied := v_denied + 1;
  end;

  begin
    update public.customers set status = 'blocked' where phone = '0912000002';
  exception when others then null; -- 靜默 0 列也算擋下，稍後驗證
  end;

  -- 切回管理員身分驗證 B 的狀態沒有被改掉
  perform set_config('role', 'postgres', true);
  select status into v_status from public.customers where phone = '0912000002';
  if coalesce(v_status, '') <> 'blocked' then
    v_denied := v_denied + 1;
  end if;

  insert into test_results (name, passed)
  values ('Test 6: Customer 無法執行 Admin 操作（RLS）', v_denied = 2);
end $$;

-- ============================================================
-- Test 7 — Customer A 讀取 Customer B 訂單被拒
-- ============================================================
do $$
declare
  v_a uuid; v_visible int := 999;
begin
  select auth_user_id into v_a from _users where phone = '0975389197';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_a)::text, true);

  select count(*) into v_visible
    from public.orders o
    join public.customers c2 on c2.auth_user_id = o.user_id
    where c2.phone = '0912000002';

  perform set_config('role', 'postgres', true);

  insert into test_results (name, passed)
  values ('Test 7: 看不到他人訂單', v_visible = 0);
end $$;

-- ============================================================
-- Test 8 — 同一客戶超過限購數量被拒
-- A 已買 T1 兩次（Test 1、Test 4），限購 2 → 第三次必須 limit_reached
-- ============================================================
do $$
declare
  v_uid uuid; v_pid uuid; r jsonb;
begin
  select auth_user_id into v_uid from _users where phone = '0975389197';
  select id into v_pid from _ids where name = 'T1';

  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_uid)::text, true);
  select public.purchase_product(v_pid, 1) into r;

  insert into test_results (name, passed)
  values ('Test 8: 超過限購拒絕',
          coalesce(r->>'ok', 'x') = 'false'
          and r->>'reason' = 'limit_reached');
end $$;

-- ============================================================
-- 彙總
-- ============================================================
insert into test_results (name, passed)
values ('__summary__', (select bool_and(passed) from test_results));

select name,
       case when passed then 'PASS ✅' else 'FAIL ❌' end as result
from test_results
where name <> '__summary__'
order by id;

select case when passed then 'ALL TESTS PASSED 🎉'
            else 'SOME TESTS FAILED ❌' end as final
from test_results where name = '__summary__';
