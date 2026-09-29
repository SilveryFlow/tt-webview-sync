#!/usr/bin/env node
/** 发布: 跑检查 + 同步 package.json 版本到 manifest.json。
 *  产物即源码——TT 以 type=module 加载 index.js 垫片, src/ 多模块直接生效, 无拷贝/打包步骤。 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

execSync('node scripts/check.mjs', { stdio: 'inherit' });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const man = JSON.parse(readFileSync('manifest.json', 'utf8'));
man.version = pkg.version;
writeFileSync('manifest.json', JSON.stringify(man, null, 4) + '\n');
console.log(`✓ released v${pkg.version} (src/ 多模块直发)`);
