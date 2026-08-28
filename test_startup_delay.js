#!/usr/bin/env node
/**
 * 回归测试：启动日记任务的延迟调度 + iCloud 冲突文件的新鲜度检查
 * 背景 1: 启动立即合并 iCloud 冲突文件/迁移昨日任务，会与 iCloud 或 Git 的启动同步
 *   互相踩踏产生新冲突（参考 pay-api app/note_vault/git_sync.py 的 DEBOUNCE_S = 15s）。
 * 背景 2: 冲突副本自身创建/最后编辑不足 15 秒时可能仍在 iCloud 下载中（占位/半成品），
 *   必须跳过合并，否则会重复 2026-08-19 的数据丢失事故（BUG.md）。
 * 运行: node test_startup_delay.js
 */

const fs = require('fs');
const path = require('path');

const root = __dirname;
const mainTs = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) return '';
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end === -1 ? undefined : end);
}

console.log('=== 1. 启动任务延迟调度（不阻塞启动） ===');
const layoutBlock = block(mainTs, 'this.app.workspace.onLayoutReady(() => {', '});');
check('onLayoutReady 代码块存在', layoutBlock.length > 0);
check('onLayoutReady 只做同步调度（initLeaf + schedule），不直接执行合并/迁移', !layoutBlock.includes('runStartupJournalTasks'));
check('侧边栏视图 initLeaf 仍立即初始化（不随 15 秒延迟）', layoutBlock.includes('this.initLeaf();'));

const scheduleBlock = block(mainTs, 'private scheduleStartupJournalTasks()', 'private async runStartupJournalTasks');
check('scheduleStartupJournalTasks 存在', scheduleBlock.length > 0);
check('两个开关都关闭时不调度（提前 return，零开销）', /if \(!this\.settings\.autoMergeIcloudConflictFiles && !this\.settings\.autoMigrateYesterdayTasks\)/.test(scheduleBlock));
const delayMatch = mainTs.match(/STARTUP_JOURNAL_TASKS_DELAY_MS = (\d[\d_]*)/);
check('启动延迟常量为 15000ms（同 pay-api DEBOUNCE_S）', delayMatch !== null && Number(delayMatch[1].replace(/_/g, '')) === 15000);
check('用 setTimeout 按常量延迟，不 await（不阻塞启动流程）', new RegExp('setTimeout[\\s\\S]{0,80}STARTUP_JOURNAL_TASKS_DELAY_MS').test(scheduleBlock));
check('延迟回调以 void 触发异步任务（fire-and-forget）', /setTimeout\(\(\) => \{\s*void this\.runStartupJournalTasks\(\);\s*\}/.test(scheduleBlock));
check('卸载时清理定时器（register + clearTimeout）', /this\.register\(\(\) => window\.clearTimeout\(timer\)\)/.test(scheduleBlock));

console.log('\n=== 2. 冲突文件新鲜度检查 ===');
const stableMatch = mainTs.match(/ICLOUD_CONFLICT_STABLE_MS = (\d[\d_]*)/);
check('稳定阈值常量为 15000ms', stableMatch !== null && Number(stableMatch[1].replace(/_/g, '')) === 15000);
const mergeBlock = block(mainTs, 'async mergeIcloudConflictFiles(', '\n  /** ');
check('mergeIcloudConflictFiles 存在', mergeBlock.length > 0);
check('按 max(ctime, mtime) 计算文件年龄（创建与最后编辑都取最新者）', /Date\.now\(\) - Math\.max\(child\.stat\.ctime, child\.stat\.mtime\)/.test(mergeBlock));
check('不足 15 秒的冲突文件跳过合并（continue）', new RegExp('ageMs < ICLOUD_CONFLICT_STABLE_MS[\\s\\S]{0,200}continue;').test(mergeBlock));
check('跳过时输出 console.warn 留痕', new RegExp('ageMs < ICLOUD_CONFLICT_STABLE_MS[\\s\\S]{0,400}console\\.warn').test(mergeBlock));
check('新鲜度检查在读取内容之前（不读半下载文件）', mergeBlock.indexOf('child.stat.ctime') < mergeBlock.indexOf('vault.read'));
check('空内容占位保护仍在（trim().length === 0 跳过）', /conflictContent\.trim\(\)\.length === 0/.test(mergeBlock));
check('全部冲突文件都太新时给出明确 Notice（不误报"未发现"）', /pendingSync > 0[\s\S]{0,120}刚同步的冲突文件/.test(mergeBlock));

console.log('\n=== 3. 任务内容与顺序 ===');
const runBlock = block(mainTs, 'private async runStartupJournalTasks(): Promise<void>', '\n  /** ');
check('runStartupJournalTasks 存在', runBlock.length > 0);
check('先合并 iCloud 冲突文件、后迁移昨日任务（合并优先）',
  runBlock.indexOf('mergeIcloudConflictFiles') !== -1 &&
  runBlock.indexOf('migrateYesterdayTasks') !== -1 &&
  runBlock.indexOf('mergeIcloudConflictFiles') < runBlock.indexOf('migrateYesterdayTasks'));
check('命令式手动触发不受影响（mergeIcloudConflictFiles 默认 showNotices 参数仍在）', /mergeIcloudConflictFiles\(showNotices = true\)/.test(mainTs));

console.log('\n=== 4. 用户可见文案 ===');
check('「迁移昨日任务」描述注明 15 秒延迟', /启动 15 秒后（等待 iCloud\/Git 同步稳定）自动将昨天日记/.test(mainTs));
check('「合并 iCloud 冲突文件」描述注明 15 秒延迟', /启动 15 秒后（等待 iCloud\/Git 同步稳定）在日记文件夹/.test(mainTs));

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
