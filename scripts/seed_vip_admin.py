import json, urllib.request, urllib.error

# VIP 新資料庫：種子管理員（用 service_role Admin API 建帳號）
SRK = None
for line in open('/Users/yang.bubu/.openclaw/workspace/groupbuy/vip.env.local', encoding='utf-8'):
    if line.startswith('SUPABASE_SERVICE_ROLE_KEY='):
        SRK = line.split('=', 1)[1].strip()

def admin_api(path, payload):
    req = urllib.request.Request(
        f'https://mljaaifoztwnorajuriz.supabase.co/auth/v1/{path}',
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Bearer {SRK}', 'apikey': SRK, 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {'error': e.read().decode()[:200]}

res = admin_api('admin/users', {
    'email': 'admin@admin.groupbuy.local',
    'password': '84122920',
    'email_confirm': True,
    'user_metadata': {'name': '管理員'},
})
uid = res.get('id')
print('auth 帳號:', 'OK ' + uid if uid else res)
