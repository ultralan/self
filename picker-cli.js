#!/usr/bin/env node

/**
 * LeetCode 抽题器 CLI 版
 *
 * Usage:
 *   node picker-cli.js              # 从全部 182 题中随机抽 1 道
 *   node picker-cli.js 5            # 随机抽 5 道
 *   node picker-cli.js --top100     # 只从 Top 100 抽
 *   node picker-cli.js --top150 3   # 从 Top 150 抽 3 道
 *   node picker-cli.js --both       # 只从重叠题库抽
 *   node picker-cli.js --list       # 列出所有题目
 */

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'problems.json'), 'utf-8'));
const allProblems = data.problems;

function filterProblems(filter) {
  switch (filter) {
    case 'top100': return allProblems.filter(p => p.in.includes('Top 100'));
    case 'top150': return allProblems.filter(p => p.in.includes('Top 150'));
    case 'both':   return allProblems.filter(p => p.in.length > 1);
    default:       return allProblems;
  }
}

function pickRandom(list, count) {
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, list.length));
}

function printProblems(problems) {
  if (problems.length === 0) {
    console.log('没有符合条件的题目。');
    return;
  }
  problems.forEach((p, i) => {
    const tags = p.in.map(t => t === 'Top 100' ? '100' : '150').join('/');
    const num = problems.length > 1 ? `${String(i + 1).padStart(2, ' ')}. ` : '';
    console.log(`${num}#${String(p.id).padStart(4, ' ')} ${p.title} [${tags}]`);
  });
}

function printStats(filter) {
  const filtered = filterProblems(filter);
  const top100 = filterProblems('top100');
  const top150 = filterProblems('top150');
  const both = filterProblems('both');

  console.log('\n📊 题库统计');
  console.log('─'.repeat(30));
  console.log(`  全部题目:  ${allProblems.length}`);
  console.log(`  Top 100:   ${top100.length}`);
  console.log(`  Top 150:   ${top150.length}`);
  console.log(`  重叠部分:  ${both.length}`);
  console.log('─'.repeat(30));
  if (filter !== 'all') {
    console.log(`  当前筛选:  ${filter} (${filtered.length} 题)`);
  }
}

// Parse args
const args = process.argv.slice(2);
const isList = args.includes('--list');
const isStats = args.includes('--stats') || args.includes('-s');
let filter = 'all';
let count = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--top100') { filter = 'top100'; continue; }
  if (args[i] === '--top150') { filter = 'top150'; continue; }
  if (args[i] === '--both')   { filter = 'both'; continue; }
  if (args[i] === '--list' || args[i] === '--stats' || args[i] === '-s') continue;
  const n = parseInt(args[i], 10);
  if (!isNaN(n)) count = n;
}

const filtered = filterProblems(filter);

if (isList) {
  printStats(filter);
  console.log('\n📋 题目列表:');
  printProblems(filtered);
} else if (isStats) {
  printStats(filter);
} else {
  const picked = pickRandom(filtered, count);
  console.log('');
  if (count > 1) {
    console.log(`🎯 抽出 ${picked.length} 道题 (${filter === 'all' ? '全部' : filter} 题库):\n`);
  } else {
    console.log('🎯 抽到:\n');
  }
  printProblems(picked);
  console.log('');
}
