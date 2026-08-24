import pathlib, re

root = pathlib.Path('/Users/yang.bubu/.openclaw/workspace/groupbuy/app/src')
files = sorted(root.rglob('*.tsx')) + sorted(root.rglob('*.ts'))
files = [f for f in files if 'test' not in f.name]

findings = []
for f in files:
    rel = str(f.relative_to(root))
    lines = f.read_text(encoding='utf-8').splitlines()
    joined = '\n'.join(lines)
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if 'onPaste' in s and 'preventDefault' in line:
            findings.append((rel, i, 'onPaste preventDefault（禁擋貼上）'))
        if 'transition-all' in s:
            findings.append((rel, i, 'transition: all → 列舉屬性'))
        if 'outline-none' in s:
            findings.append((rel, i, 'outline-none 無 focus-visible 替代'))
        if '<img ' in line:
            if 'alt=' not in line:
                findings.append((rel, i, '<img> 缺 alt'))
            elif 'width=' not in line and 'aspect-' not in line and 'h-' not in line:
                findings.append((rel, i, '<img> 無尺寸（CLS 風險）'))
        if 'autoFocus' in s:
            findings.append((rel, i, 'autoFocus（行動裝置應避免）'))
        m = re.search(r'(確認中|載入中|處理中|匯出中|取消中|儲存中)\.\.\.', s)
        if m:
            findings.append((rel, i, f'loading「{m.group(1)}...」→ 應用 …'))
        if re.search(r'<(div|span)[^>]*onClick', s):
            findings.append((rel, i, 'div/span onClick → 應用 <button>/可及性'))
        # 表單輸入無 label（粗掃：input 無 aria-label 且檔案中該 input 前後無 label）
    # img 多行標籤處理
    for i, line in enumerate(lines):
        if '<img' in line and '/>' not in line and '>' not in line.split('<img')[1]:
            block = '\n'.join(lines[i:i+6])
            if 'alt=' not in block:
                findings.append((rel, i+1, '<img>(多行) 缺 alt'))
    # window.confirm 用於破壞性動作（可，但列出）
    for i, line in enumerate(lines, 1):
        if 'window.confirm' in line:
            findings.append((rel, i, 'window.confirm（原生對話框；建議自訂 modal）'))

print(f'共 {len(findings)} 條')
import collections
by_file = collections.defaultdict(list)
for fp, ln, msg in findings:
    by_file[fp].append(f'{fp}:{ln} - {msg}')
for fp in sorted(by_file):
    print()
    print('##', fp)
    for x in by_file[fp]:
        print(x)
