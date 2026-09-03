-- Phase 1 / 統一購買入口
-- purchase_product 保留相容名稱，但不再維護第二套交易規則。
-- 所有直接購買請求統一走：reserve_product → checkout_reservation。

CREATE OR REPLACE FUNCTION public.purchase_product(
  p_product_id uuid,
  p_quantity integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_reservation jsonb;
  v_checkout    jsonb;
  v_reservation_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_quantity < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- 唯一 authoritative path：價格、庫存、限購與 Reservation 全部共用同一套規則。
  v_reservation := public.reserve_product(p_product_id, p_quantity);

  -- 重按時回傳既有 Reservation 不代表可直接建立另一筆訂單。
  -- 已有 Reservation 的直接購買請求必須提示使用者走既有 checkout，避免重複訂單。
  if coalesce((v_reservation->>'ok')::boolean, false) = false then
    return v_reservation;
  end if;

  v_reservation_id := (v_reservation->>'reservation_id')::uuid;
  v_checkout := public.checkout_reservation(v_reservation_id);

  -- checkout 失敗時，釋放本次剛建立的 Reservation，避免錯誤回應留下孤兒鎖定。
  if coalesce((v_checkout->>'ok')::boolean, false) = false then
    perform public.release_reservation(v_reservation_id);
  end if;

  return v_checkout;
exception
  when others then
    raise warning 'purchase_product unified path failed: %', sqlerrm;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
end;
$$;

-- 直接購買仍是相容 RPC，但必須只允許已驗證會員；匿名不可呼叫。
REVOKE ALL ON FUNCTION public.purchase_product(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purchase_product(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.purchase_product(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_product(uuid, integer) TO service_role;
