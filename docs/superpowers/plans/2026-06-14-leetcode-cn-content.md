# 切换力扣中文站并展示题目内容 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将爬虫数据源从 leetcode.com 切换到 leetcode.cn，补全中文标题与中文题面，并在抽题卡片内可折叠展示完整题面，同时无损保留现有用户进度数据。

**Architecture:** 基于「中文站与国际站 questionFrontendId 一致」的事实，用现有 problems.json 的 182 个 slug 去中文站逐题拉取（GraphQL `question(titleSlug)`），回填中文 `translatedTitle` + `translatedContent`。纯函数（query 常量、字段映射、fallback 决策）抽到独立模块 `leetcode-cn.js` 并用 Node 内置 `node:test` 单测；HTTP 编排与前端渲染用集成验证。`id` 全程不变 → Supabase 数据天然兼容。

**Tech Stack:** Node.js v24（内置 `https`、`node:test`）、原生 HTML/CSS/JS、Supabase（不动）。

**对应 Spec:** [docs/superpowers/specs/2026-06-14-leetcode-cn-content-design.md](../specs/2026-06-14-leetcode-cn-content-design.md)

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `leetcode-cn.js` | 新建 | 中文站 GraphQL query 常量 + 字段映射纯函数（pickTitle / pickContent / parseQuestion）。无副作用，可单测 |
| `leetcode-cn.test.js` | 新建 | 上述纯函数的 node:test 单测 |
| `fetch-problems.js` | 改造 | 中文站映射补全编排：graphql()、fetchQuestionContent()、main()。删除国际站列表爬取代码 |
| `generate.js` | 不改 | 整体序列化，content 自动透传 |
| `problems.json` | 输出 | 每题加 `content` 字段，`title` 改中文，`id`/`slug`/`in` 不变 |
| `data.js` | 生成 | 由 generate.js 产出，含 content |
| `index.html` | 改造 | 外链 com→cn（4 处）+ 抽题卡片题面折叠区 + 题面 CSS |

**测试策略：** 项目无测试框架。用 Node 内置 `node:test`（v24 已确认可用）对 `leetcode-cn.js` 的纯函数写单测；HTTP 调用与前端渲染用集成/手工验证（跑爬虫看输出、浏览器看渲染）。不引入 vitest/jest，保持零依赖架构。

**提交约定：** 所有 commit message 以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾（用第二个 `-m` 传入）。

---

## Task 1: 创建 leetcode-cn.js 纯函数模块（TDD）

**Files:**
- Create: `leetcode-cn.test.js`
- Create: `leetcode-cn.js`

- [ ] **Step 1: 写失败测试**

创建 `leetcode-cn.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { QUESTION_DETAIL_QUERY, pickTitle, pickContent, parseQuestion } = require('./leetcode-cn');

test('QUESTION_DETAIL_QUERY 包含所需字段', () => {
  assert.ok(QUESTION_DETAIL_QUERY.includes('translatedTitle'));
  assert.ok(QUESTION_DETAIL_QUERY.includes('translatedContent'));
  assert.ok(QUESTION_DETAIL_QUERY.includes('content'));
  assert.ok(QUESTION_DETAIL_QUERY.includes('isPaidOnly'));
  assert.ok(QUESTION_DETAIL_QUERY.includes('titleSlug'));
});

test('pickTitle 优先返回中文译名', () => {
  const raw = { question: { translatedTitle: '两数之和', title: 'Two Sum' } };
  assert.strictEqual(pickTitle(raw), '两数之和');
});

test('pickTitle 无中文译名时回退英文标题', () => {
  const raw = { question: { translatedTitle: '', title: 'Two Sum' } };
  assert.strictEqual(pickTitle(raw), 'Two Sum');
});

test('pickTitle 响应缺失返回 null', () => {
  assert.strictEqual(pickTitle({}), null);
  assert.strictEqual(pickTitle({ question: null }), null);
});

test('pickContent 优先中文译题面', () => {
  const raw = { question: { translatedContent: '<p>中文</p>', content: '<p>en</p>' } };
  const r = pickContent(raw);
  assert.strictEqual(r.content, '<p>中文</p>');
  assert.strictEqual(r.reason, 'translated');
});

test('pickContent 无中文时回退英文原文', () => {
  const raw = { question: { translatedContent: '', content: '<p>en</p>' } };
  const r = pickContent(raw);
  assert.strictEqual(r.content, '<p>en</p>');
  assert.strictEqual(r.reason, 'fallback-en');
});

test('pickContent 付费题无题面', () => {
  const raw = { question: { translatedContent: null, content: null, isPaidOnly: true } };
  const r = pickContent(raw);
  assert.strictEqual(r.content, null);
  assert.strictEqual(r.reason, 'paid');
});

test('pickContent 完全无内容', () => {
  const raw = { question: { translatedContent: null, content: null, isPaidOnly: false } };
  const r = pickContent(raw);
  assert.strictEqual(r.content, null);
  assert.strictEqual(r.reason, 'empty');
});

test('parseQuestion 组合标题与题面', () => {
  const raw = { question: { translatedTitle: '两数之和', translatedContent: '<p>中文</p>', content: '<p>en</p>', isPaidOnly: false } };
  assert.deepStrictEqual(parseQuestion(raw), { title: '两数之和', content: '<p>中文</p>', reason: 'translated' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test leetcode-cn.test.js`
