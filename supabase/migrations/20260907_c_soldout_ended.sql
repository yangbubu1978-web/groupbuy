-- ============================================================
-- P31e 售罄即下架：結帳後庫存歸零的商品自動下架，不再前台展示「已完售」
-- ============================================================
create or replace function public.mark_soldout_ended()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update public.products set status = 'ended'
   where status = 'active' and stock <= 0;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
-- checkout_reservation 已 patch：成功結帳後 perform mark_soldout_ended()
