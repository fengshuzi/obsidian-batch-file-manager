#!/usr/bin/env node
/**
 * 沙箱测试：模拟一键归档 + 一键还原全流程
 * 运行: node test_journals_sandbox.js
 * 需在插件目录执行，会在 ./test_journals_temp 创建临时目录
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR = path.join(__dirname, 'test_journals_temp');
const DAILY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})\.md$/;
const SECTION_HEADER = /^(?:- )?## (\d{4}-\d{2}-\d{2})\s*$/gm;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listDir(dir) {
  return fs.readdirSync(dir).map((name) => ({
    name,
    path: path.join(dir, name),
    isFile: fs.statSync(path.join(dir, name)).isFile()
  }));
}

function mergeToMonth(dir) {
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthEntries = {};
  const monthDeletes = {};

  for (const item of listDir(dir)) {
    if (!item.isFile) continue;
    const m = item.name.match(DAILY_PATTERN);
    if (!m) continue;
    const dateStr = `${m[1]}-${m[2]}-${m[3]}`;
    const yearMonth = dateStr.slice(0, 7);
    if (yearMonth === currentYm) continue;
    let raw;
    try {
      raw = fs.readFileSync(item.path, 'utf-8').trim();
      if (!raw) continue;
    } catch {
      continue;
    }
    if (!monthEntries[yearMonth]) {
      monthEntries[yearMonth] = [];
      monthDeletes[yearMonth] = [];
    }
    monthEntries[yearMonth].push({ dateStr, content: raw });
    monthDeletes[yearMonth].push(item.path);
  }

  let merged = 0;
  for (const month of Object.keys(monthEntries).sort()) {
    const outputPath = path.join(dir, `${month}.md`);
    let existing = {};
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      const parts = content.split(SECTION_HEADER);
      for (let i = 1; i + 1 < parts.length; i += 2) {
        existing[parts[i].trim()] = parts[i + 1].trim();
      }
    }
    for (const { dateStr, content } of monthEntries[month]) {
      existing[dateStr] = content;
    }
    const body = Object.entries(existing)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, c]) => `## ${d}\n\n${c}\n\n`)
      .join('\n');
    fs.writeFileSync(outputPath, body);
    merged++;
    for (const p of monthDeletes[month]) fs.unlinkSync(p);
  }
  return merged;
}

function monthToDaily(dir) {
  const monthFiles = listDir(dir)
    .filter((f) => f.isFile && MONTH_PATTERN.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  let total = 0;
  for (const mf of monthFiles) {
    const content = fs.readFileSync(mf.path, 'utf-8');
    const parts = content.split(SECTION_HEADER);
    const entries = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const dateStr = parts[i].trim();
      const block = parts[i + 1].trim();
      if (!block) continue;
      entries.push({ dateStr, block });
    }
    for (const { dateStr, block } of entries) {
      fs.writeFileSync(path.join(dir, `${dateStr}.md`), block);
      total++;
    }
    fs.unlinkSync(mf.path);
  }
  return total;
}

function main() {
  console.log('=== 日记归档/还原 沙箱测试 ===\n');
  ensureDir(TEST_DIR);

  // 1. 创建若干日文件（避开当前月）
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  const testMonth = thisMonth === 1 ? 12 : thisMonth - 1;
  const testYear = thisMonth === 1 ? thisYear - 1 : thisYear;
  const dailyFiles = [
    { date: `${testYear}-${String(testMonth).padStart(2, '0')}-01`, content: '第一天' },
    { date: `${testYear}-${String(testMonth).padStart(2, '0')}-02`, content: '第二天' }
  ];

  for (const { date, content } of dailyFiles) {
    const p = path.join(TEST_DIR, `${date}.md`);
    fs.writeFileSync(p, content);
    console.log('  创建日文件:', p);
  }

  // 2. 归档
  const merged = mergeToMonth(TEST_DIR);
  console.log('\n  归档完成，合并', merged, '个月份');

  const monthPath = path.join(TEST_DIR, `${testYear}-${String(testMonth).padStart(2, '0')}.md`);
  if (fs.existsSync(monthPath)) {
    console.log('  月文件内容:', fs.readFileSync(monthPath, 'utf-8').trim().slice(0, 80) + '...');
  }

  // 3. 还原
  const restored = monthToDaily(TEST_DIR);
  console.log('\n  还原完成，还原', restored, '个日文件');

  // 4. 验证
  let ok = true;
  for (const { date, content } of dailyFiles) {
    const p = path.join(TEST_DIR, `${date}.md`);
    if (!fs.existsSync(p)) {
      console.log('  ❌ 日文件丢失:', date);
      ok = false;
    } else {
      const got = fs.readFileSync(p, 'utf-8').trim();
      if (got !== content) {
        console.log('  ❌ 内容不一致:', date, 'expected', content, 'got', got);
        ok = false;
      }
    }
  }

  // 5. 清理
  for (const f of fs.readdirSync(TEST_DIR)) {
    fs.unlinkSync(path.join(TEST_DIR, f));
  }
  fs.rmdirSync(TEST_DIR);

  console.log('\n' + (ok ? '✅ 沙箱测试通过' : '❌ 沙箱测试失败'));
  process.exit(ok ? 0 : 1);
}

main();
