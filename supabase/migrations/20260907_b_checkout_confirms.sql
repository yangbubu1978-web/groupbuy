-- ============================================================
-- P31 結帳即確認（雅布拍板）：放入購物車 → 結帳(=確認) → 付款 → 完成
-- ============================================================
-- 以線上 checkout_reservation 本體為基礎，僅改開單狀態：'pending' → 'confirmed'
-- （客人主動結帳＝明確購買意圖，不需再回訂單頁手動確認）
-- expire_stale_pending_orders cron 保留作防禦縱深。

CREATE OR REPLACE FUNCTION public.checkout_reservation(p_reservation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id  uuid := auth.uid();
  v_res      public.cart_reservations%rowtype;
  v_product  public.products%rowtype;
  v_campaign public.campaigns%rowtype;
  v_customer public.customers%rowtype;
  v_order_no text;
  v_order_id uuid;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select * into v_res from public.cart_reservations
   where id = p_reservation_id for update;
  if not found or v_res.user_id <> v_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  end if;
  if v_res.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'reservation_inactive');
  end if;
  if now() > v_res.expires_at then
    -- 逾期：釋放庫存並標記過期
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'reservation_expired');
  end if;

  select * into v_product from public.products
   where id = v_res.product_id for update;
  select * into v_campaign from public.campaigns
   where id = v_product.campaign_id for share;

  -- 活動/商品狀態複查（預訂期間可能被管理員暫停）
  if v_campaign.status <> 'active' or v_product.status <> 'active'
     or now() > v_campaign.end_at then
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  select * into v_customer from public.customers
   where auth_user_id = v_user_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_whitelisted');
  end if;
  if v_customer.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'account_' || v_customer.status::text);
  end if;

  -- 授權範圍複查（同 purchase_product 邏輯）
  if exists (select 1 from public.campaign_companies cc where cc.campaign_id = v_campaign.id)
     and not exists (select 1 from public.campaign_companies cc
       where cc.campaign_id = v_campaign.id and cc.company_id = v_customer.company_id) then
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if exists (select 1 from public.campaign_groups cg where cg.campaign_id = v_campaign.id)
     and not exists (select 1 from public.campaign_groups cg
       where cg.campaign_id = v_campaign.id and cg.group_id = v_customer.group_id) then
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if exists (select 1 from public.campaign_customers cx where cx.campaign_id = v_campaign.id)
     and not exists (select 1 from public.campaign_customers cx
       where cx.campaign_id = v_campaign.id and cx.customer_id = v_customer.id) then
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  -- 用鎖定價開單（不再重算價格——這就是「放入購物車當下的價格」）
  v_order_no := 'ORDER-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.orders (
    order_no, user_id, customer_id, product_id, campaign_id,
    product_name_snapshot, sku_snapshot,
    unit_price, quantity, total_amount, status, purchased_at
  ) values (
    v_order_no, v_user_id, v_customer.id, v_res.product_id, v_campaign.id,
    v_product.name, v_product.sku,
    v_res.locked_unit_price, v_res.quantity,
    v_res.locked_unit_price * v_res.quantity, 'confirmed', now()
  ) returning id into v_order_id;

  insert into public.order_items (
    order_id, product_id, product_name_snapshot, sku_snapshot,
    unit_price, quantity, subtotal
  ) values (
    v_order_id, v_res.product_id, v_product.name, v_product.sku,
    v_res.locked_unit_price, v_res.quantity,
    v_res.locked_unit_price * v_res.quantity
  );

  update public.cart_reservations set status = 'checked_out'
   where id = p_reservation_id;

  -- 歸零計時：成功下單 → 寫下最後下單時間（重置下架倒數）
  update public.products set last_order_at = now()
   where id = v_res.product_id;

  return jsonb_build_object(
    'ok', true,
    'order_no', v_order_no,
    'unit_price', v_res.locked_unit_price,
    'quantity', v_res.quantity,
    'total_amount', v_res.locked_unit_price * v_res.quantity
  );
exception
  when others then
    raise warning 'checkout_reservation failed: %', sqlerrm;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
end;
$function$
