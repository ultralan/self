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
    title
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
