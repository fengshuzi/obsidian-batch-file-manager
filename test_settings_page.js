#!/usr/bin/env node
/**
 * 回归测试：设置页渲染模式与版本元数据一致性
 * 背景: 1.2.2/1.2.3 用 1.13 声明式 getSettingDefinitions 包装（单 render item +
 * group.listEl.empty() + 隐藏行），在 Obsidian 1.13.x 实际渲染为空白设置页。
 * 1.2.4 回退经典 display()（同 keyword-notes-editor 1.0.22 先例）。
 * 运行: node test_settings_page.js
 */

const fs = require('fs');
const path = require('path');

const root = __dirname;
const mainTs = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

console.log('=== 1. 设置页渲染模式（防空白回归） ===');
check('main.ts 使用经典 display() 渲染设置页', /display\(\): void\s*\{/.test(mainTs));
check('main.ts 不再使用声明式 getSettingDefinitions 包装', !/getSettingDefinitions\(/.test(mainTs));
check('main.ts 不再使用 group.listEl.empty() 破坏声明式容器', !mainTs.includes('listEl.empty()'));
check('main.ts 不再引用 SettingDefinitionItem 类型', !mainTs.includes('SettingDefinitionItem'));
check('styles.css 不含隐藏设置行的 fc-settings-row-hidden', !stylesCss.includes('fc-settings-row-hidden'));

console.log('\n=== 2. 版本元数据一致性 ===');
check('manifest.json 与 package.json 版本一致', manifest.version === pkg.version);
check('versions.json 含当前版本条目', versions[manifest.version] !== undefined);
check('versions.json 当前条目的 minAppVersion 与 manifest 一致', versions[manifest.version] === manifest.minAppVersion);
check('历史条目 1.2.3 的 minAppVersion 保持 1.13.0 不被回写', versions['1.2.3'] === '1.13.0');
check('minAppVersion 已从 1.13.0 回落到 1.7.2（revealLeaf/trashFile 实际下限）', manifest.minAppVersion === '1.7.2');

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
