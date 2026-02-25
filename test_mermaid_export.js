#!/usr/bin/env node
/**
 * 沙箱测试：mermaid 代码块解析与替换逻辑
 * 运行: node test_mermaid_export.js
 */

const fs = require('fs');
const path = require('path');

const MERMAID_BLOCK_RE = /^```mermaid\s*\n([\s\S]*?)```\s*$/gm;

const content = fs.readFileSync(path.join(__dirname, 'mermaid.md'), 'utf-8');
const blocks = [];
let m;
MERMAID_BLOCK_RE.lastIndex = 0;
while ((m = MERMAID_BLOCK_RE.exec(content)) !== null) {
  blocks.push({ fullMatch: m[0].slice(0, 50) + '...', code: m[1].trim().slice(0, 30) + '...', index: m.index });
}

console.log('=== mermaid 代码块解析测试 ===');
console.log('找到', blocks.length, '个 mermaid 块');
blocks.forEach((b, i) => {
  console.log(`  [${i + 1}] index=${b.index}, code 预览: ${b.code}`);
});

// 模拟替换
const replacements = blocks.map((_, i) => ({
  from: blocks[i].fullMatch.replace('...', ''), // 简化：实际会用完整 match
  to: `\n![](assets/mermaid-mermaid-${String(i + 1).padStart(3, '0')}.png)\n`
}));

// 实际替换需要用完整 fullMatch - 这里只验证逻辑
let newContent = content;
for (let i = 0; i < blocks.length; i++) {
  const re = new RegExp('^```mermaid\\s*\\n([\\s\\S]*?)```\\s*$', 'gm');
  newContent = newContent.replace(re, (full) => {
    return `\n![](assets/mermaid-mermaid-${String(blocks.indexOf(full) >= 0 ? blocks.findIndex(b => content.includes(b.fullMatch)) + 1 : i + 1).padStart(3, '0')}.png)\n`;
  });
  break; // 一次替换一个
}
// 简化：直接做全局替换
newContent = content.replace(MERMAID_BLOCK_RE, (full) => {
  return '\n![](assets/mermaid-mermaid-001.png)\n'; // 简化，实际会按序号
});
const hasImage = /!\[.*?\]\(assets\/.*?\.png\)/.test(newContent);
const hasMermaidBlock = /```mermaid/.test(newContent);
console.log('\n替换后: 含图片引用=', hasImage, ', 含 mermaid 块=', hasMermaidBlock);
console.log(hasImage && !hasMermaidBlock ? '✅ 通过' : '⚠️ 需检查');
