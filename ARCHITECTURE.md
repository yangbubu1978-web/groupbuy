# Phase 1 — Architecture（系統架構與設計理由）

> 對應開發規格第三十條：先分析需求、說明設計理由，再進入實作。
> 本平台定位：**30～100 名特定客戶的封閉式公司團購**，不是大型電商。
> 設計最高原則：公平、準確、不超賣、資料安全 → 再追求漂亮與豐富。

## 1. 系統架構

```
手機 / 桌面瀏覽器（PWA，可加入主畫面）
        │ HTTPS
        ▼
Cloudflare Pages（Free）── React + Vite 靜態檔
        │                        │
        │ supabase-js（REST/Realtime）
        ▼                        ▼
Supabase（Free）
  ├─ Auth          手機→email 映射登入（0912...@phone.groupbuy.local）
  ├─ PostgreSQL    資料、RLS、搶購交易函式、計價函式
  ├─ Edge Functions purchase（下單）/ admin（管理）/ seed（示範帳號）
  ├─ Realtime      products 變更推送（庫存即時更新）
  └─ Storage       商品圖片（選用）
```

### 為什麼不用 VPS / Docker / Redis？
- 規格明確要求免費優先、不自行維運伺服器。
- 30～100 人規模，PostgreSQL 單機交易鎖足以支撐搶購序列化，
  不需要 Redis 分散式鎖（那是十萬級併發的問題）。
- Supabase Free + Cloudflare Pages Free = $0 固定成本。

## 2. Database Schema

```
companies ─┬─< customer_groups ─┐
           │                    ├─< customers >─ auth.users
           └────────────────────┘      │
campaigns ─┬─< campaign_companies      │
           ├─< campaign_groups   （授權範圍三張多對多表）
           ├─< campaign_customers
           └─< products ──< orders >─ auth.users
```

| 表 | 職責 | 關鍵約束 |
|---|---|---|
| companies | 多公司預留 | name unique |
| customer_groups | 客戶群組 | (name, company_id) unique |
| customers | 白名單 | phone unique + `^09\d{8}$` CHECK |
| campaigns | 活動 | end_at > start_at CHECK |
| campaign_companies/groups/customers | 授權範圍 | PK 複合鍵防重複 |
| products | 商品＋降價參數＋庫存 | stock ≤ initial_stock、stock ≥ 0、min ≤ original |
| orders | 快照訂單 | order_no unique |

### 設計理由
- **為什麼訂單做快照欄位而不是 JOIN 取當前價格？**
  規格第十二條：之後商品改價不能影響歷史訂單。快照是唯一可靠做法。
- **為什麼授權範圍用三張接合表而不是一個 JSON 欄位？**
  RLS 的 `EXISTS` 子查詢可以直接走索引；JSON 需全表掃且無法建 FK。
- **為什麼 stock 直接放 products 而不另做 inventory log？**
  MVP 規模不需要進出貨流水；原子 UPDATE 已保證正確性。未來需要時再加 purchase_logs，不影響現有結構。

## 3. Authentication Flow

```
使用者輸入手機+密碼
  → 前端正規化（去 - / 空白、+886→0）成 09XXXXXXXX
  → signInWithPassword(email=phone@phone.groupbuy.local)
  → 成功後查 customers 白名單：
      不存在        → 登出，回「尚未開通」
      status≠active → 登出，回「已停用/封鎖」
      active        → 放行
```

### 設計理由
- 用 email 映射而非 phone 欄位登入：Supabase Auth 原生支援 email+password，
  零 SMS 費用（規格三），且密碼雜湊、session 管理、JWT 全部交給 Auth。
- 白名單檢查放在「登入後立即驗證＋資料庫函式內再次驗證」兩層：
  就算攻擊者繞過前端直接打 API，`purchase_product()` 內部仍會拒絕非 active 客戶。

## 4. API Flow

| 操作 | 管道 | 授權 |
|---|---|---|
| 查活動/商品/自己訂單 | supabase-js（PostgREST） | RLS 自動過濾 |
| 即時價格確認 | RPC `get_current_price` | authenticated |
| 搶購 | Edge Function `purchase` → RPC `purchase_product` | JWT + 函式內白名單驗證 |
| 建帳號/重設密密碼/訂單狀態 | Edge Function `admin` | JWT + admins 表驗證 + service_role |

