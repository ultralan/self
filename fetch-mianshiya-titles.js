#!/usr/bin/env node
/** 拉取公开题库目录，仅保留题目标题、标签与来源链接。 */
const fs = require('fs');
const path = require('path');

const endpoint = 'https://api.mianshiya.com/api/question_bank/list_question';
const banks = [
  { id: '1906189461556076546', label: '面试鸭 AI' },
  { id: '1860871861809897474', label: '面试鸭 Java' },
];

async function fetchPage(questionBankId, current) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.mianshiya.com',
      referer: `https://www.mianshiya.com/bank/${questionBankId}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ questionBankId, pageSize: 200, current }),
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(payload.message || `请求失败：${response.status}`);
  return payload.data;
}

async function main() {
  const problems = [];
  for (const bank of banks) {
    const first = await fetchPage(bank.id, 1);
    const records = [...(first.records || [])];
    for (let current = 2; current <= Number(first.pages || 1); current += 1) {
      records.push(...((await fetchPage(bank.id, current)).records || []));
    }
    for (const item of records) {
      problems.push({
        id: -(1000000 + problems.length),
        title: item.title,
        in: [bank.label],
        tags: item.tagList || [],
        sourceUrl: `https://www.mianshiya.com/bank/${bank.id}/question/${item.id}`,
      });
    }
  }
  const dataset = {
    sources: banks.map((bank) => ({ name: bank.label, url: `https://www.mianshiya.com/bank/${bank.id}` })),
    total: problems.length,
    problems,
  };
  fs.writeFileSync(path.join(__dirname, 'mianshiya-problems.json'), `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  const output = [
    '// 由 fetch-mianshiya-titles.js 自动生成，仅包含公开题目目录。',
    `const MIANSHIYA_PROBLEMS = ${JSON.stringify(dataset.problems)};`,
    `const MIANSHIYA_META = ${JSON.stringify({ sources: dataset.sources, total: dataset.total })};`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'mianshiya-data.js'), output, 'utf8');
  console.log(`已写入 ${problems.length} 道题目标题与标签`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