Expected: FAIL，报错 `Cannot find module './leetcode-cn'`（模块尚未创建）。

- [ ] **Step 3: 写实现**

创建 `leetcode-cn.js`：

```js
/**
 * leetcode.cn 题目数据纯函数模块
 * 职责：GraphQL query 常量 + 响应字段映射 + fallback 决策
 * 无副作用，可单元测试。
 */

// 中文站题目详情 query：取中文译名、中文题面、英文原文（fallback）、付费标记
const QUESTION_DETAIL_QUERY = `
query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionFrontendId
    translatedTitle
    translatedContent
    content
    isPaidOnly
  }
}
`;

// 从 GraphQL 响应提取标题：优先中文译名，缺失回退英文 title
function pickTitle(raw) {
  const q = raw && raw.question;
  if (!q) return null;
  return q.translatedTitle || q.title || null;
}

// 决定使用哪个题面：优先中文翻译，回退英文原文，付费/空则标记原因
function pickContent(raw) {
  const q = raw && raw.question;
  if (!q) return { content: null, reason: 'missing' };
  if (q.translatedContent) return { content: q.translatedContent, reason: 'translated' };
  if (q.content) return { content: q.content, reason: 'fallback-en' };
  if (q.isPaidOnly) return { content: null, reason: 'paid' };
  return { content: null, reason: 'empty' };
}

// 把 GraphQL 响应映射为 { title, content, reason }
function parseQuestion(raw) {
  const title = pickTitle(raw);
  const { content, reason } = pickContent(raw);
  return { title, content, reason };
}

module.exports = { QUESTION_DETAIL_QUERY, pickTitle, pickContent, parseQuestion };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test leetcode-cn.test.js`
Expected: PASS，9 个测试全部通过（`tests 9` / `pass 9`）。

- [ ] **Step 5: 提交**

