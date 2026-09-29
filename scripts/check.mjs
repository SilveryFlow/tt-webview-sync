#!/usr/bin/env node
/** 提交前检查: 全模块 node 语法 + ESLint(含 no-undef) + 按钮/分支覆盖 + 模块导入解析 + manifest版本。 */
import { readFileSync, readdirSync, existsSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = readdirSync('src').filter(f => f.endsWith('.js')).sort();
if (!files.includes('main.js')) { console.error('✗ src/main.js 入口缺失'); process.exit(1); }
const all = files.map(f => readFileSync(join('src', f), 'utf8')).join('\n');
const errors = [];

// 1) node 语法(ESM: 复制为 .mjs 检查 import/export)
const tmp = mkdtempSync(join(tmpdir(), 'wvs-'));
try {
  for (const f of files) {
    copyFileSync(join('src', f), join(tmp, f.replace(/\.js$/, '.mjs')));
    try { execSync(`node --check ${join(tmp, f.replace(/\.js$/, '.mjs'))}`, { stdio: 'pipe' }); }
    catch (e) { errors.push(`${f} 语法错误:\n` + e.stderr); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }

// 2) ESLint 全模块(含 no-undef——未定义变量/常量在这里拦截, globals 已在 eslint.config.mjs 声明)
try {
  execSync('npx eslint src index.js', { stdio: 'pipe', encoding: 'utf8' });
} catch (e) {
  const lint = (e.stdout || '') + (e.stderr || '');
  // 有 error 就拦( warning 放行 )
  if (/\d+\s+errors?/.test(lint) || /error\b/.test(lint)) {
    errors.push('ESLint 有 error:\n' + lint.slice(0, 800));
  }
}

// 3) data-act 按钮必须有处理分支(在原始源码上查, 不受格式化影响)
const btns = [...new Set([...all.matchAll(/data-act="(\w+)"/g)].map(m => m[1]))];
const handled = new Set([...all.matchAll(/act\s*===?\s*['"](\w+)['"]/g)].map(m => m[1]));
const missing = btns.filter(b => !handled.has(b));
if (missing.length) errors.push(`按钮无处理分支: ${missing}`);

// 4) 模块导入解析: 每个 ./x.js 引用的文件都存在 + 入口链完整(无打包器,漏提交文件 = 用户装完即崩)
for (const f of files) {
  const src = readFileSync(join('src', f), 'utf8');
  for (const [, spec] of src.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    if (!existsSync(join('src', spec.replace('./', '')))) errors.push(`${f} 导入了不存在的 ${spec}`);
  }
}
const entry = readFileSync('index.js', 'utf8');
if (!/import\s+['"]\.\/src\/main\.js['"]/.test(entry)) errors.push('index.js 入口未指向 src/main.js');
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
if (!existsSync(manifest.js)) errors.push(`manifest.js 指向的 ${manifest.js} 不存在`);

// 5) NDJSON 往返冒烟测试(fake-indexeddb, 需先 npm i)
try {
  execSync('node scripts/test-roundtrip.mjs', { stdio: 'inherit' });
} catch (e) {
  errors.push('往返测试失败');
}

// 6) manifest 版本必须 > HEAD(纯文档提交 SKIP_VERSION=1)
if (process.env.SKIP_VERSION !== '1') {
  try {
    const head = JSON.parse(execSync('git show HEAD:manifest.json', { stdio: ['pipe', 'pipe', 'ignore'] }).toString());
    const vt = v => v.split('.').map(Number);
    if (vt(manifest.version) <= vt(head.version)) errors.push(`版本未升级 HEAD=${head.version} cur=${manifest.version}`);
  } catch { /* 首次提交 */ }
}

if (errors.length) { console.error('✗ check 失败:'); errors.forEach(e => console.error(' -', e)); process.exit(1); }
console.log(`✓ check 通过 (${files.length} 模块, 按钮 ${btns.length}/${btns.length} 有分支, ESLint 无 error)`);
