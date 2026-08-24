-- ============================================================
-- 遷移 20260824_a：姓名登入
-- 1. lookup_login_by_name(p_name)：由姓名安全查詢對應 auth email
--    （security definer 繞過 RLS；僅回傳內部虛擬 email，非真實 PII）
-- 2. customers.name 唯一索引：防同名導致登入錯亂
-- ============================================================

create or replace function public.lookup_login_by_name(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if p_name is null or btrim(p_name) = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  select u.email into v_email
  from public.customers c
  join auth.users u on u.id = c.auth_user_id
  where c.name = btrim(p_name)
    and c.status = 'active'
    and c.auth_user_id is not null
  limit 1;

  if v_email is null then
    return jsonb_build_object('ok', false, 'reason', 'name_not_found');
  end if;

  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

grant execute on function public.lookup_login_by_name(text) to anon, authenticated;

-- 同名防護（既有資料已確認無同名）
create unique index if not exists uniq_customers_name on public.customers (name);
