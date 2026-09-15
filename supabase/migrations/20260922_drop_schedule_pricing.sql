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
--   變價次數 N：理想 = floor(降價總時間 ÷ 降價間隔)；若總降價金額無法被整除，
--               以 public.drop_schedule_steps() 自動取「最接近的因數」→ 每步金額整除
--               （雅布 2026-09-15 拍板：寧可次數與設定不同，也要每步金額漂亮）
--   每步降幅   = 總降價金額 ÷ N（整除，每步相同）
--   第 k 步價格 = 起始價 − k × 每步降幅；k ≥ N 之後固定為底價
--   真實觸底時刻 = sale_start_at + N × 降價間隔
--   極端情形（價差為質數等，找不到 ≥2 的近似因數）→ 退回理想次數，每步取整、最後一步吸收餘數，
--   仍保證最終價格精確等於底價、絕不低於底價
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

-- 2) 變價次數決策（2026-09-15 雅布拍板）：**自動調整次數，讓每步金額整除**
--    理想次數 = floor(降價總時間 ÷ 降價間隔)
--    可整除 → 直接用；否則取「最接近的因數」（同距離取較小＝不超時，上限 2×理想次數）；
--    極端情形（價差為質數等，最佳因數 < 2）→ 退回理想次數（每步取整、最後一步吸收餘數）。
--    ⚠️ 與前端 app/src/lib/pricing.ts 的 resolveDropSteps() 逐行對齊，改一邊要同步另一邊。
create or replace function public.drop_schedule_steps(p_range int, p_ideal int)
 RETURNS int
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_dl int;
  v_dh int;
  v_i  int;
begin
  if p_ideal < 1 or p_range <= 0 then
    return greatest(1, p_ideal);
  end if;
  if p_range % p_ideal = 0 then
    return p_ideal;
  end if;

  v_dl := 1;                                    -- 往下找：最大因數 ≤ 理想次數
  for v_i in reverse p_ideal..1 loop
    if p_range % v_i = 0 then
      v_dl := v_i;
      exit;
    end if;
  end loop;

  v_dh := 0;                                    -- 往上找：最小因數 > 理想次數
  for v_i in (p_ideal + 1)..least(p_ideal * 2, p_range) loop
    if p_range % v_i = 0 then
      v_dh := v_i;
      exit;
    end if;
  end loop;

  if v_dh = 0 or (p_ideal - v_dl) <= (v_dh - p_ideal) then
    if v_dl < 2 then
      return p_ideal;                           -- 極端情形：維持原次數，最後一步吸收餘數
    end if;
    return v_dl;
  end if;
  return v_dh;
end;
$function$;

-- 3) 降價引擎：新模式分流（價格只降不漲、單程到底，兩模式共用）
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
    v_n := public.drop_schedule_steps(v_range_i, p.drop_total_seconds / v_interval);
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
    v_n := public.drop_schedule_steps(v_orig_i - v_min_i, p.drop_total_seconds / v_interval);
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

grant execute on function public.product_is_settled(public.products) to anon, authenticated;
