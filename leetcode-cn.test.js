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

test('pickContent 响应缺失返回 missing', () => {
  assert.deepStrictEqual(pickContent({}), { content: null, reason: 'missing' });
  assert.deepStrictEqual(pickContent({ question: null }), { content: null, reason: 'missing' });
});

test('parseQuestion 组合标题与题面', () => {
  const raw = { question: { translatedTitle: '两数之和', translatedContent: '<p>中文</p>', content: '<p>en</p>', isPaidOnly: false } };
  assert.deepStrictEqual(parseQuestion(raw), { title: '两数之和', content: '<p>中文</p>', reason: 'translated' });
});
