#!/usr/bin/env node
/** 提交前检查: node语法 + 引用完整性 + 按钮/分支覆盖 + manifest版本。 */
import { readFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const js = readFileSync('src/index.js', 'utf8');
const errors = [];

// 1) 语法
const tmp = mkdtempSync(join(tmpdir(), 'wvs-'));
copyFileSync('src/index.js', join(tmp, 'check.cjs'));
try { execSync(`node --check ${join(tmp, 'check.cjs')}`, { stdio: 'pipe' }); }
catch (e) { errors.push('语法错误:\n' + e.stderr); }

// 2) 字符串抠掉后的大写常量引用完整性
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);
const stripRe = (q) => new RegExp(q + '(?:[^' + q + BS + BS + ']|' + BS + BS + '.)*' + q, 'g');
const stripped = js.replace(stripRe(SQ), SQ + SQ).replace(stripRe(DQ), DQ + DQ).replace(stripRe(BT), BT + BT);
const defined = new Set(
  [...stripped.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)/g), ...stripped.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
);
for (const m of stripped.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
  if (!defined.has(m[1])) errors.push(`未定义常量被引用: ${m[1]}`);
}

// 3) data-act 按钮必须有处理分支
const btns = [...new Set([...js.matchAll(/data-act="(\w+)"/g)].map(m => m[1]))];
const handled = new Set([...js.matchAll(/act === '(\w+)'/g)].map(m => m[1]));
const missing = btns.filter(b => !handled.has(b));
if (missing.length) errors.push(`按钮无处理分支: ${missing}`);

// 4) manifest 版本必须 > HEAD(纯文档提交 SKIP_VERSION=1)
if (process.env.SKIP_VERSION !== '1') {
  try {
    const head = JSON.parse(execSync('git show HEAD:manifest.json', { stdio: ['pipe', 'pipe', 'ignore'] }).toString());
    const cur = JSON.parse(readFileSync('manifest.json', 'utf8'));
    const vt = v => v.split('.').map(Number);
    if (vt(cur.version) <= vt(head.version)) errors.push(`版本未升级 HEAD=${head.version} cur=${cur.version}`);
  } catch { /* 首次提交 */ }
}
rmSync(tmp, { recursive: true, force: true });

if (errors.length) { console.error('✗ check 失败:'); errors.forEach(e => console.error(' -', e)); process.exit(1); }
console.log(`✓ check 通过 (按钮 ${btns.length}, 常量定义 ${defined.size})`);
