-- ============================================================
-- 遷移 20260922：降價機制改造 —「設定總降價時間，自動計算降價價格」
-- （雅布大人 2026-09-15 拍板；舊的隨機步長模式完整保留）
--
-- 模式判別：public.products.drop_total_seconds
--   IS NULL      → 舊隨機步長模式（線上既有商品行為完全不變）
--   IS NOT NULL  → 新模式（值＝降價總時間，秒）
--
-- 新模式公式（與前端 app/src/lib/pricing.ts 的 dropScheduleSummary 逐行對齊）：
--   總降價金額 = 起始價格 − 最低價格（底價）
--   變價次數 N = floor(降價總時間 ÷ 降價間隔)   ← 除不盡取 floor
--   每步降幅   = floor(總降價金額 ÷ N)          ← 價格一律整數元
--   第 k 步價格 = max(底價, 起始價 − k × 每步降幅)；k ≥ N 之後固定為底價
--   最後一步吸收餘數 → 最終價格精確等於底價、絕不低於底價
--   真實觸底時刻 = sale_start_at + N × 降價間隔
--   （2026-09-15 雅布拍板：維持「次數不變、最後一步吸收餘數」的單一規則；
--     曾短暫實作的「自動調整次數讓每步整除」已於同日移除）
--
-- ⚠️ 本檔的兩支函式本體取自線上 DB 的 pg_get_functiondef（線上版本比 repo 舊 migration 新：
--    含「只降一輪」與 cart_reservations 守衛），僅在其中插入新模式分支，
--    其餘逐字保留——請勿用 repo 舊版覆蓋線上。
-- 冪等：add column if not exists / create or replace function
-- ============================================================

-- 1) 新模式欄位：降價總時間（秒）；NULL＝沿用舊隨機步長模式
alter table public.products
  add column if not exists drop_total_seconds integer;

comment on column public.products.drop_total_seconds is
  '降價總時間（秒）。NULL＝舊隨機步長模式；非 NULL＝新模式：變價次數 N=floor(drop_total_seconds/price_interval_seconds)、每步降幅=floor((original_price-minimum_price)/N)、最後一步吸收餘數精確到底價';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_drop_total_seconds_check'
  ) then
    alter table public.products
      add constraint products_drop_total_seconds_check
      check (drop_total_seconds is null or drop_total_seconds >= 1);
  end if;
end $$;
-- 2) 降價引擎：新模式分流（價格只降不漲、單程到底，兩模式共用）
create or replace function public.compute_current_price(p products)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_start     timestamptz := p.sale_start_at;
  v_elapsed   double precision;
  v_interval  int := greatest(1, p.price_interval_seconds);
  v_min       numeric(12,2) := least(p.minimum_price, p.original_price);
  v_range     numeric(12,2);
  v_lo        int;
  v_hi        int;
  v_s         int;
  v_k         int;
  v_round     int := 0;
  v_m         int;
  v_acc       numeric(12,2);
  v_i         int;
  -- 新模式用
  v_orig_i    int;
  v_min_i     int;
  v_range_i   int;
  v_n         int;
  v_step      int;
begin
  if v_start is null then
    return p.original_price;
  end if;

  v_elapsed := greatest(0, extract(epoch from (now() - v_start)));

  -- ── 新模式：管理員只設定「起始價、底價、降價總時間、降價間隔」，其餘系統算 ──
  if p.drop_total_seconds is not null then
    v_orig_i  := round(p.original_price)::int;
    v_min_i   := least(round(p.minimum_price)::int, v_orig_i);
    v_range_i := v_orig_i - v_min_i;
    if v_range_i <= 0 then
      return p.original_price;         -- 沒有價差 → 恆為起始價
    end if;
    v_n := p.drop_total_seconds / v_interval;   -- 整數除法＝floor(總時間 ÷ 間隔)
    if v_n < 1 then
      return p.original_price;         -- 總時間不足一個間隔 → 不降價
    end if;
    v_k := floor(v_elapsed / v_interval)::int;
    if v_k < 1 then
      return p.original_price;         -- 第一個週期還沒走完
    end if;
    if v_k >= v_n then
      return v_min_i::numeric;         -- 最後一步吸收餘數：精確等於底價，絕不低於底價
    end if;
    v_step := v_range_i / v_n;         -- 整數除法＝floor(總降價金額 ÷ 變價次數)
    return (v_orig_i - v_k * v_step)::numeric;
  end if;

  -- ── 舊隨機步長模式（逐字保留）──
  v_lo := greatest(0, round(p.price_decrease)::int);
  v_hi := case
            when p.price_decrease_max is not null then greatest(v_lo, round(p.price_decrease_max)::int)
            else v_lo
          end;
  v_range := p.original_price - v_min;

  if v_hi <= 0 or v_range <= 0 then
    return p.original_price;
  end if;

  v_k := floor(v_elapsed / v_interval)::int;
  if v_k < 1 then
    return p.original_price;
  end if;

  -- 單程：只降第一輪；到底後維持最低價（價格永不回彈）
  v_s := ceil(v_range / greatest(1, case when v_lo > 0 then v_lo else v_hi end))::int;
  v_m := least(v_k, v_s);

  v_acc := 0;
  v_i   := 0;
  while v_i < v_m and v_acc < v_range loop
    v_acc := v_acc + public.rand_step(
      p.id::text || '|' || v_round::text || '|' || v_i::text,
      v_lo,
      v_hi
    );
    v_i := v_i + 1;
  end loop;

  return round(greatest(v_min, p.original_price - v_acc), 2);
end;
$function$;

-- 3) 觸底判定＋自動下架：新模式觸底時刻 = 開賣 + N × 間隔
create or replace function public.product_is_settled(p products)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
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
  -- 新模式用
  v_orig_i   int;
  v_min_i    int;
  v_n        int;
begin
  if v_start is null then
    return false;
  end if;

  -- ── 新模式：觸底時刻 = 開賣 + 變價次數 × 間隔（不需累加迴圈）──
  if p.drop_total_seconds is not null then
    v_orig_i := round(p.original_price)::int;
    v_min_i  := least(round(p.minimum_price)::int, v_orig_i);
    if v_orig_i - v_min_i <= 0 then
      return false;                    -- 沒有價差＝永遠不觸底（與舊模式一致）
    end if;
    v_n := p.drop_total_seconds / v_interval;
    if v_n < 1 then
      return false;                    -- 總時間不足一個間隔＝不會降價
    end if;
    v_floor_at := v_start + make_interval(secs => (v_n * v_interval)::double precision);
  else
    -- ── 舊隨機步長模式（逐字保留）──
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
    v_floor_at := v_start + make_interval(secs => (v_i * v_interval)::double precision);
  end if;

  -- 歸零錨定 = max(真實觸底時刻, 最後下單/開賣)
  v_anchor := greatest(v_floor_at, coalesce(p.last_order_at, v_start));

  -- 到底價且自「最後下單／抵達底價」起滿整整一輪無人下單 → 應下架
  if extract(epoch from (now() - v_anchor)) < v_interval then
    return false;
  end if;

  -- 有活預訂 → 不判 settled（客人的結帳時間神聖不可侵犯）
  if exists (select 1 from public.cart_reservations r
              where r.product_id = p.id and r.status = 'active') then
    return false;
  end if;

  return true;
end;
$function$;

-- 4) 授權
grant execute on function public.product_is_settled(public.products) to anon, authenticated;

-- 5) 清理：曾短暫上線的 drop_schedule_steps（2026-09-15 同日改回單一規則）
drop function if exists public.drop_schedule_steps(int, int);
