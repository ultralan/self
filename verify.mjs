#!/usr/bin/env node
/**
 * 本地验证：JSON 导入规范化、导出 v2 结构、关键文件存在
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = process.argv[2] || path.join(process.env.HOME, 'Downloads/leetcode-data-2026-06-07.json');

function normalizeTagDef(tag) {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color || '#f97316',
    noteMd: tag.noteMd || tag.note_md || '',
    noteUpdatedAt: tag.noteUpdatedAt || tag.note_updated_at || null,
  };
}

function importFromJson(data) {
  const tagDefs = {};
  if (data.lcTagDefs) {
    for (const [id, t] of Object.entries(data.lcTagDefs)) {
      tagDefs[id] = normalizeTagDef({ ...t, id });
    }
  }
  return {
    picked: data.lcPickedIds || [],
    completed: data.lcCompleted || {},
    tagDefs,
    problemTags: data.lcProblemTags || {},
  };
}

function exportToJson(state) {
  return {
    version: 2,
    lcPickedIds: state.picked,
    lcCompleted: state.completed,
    lcTagDefs: state.tagDefs,
    lcProblemTags: state.problemTags,
  };
}

const requiredFiles = [
  'schema.sql',
  'sync-db.js',
  'store.js',
  'config.example.js',
  '.gitignore',
  'index.html',
  '.github/workflows/supabase-heartbeat.yml',
  '.github/workflows/deploy-pages.yml',
];

let ok = true;
for (const f of requiredFiles) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) {
    console.error('MISSING:', f);
    ok = false;
  }
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
for (const needle of ['sync-db.js', 'store.js', 'panel-notes', 'createStore', 'exportFreshOrCachedJson', 'importFromJson', 'deleteTag']) {
  if (!indexHtml.includes(needle)) {
    console.error('index.html missing:', needle);
    ok = false;
  }
}
const inlineScripts = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .join('\n');
try {
  execSync('node --check --input-type=commonjs -', { input: inlineScripts, stdio: ['pipe', 'pipe', 'pipe'] });
} catch {
  console.error('index.html inline script syntax error');
  ok = false;
}

const layoutNeedles = [
  'height: 100dvh',
  'overflow: hidden',
  '.app-body',
  'min-height: 0',
  'height: 100%',
  '.problem-list-scroll',
  'overflow-y: auto',
];
for (const needle of layoutNeedles) {
  if (!indexHtml.includes(needle)) {
    console.error('single-screen layout missing:', needle);
    ok = false;
  }
}

const todoUiNeedles = [
  'id="pickerProgressFill"',
  'id="pickerProgressText"',
  'class="toolbar-status"',
  'let noteViewMode = \'preview\'',
  '#notesContainer',
  'id="snapshotList"',
  'renderSnapshotList',
];
for (const needle of todoUiNeedles) {
  if (!indexHtml.includes(needle)) {
    console.error('TODO UI missing:', needle);
    ok = false;
  }
}
if (indexHtml.includes('data-tab="heatmap"')) {
  console.error('heatmap should be migrated out of tabs');
  ok = false;
}
const pickerPanelStart = indexHtml.indexOf('id="panel-picker"');
const listPanelStart = indexHtml.indexOf('id="panel-list"');
const heatmapContainerAt = indexHtml.indexOf('id="heatmapContainer"');
if (pickerPanelStart === -1 || listPanelStart === -1 || heatmapContainerAt < pickerPanelStart || heatmapContainerAt > listPanelStart) {
  console.error('heatmap should render inside picker panel');
  ok = false;
}
const toolbarStart = indexHtml.indexOf('class="app-toolbar"');
const toolbarEnd = indexHtml.indexOf('<div class="app-body">');
const syncBarAt = indexHtml.indexOf('id="syncBar"');
if (toolbarStart === -1 || toolbarEnd === -1 || syncBarAt < toolbarStart || syncBarAt > toolbarEnd) {
  console.error('sync status should live in the top toolbar');
  ok = false;
}

const syncDbJs = fs.readFileSync(path.join(__dirname, 'sync-db.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');
for (const needle of ['createSyncDB', 'fetchCloud', 'persistCache', 'exportFreshOrCachedJson', 'deleteTag', 'rawMeta.cacheFallback']) {
  if (!syncDbJs.includes(needle)) {
    console.error('sync-db.js missing:', needle);
    ok = false;
  }
}
for (const forbidden of ['localRev', 'syncedRev', 'hasLocalChanges', 'async function push', 'pendingOps']) {
  if (syncDbJs.includes(forbidden)) {
    console.error('sync-db.js should not contain old local-sync marker:', forbidden);
    ok = false;
  }
}
for (const forbidden of ['async saveProblemTags', 'exportToJson()', 'flushSync:']) {
  if (syncDbJs.includes(forbidden)) {
    console.error('sync-db.js should not expose old sync API:', forbidden);
    ok = false;
  }
}
for (const forbidden of ['saveProblemTags', 'exportToJson', 'flushSync']) {
  if (storeJs.includes(forbidden)) {
    console.error('store.js should not expose old sync API:', forbidden);
    ok = false;
  }
}
for (const needle of ['exportFreshOrCachedJson', 'cacheFallback']) {
  if (!indexHtml.includes(needle) && !syncDbJs.includes(needle) && !storeJs.includes(needle)) {
    console.error('cloud-first export missing:', needle);
    ok = false;
  }
}
for (const needle of ['SNAPSHOT_LIMIT', 'persistSnapshotRecord', 'getSnapshotRecords', 'exportCachedSnapshot']) {
  if (!syncDbJs.includes(needle) && !storeJs.includes(needle)) {
    console.error('snapshot cache strategy missing:', needle);
    ok = false;
  }
}
try {
  execSync('node --check sync-db.js', { cwd: __dirname, stdio: 'pipe' });
  execSync('node --check store.js', { cwd: __dirname, stdio: 'pipe' });
} catch {
  console.error('sync-db/store syntax error');
  ok = false;
}

if (!fs.existsSync(jsonPath)) {
  console.warn('SKIP json test — file not found:', jsonPath);
} else {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const state = importFromJson(data);
  const exported = exportToJson(state);

  if (Object.keys(state.tagDefs).length !== 3) {
    console.error('Expected 3 tags, got', Object.keys(state.tagDefs).length);
    ok = false;
  }
  if (!state.tagDefs.t1780370078082_27c4 || state.tagDefs.t1780370078082_27c4.name !== 'dfs') {
    console.error('dfs tag mismatch');
    ok = false;
  }
  if (state.tagDefs.t1780370078082_27c4.noteMd !== '') {
    console.error('noteMd should default empty');
    ok = false;
  }
  if (Object.keys(state.completed).length !== 2) {
    console.error('Expected 2 completed, got', Object.keys(state.completed).length);
    ok = false;
  }
  if (!state.problemTags['128']?.includes('t1780759839009_hiu8')) {
    console.error('problem 128 tag link missing');
    ok = false;
  }
  if (exported.version !== 2) {
    console.error('export version should be 2');
    ok = false;
  }
  console.log('JSON migration OK:', {
    tags: Object.keys(state.tagDefs).map((id) => state.tagDefs[id].name),
    completed: state.completed,
    picked: state.picked,
  });
}

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
for (const table of ['tag_defs', 'problem_tags', 'completed', 'picked_ids', 'sync_meta']) {
  if (!schema.includes(table)) {
    console.error('schema.sql missing table:', table);
    ok = false;
  }
}

if (ok) {
  console.log('All verification checks passed.');
  process.exit(0);
}
console.error('Verification failed.');
process.exit(1);
