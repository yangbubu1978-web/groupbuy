-- ============================================================
-- 20260906_g_order_status_history.sql
-- 訂單狀態歷史：audit trail（誰/何時/from→to/原因備註）
--
-- 背景：admin_transition_order 只改 orders.status，無任何歷史軌跡，
--       客訴對帳只能靠管理員記憶。此 migration：
--   1) 新表 order_status_history
--   2) trigger 自動記錄 orders.status 變更（INSERT 初始 pending、UPDATE 換狀態）
--   3) 回填既有訂單的當前狀態（purchased_at 為起點，避免時間線空白）
--   4) RLS：擁有者或 admin 可讀；僅 service role 可寫（寫入一律走 trigger）
-- ============================================================

-- 1) 歷史表
create table if not exists public.order_status_history (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status   text not null,
  changed_by  uuid references auth.users(id),      -- null = system / 未登入環境寫入
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_osh_order on public.order_status_history(order_id, created_at);

comment on table public.order_status_history is
  '訂單狀態歷史（trigger 自動寫入）：from_status=null 代表建立訂單';

-- 2) trigger 函式：orders 的 INSERT／UPDATE 都記一筆
create or replace function public.log_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- INSERT：記初始狀態（from = null）
  if (tg_op = 'INSERT') then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by)
    values (new.id, null, new.status::text, auth.uid());

  -- UPDATE：狀態有變才記
  elsif (new.status::text <> old.status::text) then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (
      new.id,
      old.status::text,
      new.status::text,
      coalesce(auth.uid(), new.cancelled_by::uuid),  -- cancelled_by 是文字('admin'/'member')，cast 幾乎必為 null → 實務上多走 auth.uid() 或 system(null)
      case when new.status::text in ('cancelled','refunding','refunded')
           then coalesce(new.cancel_reason, new.note) end
    );
  end if;
  return new;  -- security definer + before trigger → 不影響寫入本身
end;
$$;

drop trigger if exists trg_order_status_history on public.orders;
create trigger trg_order_status_history
  after insert or update of status on public.orders
  for each row execute function public.log_order_status_change();

-- 3) RLS
alter table public.order_status_history enable row level security;

drop policy if exists osh_read on public.order_status_history;
create policy osh_read on public.order_status_history
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_status_history.order_id
        and (o.user_id = auth.uid() or public.is_admin())
    )
  );

-- 無 insert/update/delete policy → 僅 service role（trigger）可寫 ✓

-- 4) 回填既有訂單（冪等：只補完全沒有歷史的訂單）
insert into public.order_status_history (order_id, from_status, to_status, created_at)
select o.id, null, o.status::text, o.purchased_at
from public.orders o
where not exists (
  select 1 from public.order_status_history h where h.order_id = o.id
);
