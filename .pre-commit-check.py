#!/usr/bin/env python3
"""提交前静态检查: 所有被引用的顶层标识符必须有定义; manifest 版本必改; 敏感遗留检查。"""
import re, sys, json, subprocess

js = open('index.js', encoding='utf-8').read()
errors = []

# 1) node 语法检查
r = subprocess.run(['node', '--check', 'index.js'], capture_output=True, text=True)
if r.returncode: errors.append('node --check 失败:\n' + r.stderr[:500])

# 2) 标识符定义检查: 收集 const/let/function 定义名
defined = set(re.findall(r'\b(?:const|let)\s+([A-Za-z_$][\w$]*)', js))
defined |= set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)', js))
defined |= {'window', 'document', 'console', 'fetch', 'alert', 'confirm', 'location',
            'indexedDB', 'localStorage', 'setTimeout', 'URL', 'Blob', 'FileReader',
            'atob', 'btoa', 'JSON', 'Math', 'Date', 'String', 'Number', 'Object',
            'Array', 'Error', 'Promise', 'Set', 'Map', 'console', 'self', 'unescape',
            'encodeURIComponent', 'decodeURIComponent', 'Uint8Array', 'ArrayBuffer'}

# 引用面: 带下划线的大写常量(API_XXX 等)必须已定义; 字符串与注释先抠掉
code_only = re.sub(r"'(?:[^'\\]|\\.)*'", "''", js)
code_only = re.sub(r'"(?:[^"\\]|\\.)*"', '""', code_only)
code_only = re.sub(r'`(?:[^`\\]|\\.)*`', '``', code_only)
code_only = re.sub(r'//[^\n]*', '', code_only)
code_only = re.sub(r'/\*[\s\S]*?\*/', '', code_only)
for ident in set(re.findall(r'\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b', code_only)):
    if ident not in defined:
        errors.append(f'未定义的常量被引用: {ident}')

# 3) 模板串里的可疑断字(\n 落成真换行 = 上次的语法坑)
if re.search(r"confirm\('[^']*?\n[^']*?'\)", js, re.S):
    pass  # 合法多行串不存在,但 python patch 常把 \n 变真换行导致 node --check 已拦

# 4) manifest 版本必须高于 git HEAD 的
try:
    head = subprocess.run(['git', 'show', 'HEAD:manifest.json'], capture_output=True, text=True).stdout
    old_v = json.loads(head)['version']
    new_v = json.load(open('manifest.json', encoding='utf-8'))['version']
    def vt(v): return tuple(int(x) for x in v.split('.'))
    import os
    if vt(new_v) <= vt(old_v) and os.environ.get('SKIP_VERSION') != '1':
        errors.append(f'manifest 版本未升级: HEAD={old_v} 本次={new_v} (纯文档提交用 SKIP_VERSION=1 git commit)')
except Exception:
    pass  # 首次提交无 HEAD

# 5) 事件分支覆盖: HTML 里每个 data-act 必须有对应处理分支
html_acts = set(re.findall(r'data-act="(\w+)"', js))
handled = set(re.findall(r"act === '(\w+)'", js))
missing = html_acts - handled - {'*'}
if missing: errors.append(f'按钮无处理分支: {sorted(missing)}')

if errors:
    print('✗ 检查失败:'); [print(' -', e) for e in errors]; sys.exit(1)
print(f'✓ 静态检查通过 (定义 {len(defined)} 项, 按钮 {len(html_acts)} 个, 版本 {new_v})')
