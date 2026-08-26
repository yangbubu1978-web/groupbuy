-- ============================================================
-- 遷移 20260906_d：購物車預訂制＋真實觸底下架＋強制下架時間
-- （A/B/D 三合一，雅布大人 2026-08-26 拍板）
--
-- A. 幽靈商品阻絕：對「已到底+滿一輪無人下單」的商品建立預訂時，
--    立即標記 ended（前台消失）；結帳成功→落袋，失敗→復活回架
-- B. 購物車＝庫存預訂制：放入購物車即原子扣庫存並鎖定當下價格，
--    3 分鐘內結帳用鎖定價開單；逾期/放棄→庫存回補、價格曲線不重置
-- D. forced_delist_at 強制下架時間：到期由 cron 自動下架；
--    未來時間＝前台顯示「即將結束」標章
-- 觸底錨點修正：product_is_settled 改用決定論累加迴圈算「真實觸底步數」
-- 冪等：create or replace / if not exists / drop policy if exists
-- ============================================================

-- ---------- B-1：購物車預訂表 ----------
create table if not exists public.cart_reservations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id),
  product_id  uuid not null references public.products(id) on delete cascade,
  quantity    int  not null check (quantity >= 1),
  locked_unit_price numeric(12,2) not null,
  reserved_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  status      text not null default 'active'
              check (status in ('active','checked_out','released','expired')),
  restocked   boolean not null default false,
  released_at timestamptz
);
create index if not exists idx_cart_res_user   on public.cart_reservations(user_id);
create index if not exists idx_cart_res_product on public.cart_reservations(product_id);
create index if not exists idx_cart_res_active  on public.cart_reservations(status, expires_at);

alter table public.cart_reservations enable row level security;

drop policy if exists cart_res_own on public.cart_reservations;
create policy cart_res_own on public.cart_reservations
  for select to authenticated using (user_id = auth.uid());

-- ---------- D-1：強制下架時間欄位 ----------
alter table public.products
  add column if not exists forced_delist_at timestamptz;

-- ---------- B-2：放入購物車（原子預訂）----------
create or replace function public.reserve_product(
  p_product_id uuid,
  p_quantity   int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id    uuid := auth.uid();
  v_product    public.products%rowtype;
  v_campaign   public.campaigns%rowtype;
  v_now        timestamptz := now();
  v_price      numeric(12,2);
  v_updated    int;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_quantity < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quantity');
  end if;

  -- 同商品同時只能有一筆有效預訂（重複按＝刷新期限）
  delete from public.cart_reservations
   where user_id = v_user_id
     and product_id = p_product_id
     and status = 'active';

  select * into v_product from public.products
    where id = p_product_id for update;
  if not found or v_product.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'product_paused');
  end if;

  select * into v_campaign from public.campaigns
    where id = v_product.campaign_id for share;
  if not found or v_campaign.status <> 'active'
     or v_now < v_campaign.start_at or v_now > v_campaign.end_at then
    return jsonb_build_object('ok', false, 'reason', 'campaign_not_active');
  end if;

  -- A：幽靈商品阻絕——已到底+滿一輪 → 立即下架收檔，拒絕預訂
  if public.product_is_settled(v_product) then
    update public.products set status = 'ended'
      where id = v_product.id and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'offer_ended');
  end if;

  -- 每人限購檢查（含預訂中的數量）
  select coalesce(sum(quantity),0) into v_updated from (
    select quantity from public.orders
     where user_id = v_user_id and product_id = p_product_id
       and status <> 'cancelled'
    union all
    select quantity from public.cart_reservations
     where user_id = v_user_id and product_id = p_product_id
       and status = 'active'
  ) t;
  if v_updated + p_quantity > v_product.max_per_customer then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached',
      'limit', v_product.max_per_customer, 'purchased', v_updated);
  end if;

  -- 原子扣庫存
  update public.products set stock = stock - p_quantity
   where id = p_product_id and stock >= p_quantity;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'reason', 'sold_out');
  end if;

  -- 鎖定當下價格，3 分鐘效期
  v_price := public.compute_current_price(v_product);
  insert into public.cart_reservations
    (user_id, product_id, quantity, locked_unit_price, reserved_at, expires_at, status)
  values
    (v_user_id, p_product_id, p_quantity, v_price, v_now, v_now + interval '1 minute', 'active');

  return jsonb_build_object(
    'ok', true,
    'reservation_id', (select id from public.cart_reservations
                        where user_id = v_user_id and product_id = p_product_id
                          and status = 'active' limit 1),
    'locked_unit_price', v_price,
    'quantity', p_quantity,
    'expires_at', v_now + interval '1 minute'
  );
exception
  when others then
    raise warning 'reserve_product failed: %', sqlerrm;
    return jsonb_build_object('ok', false, 'reason', 'server_error');
