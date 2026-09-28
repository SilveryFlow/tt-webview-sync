#!/usr/bin/env node
/** 打包 src/index.js 到根目录 index.js(TT加载入口), 检查通过后执行。 */
import { execSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

execSync('node scripts/check.mjs', { stdio: 'inherit' });
copyFileSync('src/index.js', 'index.js');
// 同步版本号到 manifest
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const man = JSON.parse(readFileSync('manifest.json', 'utf8'));
man.version = pkg.version;
writeFileSync('manifest.json', JSON.stringify(man, null, 4) + '\n');
copyFileSync('src/index.js', 'index.js');
console.log(`✓ released v${pkg.version} → index.js`);
