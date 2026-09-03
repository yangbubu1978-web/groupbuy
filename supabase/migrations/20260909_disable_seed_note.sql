-- Phase 0 / 安全：停用 production seed function
-- seed 會建立固定 demo 帳號，不能讓公開 Function URL 觸發。
-- 保留檔案供本機／受控部署參考，但撤銷線上公開 Function 的呼叫權限。
-- Supabase Edge Function 本身不提供 PostgreSQL GRANT；此 migration 用於留下正式安全決策紀錄。
COMMENT ON SCHEMA public IS 'Production seed function must not be publicly callable; use controlled local/admin seeding only.';
