#!/usr/bin/env node

/**
 * LeetCode 中文站题面补全器
 *
 * 读取现有 problems.json（含 id/slug/in），用 slug 去 leetcode.cn
 * 逐题拉取中文标题与中文题面，回填后写回 problems.json。
 * id 不变 → Supabase 用户进度数据无损保留。
 *
 * 用法：
 *   node fetch-problems.js        # 全量爬取
 *   node fetch-problems.js 3      # 仅爬前 3 题（验证用）
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { QUESTION_DETAIL_QUERY, parseQuestion } = require('./leetcode-cn');

function graphql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables });
    const url = new URL('https://leetcode.cn/graphql');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://leetcode.cn/problemset/',
        'Origin': 'https://leetcode.cn',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('RATE_LIMITED'));
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message} | status=${res.statusCode} | body=${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拉取单题中文标题与题面，带重试与 429 退避
async function fetchQuestionContent(slug, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await graphql(QUESTION_DETAIL_QUERY, { titleSlug: slug });
      // leetcode.cn 返回 { data: { question: {...} } }，parseQuestion 接收 { question } 这一层
      return parseQuestion(raw && raw.data);
    } catch (e) {
      if (e.message === 'RATE_LIMITED') {
        await sleep(5000); // 429 退避
        continue;
      }
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1)); // 普通错误递增重试
        continue;
      }
      return { title: null, content: null, reason: 'error:' + e.message };
    }
  }
  return { title: null, content: null, reason: 'exhausted' };
}

async function main() {
  const problemsPath = path.join(__dirname, 'problems.json');
  const data = JSON.parse(fs.readFileSync(problemsPath, 'utf-8'));
  const problems = data.problems;

  const limitArg = parseInt(process.argv[2], 10);
  const targets = limitArg > 0 ? problems.slice(0, limitArg) : problems;

  console.log(`=== LeetCode 中文站题面补全 ===`);
  console.log(`目标 ${targets.length} / 共 ${problems.length} 题\n`);

  const failures = [];
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    const { title, content, reason } = await fetchQuestionContent(p.slug);
    if (title) p.title = title;
    if (content) p.content = content.replace(/assets\.leetcode\.com/g, 'assets.leetcode.cn');
    if (!content) failures.push({ id: p.id, slug: p.slug, reason });
    console.log(`[${i + 1}/${targets.length}] #${p.id} ${p.slug} → ${content ? 'OK' : 'FAIL(' + reason + ')'}`);
    if (i < targets.length - 1) await sleep(300); // 限速，避免触发 429（末题后不必等待）
  }

  // 写回完整 data（含 meta），仅 problems 内的 title/content 被更新
  fs.writeFileSync(problemsPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n已写回 ${problemsPath}`);
  console.log(`失败 ${failures.length} 题：`);
  failures.forEach((f) => console.log(`  #${f.id} ${f.slug}: ${f.reason}`));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
