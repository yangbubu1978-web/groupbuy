# 封閉式動態降價團購平台

Private Dynamic Pricing Group Buy 平台 — 價格隨時間自動下降、庫存先搶先贏。
手機優先（Mobile First）PWA，可「加入主畫面」，同時支援桌面瀏覽器。

> 設計文件（架構與設計理由）：見 [ARCHITECTURE.md](./ARCHITECTURE.md)

## 從 0 到正式上線 — 完整操作步驟

### Phase A：建立 Supabase 專案（約 5 分鐘）

1. 前往 https://supabase.com → Sign up（免費）→ **New project**
   - Name: `groupbuy`、Region: 選離台灣近的（Singapore）
   - 設定資料庫密碼（**只存在密碼管理工具，不放進 Git**）
2. 專案建立後，左側 **SQL Editor** → New query
3. 貼上 `supabase/schema.sql` 全部內容 → **Run**
   - 自動建立：資料表、RLS 政策、搶購交易函式、降價函式、種子資料
4. 左側 **Project Settings → API**，記下兩個值：
   - `Project URL`（之後稱 `SUPABASE_URL`）
   - `anon public` key（之後稱 `SUPABASE_ANON_KEY`）

### Phase B：部署 Edge Functions

```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF   # URL 裡的專案 ID
supabase functions deploy purchase
supabase functions deploy admin
supabase functions deploy seed
```

### Phase C：建立示範客戶帳號（一次性）

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/seed" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

- Service Role Key 在 Project Settings → API（**絕不放入前端或 Git**）
- 示範帳號：`0975389197` 王小明 / `0912000002` 李小華 / 密碼皆 `demo1234`

### Phase D：設定第一位 Admin

SQL Editor 執行：

```sql
insert into public.admins (user_id)
select id from auth.users
where email = '0975389197@phone.groupbuy.local';
```

> 王小明從此登入後會看到「管理後台」入口。要加第二位 admin，
> 先在後台幫他建客戶帳號，再執行一次上面的 insert 換成他的 email。

### Phase E：前端環境變數與本機測試

```bash
cd app
cp .env.example .env.local
# .env.local 內容：
#   VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
#   VITE_SUPABASE_ANON_KEY=eyJ...（anon key）
npm run dev
# 開 http://localhost:5173 → 用 0975389197 / demo1234 登入
```

`.env.local` 已被 `.gitignore` 排除，不會進版控。

### Phase F：部署（實際採用：GitHub Pages）

**目前線上網址**：https://yangbubu1978-web.github.io/groupbuy/
（repo `yangbubu1978-web/groupbuy`，`gh-pages` 分支、根目錄、HashRouter）

**更新部署流程**：

```bash
cd app && npm run build
cd /tmp && rm -rf gp_deploy
git clone --branch gh-pages --depth 1 https://github.com/yangbubu1978-web/groupbuy.git gp_deploy
cd gp_deploy
rsync -a --delete --exclude '.git' --exclude '.nojekyll' \
  /Users/yang.bubu/.openclaw/workspace/groupbuy/app/dist/ ./
git add -A && git commit -m "deploy: 更新" && git push origin gh-pages
```

⚠️ **快取注意**：
- `public/sw.js` 的 `CACHE` 版本號每次改殼層結構時要遞增（目前 `groupbuy-shell-v2`）
- HTML 已是 network-first，部署後裝置重新整理即可拿到新版
- GitHub Pages 本身有 10 分鐘 CDN 快取，剛 push 完看不到新版是正常的

### Phase G：建立第一個團購活動

1. 以 admin 登入 → 管理後台 → **＋ 新增活動**
2. 填入名稱、說明、開始／結束時間
3. 狀態選「草稿」→ 之後在活動列表按「開始活動」；
   或直接選「直接開始」

### Phase H：建立第一個商品＋設定降價規則

1. 管理後台 → 商品管理 → **＋ 新增**
2. 選擇活動、填名稱與 SKU
3. 降價規則四個欄位：
   | 欄位 | 範例 | 意義 |
   |---|---|---|
   | 原價 | 1500 | 開賣時價格 |
   | 最低價格 | 1000 | 地板價，永遠不低於此 |
   | 降價間隔（秒） | 60 | 每 60 秒降一次 |
   | 每次降價（元） | 10 | 每次降 10 元 |