end;
$$;

grant execute on function public.reserve_product(uuid, int) to authenticated;

-- ---------- B-3：結帳（用鎖定價開單）----------
create or replace function public.checkout_reservation(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    v_res.locked_unit_price * v_res.quantity, 'pending', now()
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
$$;

grant execute on function public.checkout_reservation(uuid) to authenticated;

-- ---------- B-4：放棄/釋放預訂（回補庫存，價格曲線不重置）----------
create or replace function public.release_reservation(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_res     public.cart_reservations%rowtype;
  v_updated int;
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

  update public.cart_reservations set status = 'released'
   where id = p_reservation_id;

  -- 庫存回補；last_order_at 不動 → 降價曲線與下架倒數照舊
  update public.products set stock = stock + v_res.quantity
   where id = v_res.product_id;
  get diagnostics v_updated = row_count;

  return jsonb_build_object('ok', true, 'restocked', v_updated > 0);
end;
$$;

grant execute on function public.release_reservation(uuid) to authenticated;

-- ---------- A/B：真實觸底錨點的 settled 判定（v3）----------
-- 改用決定論累加迴圈找「真正觸底步數」；有活預訂的商品不判定 settled
-- （避免 cron 在客人 3 分鐘結帳窗口內把商品下架）
create or replace function public.product_is_settled(p public.products)
returns boolean
language plpgsql stable
as $$
declare
  v_start    timestamptz := p.sale_start_at;
  v_interval int := greatest(1, p.price_interval_seconds);
  v_min      numeric(12,2) := least(p.minimum_price, p.original_price);
  v_range    numeric(12,2) := p.original_price - v_min;
  v_lo       int;
  v_hi       int;
  v_acc      numeric(12,2) := 0;
  v_i        int := 0;
  v_max_i    int;
  v_floor_at timestamptz;
  v_anchor   timestamptz;
begin
  if v_start is null then
    return false;
  end if;
  v_lo := greatest(0, round(p.price_decrease)::int);
  v_hi := case
            when p.price_decrease_max is not null then greatest(v_lo, round(p.price_decrease_max)::int)
            else v_lo
          end;
  if v_hi <= 0 or v_range <= 0 then
    return false;
  end if;

  -- 安全上限：最壞情況步數（超過即視同觸底，防呆）
  v_max_i := ceil(v_range / greatest(1, case when v_lo > 0 then v_lo else v_hi end))::int;

  -- 決定論累加：找出真實觸底步數（與 compute_current_price 同一隨機序列）
  while v_i < v_max_i and v_acc < v_range loop
    v_acc := v_acc + public.rand_step(
      p.id::text || '|0|' || v_i::text, v_lo, v_hi);
    v_i := v_i + 1;
  end loop;

  -- 真實觸底時刻 = 開賣 + 觸底步數 × 週期
  v_floor_at := v_start + make_interval(secs => v_i * v_interval);
  -- 歸零錨定 = max(真實觸底時刻, 最後下單/開賣)
  v_anchor := greatest(v_floor_at, coalesce(p.last_order_at, v_start));

  -- 到底價且自「最後下單／抵達底價」起滿整整一輪無人下單 → 應下架
  if extract(epoch from (now() - v_anchor)) < v_interval then
    return false;
  end if;

  -- B：有活預訂 → 不判 settled（客人的 3 分鐘結帳神聖不可侵犯）
  if exists (select 1 from public.cart_reservations r
              where r.product_id = p.id and r.status = 'active') then
    return false;
  end if;

  return true;
end;
$$;

grant execute on function public.product_is_settled(public.products) to anon, authenticated;

-- ---------- 過期清理＋D 強制下架：合併進 cron job ----------
-- 每分鐘：
--   1. 逾期預訂 → expired；緊接著對「剛過期且未回補」的預訂回補庫存並標記 restocked
--      （restocked 標記防止下一輪重複回補）
--   2. settled 商品 → ended（A：幽靈商品下架）
--   3. forced_delist_at 到期 → ended（D：強制下架）
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'auto-delist-settled-products';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'auto-delist-settled-products',
  '* * * * *',
  $job$
  update public.cart_reservations set status = 'expired', released_at = now()
   where status = 'active' and expires_at < now();
  update public.products p set stock = stock + r.quantity
   from public.cart_reservations r
   where r.product_id = p.id and r.status = 'expired'
     and r.restocked = false;
  update public.cart_reservations set restocked = true
   where status = 'expired' and restocked = false;
  update public.products set status = 'ended'
   where status = 'active' and public.product_is_settled(products);
  update public.products set status = 'ended'
   where status in ('active','paused') and forced_delist_at is not null
     and forced_delist_at <= now();
  $job$
);