```bash
git add leetcode-cn.js leetcode-cn.test.js
git commit -m "feat: 新增 leetcode.cn 题面映射纯函数模块及单测" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 改造 fetch-problems.js 为中文站映射器

**Files:**
- Modify: `fetch-problems.js`（整体重写）

- [ ] **Step 1: 重写 fetch-problems.js**

将 `fetch-problems.js` 全文替换为：

```js
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
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message} | status=${res.statusCode} | body=${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
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
      return parseQuestion(raw);
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
    if (content) p.content = content;
    if (!content) failures.push({ id: p.id, slug: p.slug, reason });
    console.log(`[${i + 1}/${targets.length}] #${p.id} ${p.slug} → ${content ? 'OK' : 'FAIL(' + reason + ')'}`);
    await sleep(300); // 限速，避免触发 429
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
```

- [ ] **Step 2: 小批量验证（爬前 3 题）**

Run: `node fetch-problems.js 3`
Expected: 输出 3 行，形如：
```
[1/3] #1 two-sum → OK
[2/3] #2 add-two-numbers → OK
[3/3] #15 3sum → OK
...
失败 0 题：
```
（题号 / slug 以实际为准，关键是 3 行均 `→ OK`、失败 0 题。）

- [ ] **Step 3: 校验 problems.json 前 3 题被正确回填**

Run:
```bash
node -e "const d=require('./problems.json'); console.log(JSON.stringify(d.problems.slice(0,3).map(x=>({id:x.id,title:x.title,slug:x.slug,hasContent:!!x.content})),null,2))"
```
Expected: 前 3 题 `title` 为中文（如"两数之和"），`hasContent: true`，`slug` 不变。

- [ ] **Step 4: 恢复 problems.json（小批量结果不保留，全量留到 Task 3）**

Run: `git checkout -- problems.json`
Expected: 无输出，problems.json 恢复到原始状态（英文标题、无 content）。用 `git status` 确认 problems.json 不在改动列表。

- [ ] **Step 5: 提交（仅代码，不含 problems.json）**

```bash
git add fetch-problems.js
git commit -m "feat: 爬虫切换 leetcode.cn 并按 slug 映射补全中文题面" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 全量爬取 + 生成 data.js

**Files:**
- Modify: `problems.json`（爬虫输出）
- Modify: `data.js`（generate.js 产出）

- [ ] **Step 1: 全量爬取**

Run: `node fetch-problems.js`
Expected: 跑完 182 题（约 1 分钟，含限速），结尾输出"失败 N 题"。N 应为 0 或极少数（付费题）。记下失败题号（若有）。

- [ ] **Step 2: 校验 problems.json 完整性**

Run:
```bash
node -e "
const d=require('./problems.json');
const ps=d.problems;
console.log('题数:', ps.length);
console.log('有题面:', ps.filter(p=>p.content).length);
console.log('无题面:', ps.filter(p=>!p.content).map(p=>'#'+p.id+' '+p.slug));
console.log('前5题标题:', ps.slice(0,5).map(p=>p.title));
"
```
Expected:
- `题数: 182`
- `有题面:` 接近 182（无题面数应与 Step 1 的失败数一致）
- `前5题标题:` 全中文（如 `两数之和 / 两数相加 / ...`）

- [ ] **Step 3: 校验 id/slug 与原始数据一致（未发生错位）**

Run:
```bash
node -e "
const cur=require('./problems.json').problems;
const execSync=require('child_process').execSync;
const old=JSON.parse(execSync('git show HEAD:problems.json')).problems;
const om=new Map(old.map(p=>[p.id,p.slug]));
let bad=0;
for(const p of cur){ if(om.get(p.id)!==p.slug){bad++; console.log('不一致:',p.id);} }
console.log('id/slug 一致性:', bad===0?'OK ✅':'BAD('+bad+')');
console.log('题数一致:', old.length===cur.length?'OK ✅':'BAD');
"
```
Expected: `id/slug 一致性: OK ✅` 且 `题数一致: OK ✅`。

> 注意：此校验对比的是 `HEAD:problems.json`。Task 2 的提交未改动 problems.json，故 HEAD 仍是原始数据，对比有效。

- [ ] **Step 4: 重新生成 data.js**

Run: `node generate.js`
Expected: 输出 `Generated data.js`。

- [ ] **Step 5: 校验 data.js 含 content**

Run: `grep -c '"content"' data.js`
Expected: ≥ 182（每题一个 content 字段；接近 182 即可，失败题可能没有）。

- [ ] **Step 6: 提交**

```bash
git add problems.json data.js
git commit -m "feat: 补全中文标题与题面数据（leetcode.cn）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 前端外链切换到 leetcode.cn

**Files:**
- Modify: `index.html`（第 1051 / 1237 / 1916 / 2076 行）

- [ ] **Step 1: 全局替换外链域名**

Run:
```bash
sed -i '' 's|https://leetcode.com/problems/|https://leetcode.cn/problems/|g' index.html
```
Expected: 无输出。该命令将 4 处 `leetcode.com/problems/` 替换为 `leetcode.cn/problems/`。

- [ ] **Step 2: 确认替换干净**

Run:
```bash
echo "残留 com: $(grep -c 'leetcode.com/problems' index.html)"
echo "已有 cn: $(grep -c 'leetcode.cn/problems' index.html)"
```
Expected:
```
残留 com: 0
已有 cn: 4
```

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: 前端外链切换到 leetcode.cn" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 抽题卡片题面折叠展示

**Files:**
- Modify: `index.html`（`renderPickerProblem` 函数 + `<style>` 块）

- [ ] **Step 1: 在 renderPickerProblem 中插入题面折叠区**

定位 `renderPickerProblem` 函数（约第 1035 行起）。将其中的 `card.innerHTML = ...` 块：

```js
  card.innerHTML = `
    <div class="problem-id">#${problem.id}</div>
    <div class="problem-title">${problem.title}</div>
    <div class="problem-tags">${tags} ${tagBadges} ${badge}</div>
    <a class="open-lc" href="${lcUrl}" target="_blank">↗ 在 LeetCode 上打开</a>
  `;
```

替换为（在 `.problem-tags` 与 `.open-lc` 之间插入 `<details>` 折叠区）：

```js
  const contentHtml = problem.content
    ? problem.content
    : '<p class="content-empty">暂无题面（付费题或爬取失败）</p>';
  card.innerHTML = `
    <div class="problem-id">#${problem.id}</div>
    <div class="problem-title">${problem.title}</div>
    <div class="problem-tags">${tags} ${tagBadges} ${badge}</div>
    <details class="problem-content-wrap">
      <summary>查看题面</summary>
      <div class="problem-content">${contentHtml}</div>
    </details>
    <a class="open-lc" href="${lcUrl}" target="_blank">↗ 在 LeetCode 上打开</a>
  `;
```

- [ ] **Step 2: 追加题面专用 CSS**

定位 `index.html` 中现有的 `<style>` 块结束标签 `</style>`（`grep -n '</style>' index.html` 找到行号），在其**之前**插入以下 CSS：

```css
  /* ===== 题面折叠展示（力扣 HTML 适配） ===== */
  .problem-content-wrap { margin-top: 12px; border-top: 1px solid #e5e7eb; padding-top: 10px; }
  .problem-content-wrap summary {
    cursor: pointer; font-size: 14px; color: #6b7280;
    user-select: none; list-style: none;
  }
  .problem-content-wrap summary::-webkit-details-marker { display: none; }
  .problem-content-wrap summary::before { content: "▸ "; }
  .problem-content-wrap[open] summary::before { content: "▾ "; }
  .problem-content-wrap summary:hover { color: #2563eb; }
  .problem-content {
    max-height: 60vh; overflow: auto; padding: 12px; margin-top: 8px;
    background: #f9fafb; border-radius: 8px; font-size: 14px; line-height: 1.7;
    word-break: break-word;
  }
  .problem-content p { margin: 8px 0; }
  .problem-content pre {
    background: #1f2937; color: #e5e7eb; padding: 10px; border-radius: 6px;
    overflow-x: auto; font-size: 13px; margin: 8px 0;
  }
  .problem-content code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .problem-content pre code { background: none; padding: 0; color: inherit; }
  .problem-content :not(pre) > code {
    background: #e5e7eb; padding: 1px 4px; border-radius: 3px; font-size: 13px;
  }
  .problem-content ul, .problem-content ol { padding-left: 24px; margin: 8px 0; }
  .problem-content li { margin: 2px 0; }
  .problem-content sup { font-size: 0.75em; vertical-align: super; }
  .problem-content img { max-width: 100%; }
  .problem-content .content-empty { color: #9ca3af; font-style: italic; }
```

- [ ] **Step 3: 本地起服务并浏览器验证**

Run: `python3 -m http.server 8000`
然后浏览器打开 `http://localhost:8000`（验证完毕按 Ctrl+C 停止服务）。

验证清单（人工确认）：
- 抽题（点"随机抽题"）：标题显示中文。
- 点"查看题面"：折叠区展开，题面（描述/示例/约束）渲染正常、可读。
- 代码块（`<pre>`）深色底、可横向滚动。
- 长题面：题面区限高滚动，不撑破布局。
- 再次点 summary：折叠收起。
- "↗ 在 LeetCode 上打开"链接指向 `leetcode.cn/problems/<slug>/`。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: 抽题卡片可折叠展示中文题面" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 最终验收（对照 Spec）

- [ ] **Step 1: 逐项核对 Spec 验收标准**

对照 [Spec 第 8 节](../specs/2026-06-14-leetcode-cn-content-design.md#8-验收标准)，确认：

1. ✅ 爬虫切换到 leetcode.cn，无 cookie 纯 HTTP 运行成功（Task 3 Step 1 跑通）。
2. ✅ problems.json / data.js 每题含中文 `title` + 中文 `content`（Task 3 Step 2 校验）。
3. ✅ `id` 不变，Supabase 用户进度数据无影响（Task 3 Step 3 校验；schema 未改）。
4. ✅ 抽题卡片可折叠展示中文题面，样式可读，外链指向 leetcode.cn（Task 5 Step 3 验证）。
5. ✅ 失败题有明确日志，不中断整体流程（Task 3 Step 1 末尾失败汇总）。

- [ ] **Step 2: 确认工作区干净**

Run: `git status`
Expected: `nothing to commit, working tree clean`（TODO.md 若有改动属本任务范围外，不处理）。

---

## Self-Review 记录

（写计划后自审，已修正）

- **Spec 覆盖**：Spec 各节均有对应 Task —— 爬虫（Task 1+2）、数据结构（Task 3）、generate 透传（Task 3 Step 4）、前端外链（Task 4）、前端折叠+CSS（Task 5）、schema/config 不改（计划中明确未列入改动）、迁移与数据保留（Task 3 Step 3 校验 id 一致）、风险兜底（Task 2 重试/429/fallback、Task 5 content-empty 兜底）。✅
- **Placeholder 扫描**：无 TBD/TODO，所有 step 含实际代码或确切命令。✅
- **类型/命名一致性**：`pickTitle` / `pickContent` / `parseQuestion` / `QUESTION_DETAIL_QUERY` / `fetchQuestionContent` 在各 Task 中命名一致；返回结构 `{ title, content, reason }` 统一。✅