4. 初始庫存 20、每人限購 2
5. 授權範圍：全部客戶／指定公司／指定群組
6. 建立 → 系統自動依規則降價，管理員不需手動改價

### Phase I：測試方式

**自動化測試（已在本機 PostgreSQL 16 全數通過）**

| 測試 | 內容 | 結果 |
|---|---|---|
| Test 1 | 單一客戶正常購買 | PASS |
| Test 2 | 兩人搶最後一件恰一人成功 | PASS |
| Test 3 | 庫存 0 拒絕 | PASS |
| Test 4 | Server 計價正確（跨多個降價區間至地板價） | PASS |
| Test 5 | 客戶無法竄改價格＋訂單採 Server 價 | PASS |
| Test 6 | Customer 無法執行 Admin 操作（RLS） | PASS |
| Test 7 | 看不到他人訂單 | PASS |
| Test 8 | 超過限購拒絕 | PASS |

重現方式（本機有 PostgreSQL 即可）：

```bash
createdb groupbuy_test
psql -d groupbuy_test -v ON_ERROR_STOP=1 -f supabase/local-test-setup.sql
psql -d groupbuy_test -v ON_ERROR_STOP=1 -f supabase/schema.sql
# 綁定測試 auth user（見 tests.sql 開頭註解）後：
psql -d groupbuy_test -f supabase/tests.sql
```

前端定價引擎單元測試：

```bash
cd app && npx vitest run src/lib/pricing.test.ts   # 12/12 passed
```

**手動測試兩人同時搶最後一件**

1. 開一個庫存 = 1 的商品
2. 兩支手機分別用兩個客戶帳號登入，都停在商品頁
3. 數到 3 同時按「立即搶購」
4. 預期：一人看到 🎉 搶購成功（含訂單編號），另一人看到 😢 慢了一步
5. 後台訂單管理應只有一筆訂單；商品庫存歸零不為負

**DevTools 驗證（Test 5 的手動版）**

開瀏覽器 DevTools → 攔截 purchase 請求改成偽造 price →
Server 回傳的成交價仍是 Server 計算值（請求裡根本沒有 price 欄位）。

## 環境變數總表

| 變數 | 放哪裡 | 說明 |
|---|---|---|
| VITE_SUPABASE_URL | 前端 .env.local / CF Pages | 公開，靠 RLS 保護 |
| VITE_SUPABASE_ANON_KEY | 前端 .env.local / CF Pages | 公開 anon key |
| SUPABASE_SERVICE_ROLE_KEY | Edge Functions 自動注入 | 絕不進前端/Git |
| 資料庫密碼 | Supabase 專案設定 | 絕不進 Git |

## 目錄結構

```
groupbuy/
├── ARCHITECTURE.md            # Phase 1 架構文件（設計理由）
├── README.md                  # 本文件
├── app/                       # React + Vite + TS + Tailwind（PWA）
│   ├── public/
│   │   ├── manifest.webmanifest
│   │   ├── sw.js              # Service Worker（API 永不快取）
│   │   └── icons/
│   └── src/
│       ├── lib/               # supabase / pricing / useLivePrice / types
│       ├── context/AuthContext.tsx
│       └── pages/             # Login / List / Product / Orders /
│                              # Profile / Admin ×5
└── supabase/
    ├── schema.sql             # 完整資料庫（含 RLS + 搶購函式）
    ├── local-test-setup.sql   # 本機測試用 Supabase 模擬層
    ├── tests.sql              # 八項整合測試
    └── functions/             # purchase / admin / seed
```

## 核心保證（對照規格）

- **Server Time 是唯一時間依據**：前端時鐘只做顯示校準（server_now RPC）
- **Server Price 是唯一價格依據**：purchase_product 交易內重算；API 不接受 price 參數
- **Database Inventory 是唯一庫存依據**：FOR UPDATE + 條件式 UPDATE + CHECK 三層防護
- **只有 Atomic Lock 成功者才算搶購成功**：affected rows = 0 即失敗
- **公平、準確、不超賣、資料安全** → 已由八項整合測試驗證
