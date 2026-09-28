#!/usr/bin/env node
/** 提交前检查: node语法 + ESLint(含 no-undef 常量完整性) + 按钮/分支覆盖 + manifest版本。 */
import { readFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const js = readFileSync('src/index.js', 'utf8');
const errors = [];

// 1) node 语法
const tmp = mkdtempSync(join(tmpdir(), 'wvs-'));
copyFileSync('src/index.js', join(tmp, 'check.cjs'));
try { execSync(`node --check ${join(tmp, 'check.cjs')}`, { stdio: 'pipe' }); }
catch (e) { errors.push('语法错误:\n' + e.stderr); }
rmSync(tmp, { recursive: true, force: true });

// 2) ESLint(含 no-undef——未定义变量/常量在这里拦截, globals 已在 eslint.config.mjs 声明)
try {
  const out = execSync('npx eslint src/index.js', { stdio: 'pipe', encoding: 'utf8' });
} catch (e) {
  const lint = (e.stdout || '') + (e.stderr || '');
  // 有 error 就拦( warning 放行 )
  if (/\d+\s+errors?/.test(lint) || /error\b/.test(lint)) {
    errors.push('ESLint 有 error:\n' + lint.slice(0, 800));
  }
}

// 3) data-act 按钮必须有处理分支(在原始源码上查, 不受格式化影响)
const btns = [...new Set([...js.matchAll(/data-act="(\w+)"/g)].map(m => m[1]))];
const handled = new Set([...js.matchAll(/act\s*===?\s*['"](\w+)['"]/g)].map(m => m[1]));
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

if (errors.length) { console.error('✗ check 失败:'); errors.forEach(e => console.error(' -', e)); process.exit(1); }
console.log(`✓ check 通过 (按钮 ${btns.length}/${btns.length} 有分支, ESLint 无 error)`);
