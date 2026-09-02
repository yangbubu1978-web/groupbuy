-- 20260909 修復：product_follows 缺少 UPDATE 政策導致降價勾勾無法儲存
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_follows' and policyname='follows_update') then
    create policy follows_update on public.product_follows
      for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;
