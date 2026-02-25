#!/usr/bin/env node
/**
 * 沙箱测试：月文件拆分为日文件的解析逻辑
 * 运行: node test_month_split.js
 */

const monthPattern = /^(\d{4})-(\d{2})\.md$/;
const sectionHeader = /^(?:- )?## (\d{4}-\d{2}-\d{2})\s*$/gm;

// 模拟 TFile：basename 不含扩展名，name 含扩展名
const tests = [
  { name: '2024-01.md', basename: '2024-01' },
  { name: '2025-12.md', basename: '2025-12' }
];

console.log('=== 1. 月文件匹配测试 ===');
for (const f of tests) {
  const matchName = monthPattern.test(f.name);
  const matchBasename = monthPattern.test(f.basename);
  console.log(`  name="${f.name}"     monthPattern.test: ${matchName}`);
  console.log(`  basename="${f.basename}" monthPattern.test: ${matchBasename}`);
  console.log(`  => 结论: 应用 child.name 而非 child.basename`);
}

console.log('\n=== 2. 段落切分测试 ===');
const sampleContent = `## 2024-01-15

今日内容 A

## 2024-01-16

今日内容 B
`;
const parts = sampleContent.split(sectionHeader);
console.log('  parts.length:', parts.length);
console.log('  parts:', JSON.stringify(parts, null, 2));

const entries = [];
for (let i = 1; i + 1 < parts.length; i += 2) {
  const dateStr = parts[i].trim();
  const block = parts[i + 1].trim();
  if (!block) continue;
  entries.push({ dateStr, block });
}
console.log('  解析出的 entries:', entries);

console.log('\n=== 3. merge_to_month 输出格式验证 ===');
const mergedFormat = entries.map(({ dateStr, block }) => `## ${dateStr}\n\n${block}\n\n`).join('\n');
console.log('  合并后格式:\n', mergedFormat);
const reparsed = mergedFormat.split(sectionHeader);
console.log('  再次切分 parts.length:', reparsed.length);
console.log('  ✅ 格式兼容' + (reparsed.length >= 3 ? '' : ' ❌ 有问题'));
