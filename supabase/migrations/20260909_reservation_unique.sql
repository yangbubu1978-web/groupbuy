-- Phase 0 / 交易一致性：同一使用者同一商品只能有一筆 active reservation
-- 先清理不應存在的重複資料前，保留最早建立的那筆；其餘標記 released，不回補庫存，
-- 避免把已被重複扣除的庫存重複加回。部署前應人工核對被標記的資料。
WITH duplicated AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, product_id
           ORDER BY reserved_at, id
         ) AS rn
    FROM public.cart_reservations
   WHERE status = 'active'
)
UPDATE public.cart_reservations r
   SET status = 'released',
       released_at = now()
  FROM duplicated d
 WHERE r.id = d.id
   AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_res_active_user_product
  ON public.cart_reservations(user_id, product_id)
  WHERE status = 'active';

-- reserve_product 的資料列鎖與唯一索引共同防止並發重複 Reservation。
-- 交易函式本身仍應在持有 product row lock 後再次檢查 active reservation。