### 設計理由
- 一般讀取直接走 PostgREST＋RLS：少一層自製 API，少一層出錯可能。
- 寫入（搶購）集中到單一 DB 函式：把「驗證→計價→扣庫存→建單」封裝在
  一個交易內，Edge Function 只負責轉發 JWT，不含任何商業邏輯。
- admin 操作經 service_role：RLS 對管理員不是障礙，但 service_role key
  只存在 Edge Function 環境變數，永不落地前端（規格二十四）。

## 5. Purchase Flow（核心）

```
[立即搶購]
  → POST /functions/v1/purchase { productId, quantity }
  → 驗 JWT → RPC purchase_product()
      BEGIN
        1. auth.uid() 存在？客戶 active？（FOR SHARE 鎖客戶列）
        2. SELECT * FROM products WHERE id=? FOR UPDATE   ← 序列化點
        3. 活動 active 且時間內？
        4. 公司/群組/個人授權通過？
        5. unit_price = compute_current_price(product)     ← Server 計價
        6. 已買數量 + quantity ≤ max_per_customer？
        7. UPDATE products SET stock=stock-N
           WHERE id=? AND stock>=N                         ← 原子扣庫存
           affected=0 → ROLLBACK → {"ok":false,"reason":"sold_out"}
        8. INSERT orders（快照）
      COMMIT
  → 回 { ok, order_no, unit_price, total_amount, remaining_stock }
```

### Inventory Locking Logic — 為什麼這樣不會超賣？
- `FOR UPDATE` 讓同一商品的所有搶購「排隊」，第二個人會等到第一個人 commit。
- 即使拿掉 FOR UPDATE，第 7 步的條件式 UPDATE 本身就是原子的：
  兩筆同時執行時 PostgreSQL 列鎖保證其中一筆看到的是扣完後的值，
  `stock >= N` 不成立 → affected rows = 0 → 失敗。**雙保險。**
- 最後防線：`CHECK (stock >= 0)` 約束，任何邏輯漏洞都會被資料庫本身擋下。

## 6. Price Calculation Logic

```
current = max( minimum_price,
               original_price − floor(elapsed_seconds / interval) × decrease )
elapsed = now() − sale_start_at        ← 一律 Server Time
```

- 同一條公式存在兩處：SQL（`compute_current_price`，權威）與
  TypeScript（`pricing.ts`，純顯示）。兩者以單元測試對齊語義。
- 前端每秒重算只是 UI；倒數歸零的瞬間即使畫面沒跳，
  下單時 Server 仍會用「交易瞬間」的價格——寧可便宜算給客人，不會多收。

## 7. 角色與權限模型

| | admin | customer |
|---|---|---|
| 資料來源 | `admins` 表（user_id 對應 auth.users） | `customers` 白名單 |
| 讀 | 全部資料 | 僅授權活動＋自己的訂單＋自己的帳號 |
| 寫 | 活動/商品/客戶/訂單狀態 | 僅「建立訂單」（透過搶購函式） |
| Admin API | ✅ | ❌（403） |

RLS 策略摘要：
- customers：只能 SELECT 自己那列；寫入僅 admin。
- campaigns/products：`can_see_campaign()` 統一判斷授權範圍。
- orders：`user_id = auth.uid() or is_admin()`。
- 所有表的寫入政策都要求 `is_admin()`；customer 對價格/庫存/活動
  連 UPDATE 的門都沒有（Test 5/6 驗證）。

## 8. 安全清單（規格二十三、二十四對照）

- ✅ service_role key 只在 Edge Functions 環境變數
- ✅ 前端只放 anon key（本來就是公開的，靠 RLS 保護）
- ✅ price / stock / user_id / role / timestamp 全部不信 client：
  價格 Server 算、庫存 DB 鎖、user_id 取自 JWT、角色查 admins 表
- ✅ .env* 皆在 .gitignore；repo 只有 .env.example
- ✅ API Validation：quantity 整數 ≥1、≤限購；手機格式 DB CHECK；
  訂單狀態白名單才接受
