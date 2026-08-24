import json, subprocess, pathlib

r = subprocess.run(
    ['supabase', 'projects', 'api-keys', '--project-ref', 'mljaaifoztwnorajuriz'],
    capture_output=True, text=True,
    env={'SUPABASE_ACCESS_TOKEN': __import__('os').environ.get('SUPABASE_ACCESS_TOKEN', ''), 'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/Users/yang.bubu'},
)
d = json.loads(r.stdout)
keys = {k['id']: k['api_key'] for k in d['keys']}
env = (
    'VITE_SUPABASE_URL=https://mljaaifoztwnorajuriz.supabase.co\n'
    f'VITE_SUPABASE_ANON_KEY={keys["anon"]}\n'
    f'SUPABASE_SERVICE_ROLE_KEY={keys.get("service_role", "")}\n'
)
pathlib.Path('/Users/yang.bubu/.openclaw/workspace/groupbuy/vip.env.local').write_text(env, encoding='utf-8')
print('saved vip.env.local (gitignored? checking...)')
print('url: https://mljaaifoztwnorajuriz.supabase.co')
