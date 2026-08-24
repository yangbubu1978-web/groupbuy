import json, urllib.request, urllib.error

# VIP 新資料庫驗證
def q(sql):
    req = urllib.request.Request(
        'https://api.supabase.com/v1/projects/mljaaifoztwnorajuriz/database/query',
        data=json.dumps({'query': sql}).encode(),
        headers={
            'Authorization': 'Bearer ' + __import__('os').environ.get('SUPABASE_ACCESS_TOKEN', ''),
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
        },
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

# 1) 核心資料表
tables = q("select tablename from pg_tables where schemaname='public' order by tablename")
print('資料表:', [t['tablename'] for t in tables])

# 2) 定價函式
fns = q("select proname from pg_proc where proname in ('compute_current_price','purchase_product','cancel_own_order','admin_transition_order','lookup_login_by_name')")
print('函式:', [f['proname'] for f in fns])
