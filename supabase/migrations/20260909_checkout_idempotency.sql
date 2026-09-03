-- Phase 0 / Checkout Idempotency
-- 同一 Reservation 重試時回傳原訂單，不再只回 reservation_inactive。

ALTER TABLE public.cart_reservations
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_res_order_id
  ON public.cart_reservations(order_id)
  WHERE order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.checkout_reservation(p_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_user_id  uuid := auth.uid();
  v_res      public.cart_reservations%rowtype;
  v_product  public.products%rowtype;
  v_campaign public.campaigns%rowtype;
  v_customer public.customers%rowtype;
  v_order    public.orders%rowtype;
  v_order_no text;
  v_order_id uuid;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select * into v_res
    from public.cart_reservations
   where id = p_reservation_id
   for update;
  if not found or v_res.user_id <> v_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  end if;

  -- Retry-safe：第一次已成功時，回傳同一筆訂單結果。
  if v_res.status = 'checked_out' and v_res.order_id is not null then
    select * into v_order from public.orders where id = v_res.order_id;
    if found then
      return jsonb_build_object(
        'ok', true,
        'idempotent_replay', true,
        'order_no', v_order.order_no,
        'unit_price', v_order.unit_price,
        'quantity', v_order.quantity,
        'total_amount', v_order.total_amount
      );
    end if;
  end if;

  if v_res.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'reservation_inactive');
  end if;
  if now() > v_res.expires_at then
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'reservation_expired');
  end if;

  select * into v_product
    from public.products
   where id = v_res.product_id
   for update;
  if not found then
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'product_not_found');
  end if;

  select * into v_campaign
    from public.campaigns
   where id = v_product.campaign_id
   for share;
  if not found or v_campaign.status <> 'active' or now() > v_campaign.end_at
     or v_product.status <> 'active' then
    perform public.release_reservation(p_reservation_id);
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  select * into v_customer
    from public.customers
   where auth_user_id = v_user_id
   for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_whitelisted');
  end if;
  if v_customer.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'account_' || v_customer.status::text);
  end if;

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

  update public.cart_reservations
     set status = 'checked_out', order_id = v_order_id
   where id = p_reservation_id;

  update public.products
     set last_order_at = now()
   where id = v_res.product_id;

  perform public.mark_soldout_ended();

  return jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
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
$$;

REVOKE ALL ON FUNCTION public.checkout_reservation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.checkout_reservation(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.checkout_reservation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_reservation(uuid) TO service_role;
