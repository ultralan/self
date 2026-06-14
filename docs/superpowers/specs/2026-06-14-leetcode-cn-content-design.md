# 设计文档：切换力扣中文站并展示题目内容

- 日期：2026-06-14
- 状态：已批准，待实现
- 分支：leetcode

## 1. 背景与目标

### 1.1 背景

leetcode-picker 是一个纯静态（GitHub Pages）的力扣抽题工具，无自有后端，用户数据存于 Supabase。当前：

- 爬虫 [fetch-problems.js](../../../fetch-problems.js) 爬取 **leetcode.com（国际站）**，域名硬编码在第 13/22/23 行。
- 每题仅保存 4 个字段：`id` / `title`(英文) / `slug` / `in`（来源）。
- **完全没有题面内容**，看题必须点外链跳转到 leetcode.com。

### 1.2 目标

1. 数据源切换到 **leetcode.cn（中文站）**，全中文（标题 + 题面）。
2. 抽题卡片内**可折叠展示完整中文题面**，无需跳转外站即可读题。
3. 平滑迁移：现有用户进度数据（completed / picked_ids / problem_tags）**无损保留**。

### 1.3 非目标（YAGNI）

明确不做，避免范围蔓延：

- 不新增难度（difficulty）/ 标签（topicTags）/ 代码模板（codeSnippets）字段。
- 题库列表（list 面板）不展开题面，保持简洁。
- 不引入定时任务，爬虫仍手动触发。
- 不做"题面单独 JSON 按需加载"——题面直接打进 data.js。

## 2. 关键决策（已与用户确认）

| 维度 | 决策 |
|---|---|
| 题面范围 | 完整题面（描述 + 示例 + 约束 + 提示），即力扣 `translatedContent` 一整块 HTML |
| 展示形态 | 抽题卡片内可折叠，默认收起，点击展开 |
| 语言 | 全中文：标题用 `translatedTitle`，题面用 `translatedContent` |
| 迁移策略 | **ID 映射而非重爬**：用现有 problems.json 的 182 个 slug 去中文站逐题拉取，回填中文数据 |
| 题面存储 | 打进 data.js（与现有元数据一起） |
| 列表面板 | 保持现状，不展开题面 |

## 3. 技术可行性（已实测）

对 `https://leetcode.cn/graphql` 发起纯 HTTP POST（无 cookie），`question(titleSlug)` 查询返回：

- `translatedTitle`：中文标题（如"两数之和"）✓
- `translatedContent`：完整中文题面 HTML（含 `<pre>` 示例、约束列表等）✓
- `content`：**英文原文**（坑点）——仅当 `translatedContent` 为空时作为 fallback
- `isPaidOnly`：付费题标记，用于跳过/标记无题面的付费题

结论：方案完全可行，无需 cookie / API key / 无头浏览器。

## 4. 详细设计

### 4.1 爬虫改造（[fetch-problems.js](../../../fetch-problems.js)）

将 `main()` 从"重爬列表"模式改为"中文站映射补全"模式。

**改动清单：**

1. **域名**：`graphql()` 函数（第 13/22/23 行）`leetcode.com` → `leetcode.cn`。

2. **删除国际站列表爬取代码**：`PROBLEMSET_QUERY`、`STUDY_PLAN_QUERY`、`fetchByListId`、`fetchStudyPlan`。这些是国际站列表逻辑，使命已完成（problems.json 已含完整 182 题 slug），保留即为死代码；git 历史可恢复。

3. **新增题目详情 query**：

   ```graphql
   query questionData($titleSlug: String!) {
     question(titleSlug: $titleSlug) {
       questionFrontendId
       translatedTitle
       translatedContent
       content
       isPaidOnly
     }
   }
   ```

4. **新增 `fetchQuestionContent(slug)` 函数**：调用上述 query，返回 `{ title, content, paid }`。
   - 中文标题：`translatedTitle`（为空则回退 `title` 原文）。
   - 中文题面：`translatedContent`（为空则 fallback `content`；两者皆空记为付费/异常）。

5. **`main()` 新流程**：
   - 读取现有 `problems.json` 的 `problems` 数组（slug 来源）。
   - 遍历每题，调用 `fetchQuestionContent(p.slug)`。
   - 回填：`title` ← 中文标题，新增 `content` ← 中文题面 HTML。
   - **限速**：每题间隔 ~300ms。
   - **重试**：网络/解析失败重试最多 2 次，间隔递增（1s → 2s）；HTTP 429 等待 5s 后重试。
   - **兜底**：最终失败的题保留原英文 `title`、`content` 置空，并打印到失败日志（不中断整批）。
   - 写回 `problems.json`，**`id` / `slug` / `in` 保持不变**。

6. **输出格式**：problems.json 每题新增 `content` 字段，结构见 4.2。

### 4.2 数据结构

`problems.json` 与 `data.js` 中每题：

