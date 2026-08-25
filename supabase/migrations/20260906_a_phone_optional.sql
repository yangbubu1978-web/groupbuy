-- ============================================================
-- 遷移 20260906_a：方案 A 手機後補
-- 1. customers.phone 改為可空（允許只填名字建檔）
-- 2. 新增 lookup_login_by_phone(p_phone)：手機登入改走 RPC（雙軌共用）
-- 3. 新增 set_my_phone(p_phone)：讓會員自助補填手機（security definer）
-- 4. 調整 phone 檢查改為允許 NULL
-- ============================================================

-- 1. phone 改可空
alter table public.customers alter column phone drop not null;

-- 2. 調整 check：允許 NULL（若原 constraint 存在先移除）
do $$
begin
  -- 嘗試移除舊的 check（名稱可能為 customers_phone_check）
  begin
    alter table public.customers drop constraint if exists customers_phone_check;
  exception when others then null;
  end;
  begin
    alter table public.customers drop constraint if exists customers_phone_check1;
  exception when others then null;
  end;
end $$;

alter table public.customers
  add constraint customers_phone_check check (phone is null or phone ~ '^09\d{8}$');

-- 3. 手機登入查詢（對應姓名登入的 lookup_login_by_name）
create or replace function public.lookup_login_by_phone(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_phone text;
begin
  v_phone := btrim(p_phone);
  -- 正規化：去分隔符、+886 國碼 → 09XXXXXXXX
  v_phone := regexp_replace(v_phone, '[\s-]', '', 'g');
  if v_phone like '+886%' then
    v_phone := '0' || substr(v_phone, 5);
  elsif v_phone like '886%' and length(v_phone) >= 11 then
    v_phone := '0' || substr(v_phone, 4);
  end if;

  if v_phone is null or v_phone = '' or v_phone !~ '^09\d{8}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  select u.email into v_email
  from public.customers c
  join auth.users u on u.id = c.auth_user_id
  where c.phone = v_phone
    and c.status = 'active'
    and c.auth_user_id is not null
  limit 1;

  if v_email is null then
    return jsonb_build_object('ok', false, 'reason', 'phone_not_found');
  end if;

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

grant execute on function public.lookup_login_by_phone(text) to anon, authenticated;

-- 4. 會員自助補填手機（security definer 繞過 RLS）
create or replace function public.set_my_phone(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_phone text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  v_phone := btrim(p_phone);
  v_phone := regexp_replace(v_phone, '[\s-]', '', 'g');
  if v_phone like '+886%' then
    v_phone := '0' || substr(v_phone, 5);
  elsif v_phone like '886%' and length(v_phone) >= 11 then
    v_phone := '0' || substr(v_phone, 4);
  end if;

  if v_phone !~ '^09\d{8}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  -- 檢查是否已被他人使用
  if exists (select 1 from public.customers c where c.phone = v_phone and c.auth_user_id <> v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'phone_exists');
  end if;

  update public.customers
     set phone = v_phone
   where auth_user_id = v_uid;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object('ok', true, 'phone', v_phone);
end;
$$;

grant execute on function public.set_my_phone(text) to authenticated;

-- 5. 確保 name 唯一索引存在（已在 20260904_name_login 建立，此處補防呆）
create unique index if not exists uniq_customers_name on public.customers (name);
