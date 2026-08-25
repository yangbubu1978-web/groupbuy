-- ============================================================
-- 遷移 20260906_b：健檢修復包（P0–P4，2026-08-25 小布健檢發現）
--
-- P0 補 enum：product_status 一直缺 'ended'！g/h migration 的自動下架
--    一執行就會炸 invalid input value，被 exception 吃掉變 server_error。
--    （本機 repo schema 有但線上沒有？否——是 init_schema 就沒建，
--      所有環境都缺；演練時發現）
--    ⚠️ ALTER TYPE 必須單獨一個交易執行（新值不能在同交易內使用），
--       部署時此段要獨立送出。
-- P1 自動下架改「主動」：原設計為惰性觸發（要有人按購買失敗才標 ended），
--    改由 pg_cron 每分鐘掃描到底價且滿一輪無人下單的商品 → status='ended'
--    （前台列表只顯示 active，此後不會再出現幽靈商品）
-- P2 cancel_own_order 加 FOR UPDATE：防雙擊取消重複回補庫存
-- P3 admin_transition_order 的 cancelled_by 固定 'admin'（原會被取消原因污染）
-- P4 purchase_product exception 不再回傳 sqlerrm 內部細節（資訊洩漏）
-- ＋ 訂單取消／退款後回收 last_order_at：
--    已取消/已退款訂單不再把「下架倒數」歸零（重算＝最後一筆有效訂單時間）
--
-- 冪等：create or replace / if not exists / 先 unschedule 再 schedule
-- ============================================================

-- ---------- P0：補 product_status enum 缺值 ----------
alter type public.product_status add value if not exists 'ended' after 'paused';

-- ---------- P1：pg_cron 每分鐘自動下架 ----------
create extension if not exists pg_cron;

do $$
declare
  v_jobid bigint;
begin
  -- 重複執行安全：先移除同名舊 job
  select jobid into v_jobid from cron.job where jobname = 'auto-delist-settled-products';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'auto-delist-settled-products',
  '* * * * *',
  $job$update public.products set status = 'ended'
   where status = 'active'
     and public.product_is_settled(products)$job$
);

-- ---------- P2：cancel_own_order v3（FOR UPDATE 防競態＋last_order_at 回收）----------
create or replace function public.cancel_own_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid := auth.uid();
  v_order    public.orders%rowtype;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  -- P2：列鎖。雙擊時第二個交易會等鎖、拿到後讀到已取消狀態而失敗
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id <> v_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_not_owner');
  end if;

  -- 只有「待確認」「已確認」可自行取消（已付款請走退款流程）
  if v_order.status not in ('pending', 'confirmed') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;

  update public.orders set
    status = 'cancelled',
    cancelled_by = 'member',
    cancel_reason = coalesce(cancel_reason, 'member_cancelled'),
    updated_at = now()
  where id = p_order_id;

  -- 庫存回補（原子）
  if v_order.product_id is not null then
    update public.products
       set stock = stock + v_order.quantity
     where id = v_order.product_id;

    -- 已取消訂單不再歸零下架倒數：last_order_at 重算為最後一筆有效訂單
    update public.products p
       set last_order_at = (
         select max(o.purchased_at)
           from public.orders o
          where o.product_id = p.id
            and o.status not in ('cancelled', 'refunded')
       )
     where p.id = v_order.product_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- P2/P3：admin_transition_order v3 ----------