```js
{
  id: 1,                       // 不变 → 用户数据保留
  title: "两数之和",            // Two Sum → translatedTitle（中文）
  slug: "two-sum",             // 不变（两站一致，外链用）
  in: ["Top 100", "Top 150"],  // 不变
  content: "<p>给定一个整数数组 nums ...</p>"  // 新增：中文题面 HTML
}
```

`meta` 字段维持现状不变；爬取失败的 slug 在结束时汇总打印到控制台，不写入 problems.json（保持文件干净）。

### 4.3 数据打包（[generate.js](../../../generate.js)）

**无需改动**。第 13 行 `JSON.stringify(data.problems)` 整体序列化，`content` 字段自动透传进 `data.js`。

### 4.4 前端展示（[index.html](../../../index.html)）

1. **外链域名**：4 处 `https://leetcode.com/problems/${slug}/` → `https://leetcode.cn/problems/${slug}/`（第 1051/1237/1916/2076 行）。

2. **抽题卡片**（`renderPickerProblem`，第 1035-1063 行）：
   - 标题自动变中文（`title` 已是中文）。
   - 新增**「▸ 查看题面 / ▾ 收起」折叠区**，默认收起。
   - 展开时将 `problem.content` 渲染到题面容器（`innerHTML`）。
   - 题面区**限高（约 60vh）+ `overflow:auto` 滚动**，避免长题面撑爆布局。
   - 新增**题面基础 CSS**：力扣题面 HTML 脱离其站内样式会塌，需为 `<pre>` / `<code>` / `<strong class="example">` / `<ul><li>` / `<sup>` 等补充轻量样式（等宽字体、示例块底色、列表缩进）。样式限定在题面容器作用域内，不影响页面其他部分。

3. **题库列表**（`refreshList`，第 1227-1244 行）：保持现状，仅标题/标签，不展开题面。

### 4.5 数据库与配置

- **schema.sql 不改动**。题目数据不进数据库，Supabase 只存用户状态（按 `problem_id` 关联）。
- **config.js 不改动**。无 cookie / API key，无需新增力扣配置项。

## 5. 迁移与数据保留

- **本次改动不触碰 Supabase**：schema、数据均不动。
- **id 全程不变** → 现有 `completed` / `picked_ids` / `problem_tags` 自然指向同一批题，仅展示标题由英文变中文，进度数据完整保留。
- 用户提到"现有数据库能否恢复"：进度数据保留与否取决于 Supabase 当前状态，与本功能无关。只要数据还在，id 不变即天然兼容；若已被清空，属数据层独立问题，不在本次范围。

## 6. 风险与兜底

| 风险 | 兜底 |
|---|---|
| 个别题中文站 slug 与国际站不同 / 已下架 | 爬虫对该题重试失败后记入失败日志，保留原英文 title、content 置空，不中断整批 |
| `translatedContent` 为空（无中文翻译 / 付费题） | fallback 到 `content`（英文原文）；仍空则标记并跳过 |
| 触发 429 限流 | 限速 300ms/题 + 429 退避 5s 重试 |
| 题面 HTML 含恶意脚本 | 题面来自力扣官方，本身不含 `<script>`；本轮不做额外脚本过滤，仅用 `innerHTML` 插入题面容器渲染。若未来数据源扩展，再加过滤 |
| data.js 体积增长 | 182 题题面约 1–1.5MB（gzip 后 200–400KB），GitHub Pages 默认启用 gzip，个人工具可接受 |

## 7. 测试策略

- **爬虫层**：运行 `node fetch-problems.js` 后校验
  - 182 题全部有 `content`（非空），`title` 为中文。
  - 失败日志为空或仅含已知异常题（如付费题）。
  - `id` / `slug` / `in` 与原 problems.json 逐项一致（无丢失、无错位）。
- **打包层**：`node generate.js` 后确认 data.js 含 content 字段。
- **前端层**：本地打开 index.html，抽查 3–5 道题（含长题面、含示例代码块的题）：
  - 标题显示中文。
  - 折叠/展开交互正常。
  - 题面渲染样式正常（示例、约束、代码块可读）。
  - 外链跳转 leetcode.cn 正确。

## 8. 验收标准

1. 爬虫切换到 leetcode.cn，无 cookie 纯 HTTP 运行成功。
2. problems.json / data.js 每题含中文 `title` + 中文 `content`。
3. `id` 不变，Supabase 用户进度数据无影响。
4. 抽题卡片可折叠展示中文题面，样式可读，外链指向 leetcode.cn。
5. 失败题有明确日志，不中断整体流程。

## 9. 执行步骤（概览，详细计划由 writing-plans 产出）

1. 改造 fetch-problems.js（域名、query、main 流程、限速重试兜底）。
2. 运行爬虫，校验 problems.json。
3. 运行 generate.js，确认 data.js。
4. 改造 index.html（外链、折叠区、题面 CSS）。
5. 本地验证 + 提交。
