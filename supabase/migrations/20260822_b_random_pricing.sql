-- ============================================================
-- 遷移 20260822_b v2：12 小時隨機降價＋到底價重來（修正輪次邊界）
-- 規則：
--   1. 每 price_interval_seconds 秒降價一次
--   2. 每次降幅 = rand(price_decrease ～ price_decrease_max) 整數元
--   3. 到底價後該輪結束，下一個週期從原價重新開始（庫存還有就一直循環）
--   4. 隨機為確定性偽隨機（sha256 雜湊），Server＝前端同公式，人人同價
-- 時間軸語義：
--   第 k 個週期（k = floor(elapsed/interval)）顯示「已完成 k 次降價」的價格
--   第 r 輪包含降價次數 k = r*S+1 … (r+1)*S，其中 S = 一輪最大步數
-- ------------------------------------------------------------
-- （欄位已於 v1 建立，此處冪等重跑）
alter table public.products
  add column if not exists price_decrease_max numeric(12,2),
  add column if not exists pricing_seed bigint not null default 0;

create or replace function public.rand_step(
  p_key text,
  p_min int,
  p_max int
) returns int
language sql stable
as $$
  select p_min + (
    ('x' || left(encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), 8))::bit(32)::bigint
    % greatest(1, p_max - p_min + 1)
  )::int;
$$;

create or replace function public.compute_current_price(p public.products)
returns numeric
language plpgsql stable
as $$
declare
  v_start     timestamptz := p.sale_start_at;
  v_elapsed   double precision;
  v_interval  int := greatest(1, p.price_interval_seconds);
  v_min       numeric(12,2) := least(p.minimum_price, p.original_price);
  v_range     numeric(12,2);
  v_lo        int;
  v_hi        int;
  v_s         int;          -- 一輪的降價次數上限
  v_k         int;          -- 已完成的降價次數
  v_round     int;
  v_m         int;          -- 本輪要套用的降幅次數
  v_acc       numeric(12,2);
  v_i         int;
begin
  -- 未設定開始時間＝尚未開始特價 → 原價
  if v_start is null then
    return p.original_price;
  end if;

  v_lo := greatest(0, round(p.price_decrease)::int);
  v_hi := case
            when p.price_decrease_max is not null then greatest(v_lo, round(p.price_decrease_max)::int)
            else v_lo
          end;
  v_range := p.original_price - v_min;

  -- 不會降價的設定 → 恆為原價
  if v_hi <= 0 or v_range <= 0 then
    return p.original_price;
  end if;

  v_elapsed := greatest(0, extract(epoch from (now() - v_start)));
  v_k := floor(v_elapsed / v_interval)::int;
  if v_k < 1 then
    return p.original_price;   -- 第一個週期還沒走完
  end if;

  -- 一輪步數：以「最小可能降幅」估保證到底價的步數（lo=0 時退用 hi）
  v_s := ceil(v_range / greatest(1, case when v_lo > 0 then v_lo else v_hi end))::int;

  v_round := (v_k - 1) / v_s;        -- 第幾輪（0 起）
  v_m     := v_k - v_round * v_s;    -- 本輪已套用的降幅次數（1..v_s）

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
$$;

-- 回填：sale_start_at 空的補現在；未設上限的補成固定降幅
update public.products set sale_start_at = now() where sale_start_at is null;
update public.products set price_decrease_max = price_decrease where price_decrease_max is null;