create or replace function public.admin_transition_order(
  p_order_id uuid,
  p_next     text,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
begin
  -- P2 同款：狀態轉移加列鎖，防管理員介面連點競態
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- 合法狀態機（電商標準）
  if not (
       (v_order.status = 'pending'   and p_next in ('confirmed','cancelled'))
    or (v_order.status = 'confirmed' and p_next in ('paid','cancelled'))
    or (v_order.status = 'paid'      and p_next in ('shipped','refunding'))
    or (v_order.status = 'shipped'   and p_next in ('completed','refunding'))
    or (v_order.status = 'completed' and p_next in ('refunding'))
    or (v_order.status = 'refunding' and p_next in ('refunded','shipped'))  -- 退款被拒→回到出貨態
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition',
                              'from', v_order.status, 'to', p_next);
  end if;

  case
    when p_next = 'cancelled' then
      update public.orders set
        status = 'cancelled',
        cancelled_by = 'admin',                      -- P3：固定語義，原因只進 cancel_reason
        cancel_reason = nullif(p_reason, ''),
        updated_at = now()
      where id = p_order_id;
      -- 未出貨取消 → 回補庫存
      if v_order.product_id is not null and v_order.status in ('pending','confirmed') then
        update public.products set stock = stock + v_order.quantity where id = v_order.product_id;
        -- 取消訂單不歸零下架倒數
        update public.products p
           set last_order_at = (
             select max(o.purchased_at)
               from public.orders o
              where o.product_id = p.id
                and o.status not in ('cancelled', 'refunded')
           )
         where p.id = v_order.product_id;
      end if;
    when p_next = 'refunded' then
      update public.orders set
        status = 'refunded',
        cancel_reason = coalesce(p_reason, cancel_reason),
        updated_at = now()
      where id = p_order_id;
      -- 退款成立 → 回補庫存
      if v_order.product_id is not null then
        update public.products set stock = stock + v_order.quantity where id = v_order.product_id;
        -- 退款訂單同樣不算有效銷售：回收下架倒數歸零
        update public.products p
           set last_order_at = (
             select max(o.purchased_at)
               from public.orders o
              where o.product_id = p.id
                and o.status not in ('cancelled', 'refunded')
           )
         where p.id = v_order.product_id;
      end if;
    else
      update public.orders set
        status = p_next::public.order_status,
        cancel_reason = coalesce(p_reason, cancel_reason),
        updated_at = now()
      where id = p_order_id;
  end case;

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- P4：purchase_product v4（exception 不洩漏內部細節）----------
create or replace function public.purchase_product(
  p_product_id uuid,
  p_quantity   int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id       uuid := auth.uid();
  v_customer      public.customers%rowtype;
  v_product       public.products%rowtype;
  v_campaign      public.campaigns%rowtype;
  v_now           timestamptz := now();
  v_unit_price    numeric(12,2);
  v_order_no      text;
  v_order_id      uuid;
  v_already       int;
  v_updated       int;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  select * into v_customer from public.customers
    where auth_user_id = v_user_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_whitelisted');
  end if;
  if v_customer.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'account_' || v_customer.status::text);
  end if;

  select * into v_product from public.products
    where id = p_product_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'product_not_found');
  end if;
  if v_product.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'product_paused');
  end if;

  select * into v_campaign from public.campaigns
    where id = v_product.campaign_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_found');
  end if;
  if v_campaign.status <> 'active' or v_now < v_campaign.start_at or v_now > v_campaign.end_at then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_active');
  end if;

  if exists (select 1 from public.campaign_companies cc where cc.campaign_id = v_campaign.id)
     and not exists (
       select 1 from public.campaign_companies cc
       where cc.campaign_id = v_campaign.id and cc.company_id = v_customer.company_id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if exists (select 1 from public.campaign_groups cg where cg.campaign_id = v_campaign.id)
     and not exists (
       select 1 from public.campaign_groups cg
       where cg.campaign_id = v_campaign.id and cg.group_id = v_customer.group_id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if exists (select 1 from public.campaign_customers cx where cx.campaign_id = v_campaign.id)
     and not exists (
       select 1 from public.campaign_customers cx
       where cx.campaign_id = v_campaign.id and cx.customer_id = v_customer.id
     ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  v_unit_price := public.compute_current_price(v_product);

  select coalesce(sum(quantity), 0) into v_already
    from public.orders
    where user_id = v_user_id
      and product_id = p_product_id
      and status <> 'cancelled';
  if v_already + p_quantity > v_product.max_per_customer then
    return jsonb_build_object(
      'ok', false, 'reason', 'limit_reached',
      'limit', v_product.max_per_customer,
      'purchased', v_already
    );
  end if;

  if p_quantity < 1 or p_quantity > v_product.max_per_customer then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- 已到底價且整整一輪（自上次下單起）無人下單 → 自動下架收檔
  if public.product_is_settled(v_product) then
    update public.products set status = 'ended'
      where id = v_product.id and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  update public.products
    set stock = stock - p_quantity
    where id = p_product_id
      and stock >= p_quantity;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'reason', 'sold_out');
  end if;

  v_order_no := 'ORDER-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.orders (
    order_no, user_id, customer_id, product_id, campaign_id,
    product_name_snapshot, sku_snapshot,
    unit_price, quantity, total_amount, status, purchased_at
  ) values (
    v_order_no, v_user_id, v_customer.id, p_product_id, v_campaign.id,
    v_product.name, v_product.sku,
    v_unit_price, p_quantity, v_unit_price * p_quantity,
    'pending', v_now
  ) returning id into v_order_id;

  insert into public.order_items (
    order_id, product_id, product_name_snapshot, sku_snapshot,
    unit_price, quantity, subtotal
  ) values (
    v_order_id, p_product_id, v_product.name, v_product.sku,
    v_unit_price, p_quantity, v_unit_price * p_quantity
  );

  -- 歸零計時：成功下單 → 寫下最後下單時間（重置下架倒數）
  update public.products
    set last_order_at = v_now
    where id = p_product_id;

  return jsonb_build_object(
    'ok', true,
    'order_no', v_order_no,
    'unit_price', v_unit_price,
    'quantity', p_quantity,
    'total_amount', v_unit_price * p_quantity,
    'remaining_stock', v_product.stock - p_quantity
  );
exception
  when others then
    -- P4：內部錯誤細節只進 log，不回傳給客戶端
    raise warning 'purchase_product failed: %', sqlerrm;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
end;
$$;
