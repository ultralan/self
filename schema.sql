-- LeetCode 刷题追踪器 — Supabase / PostgreSQL schema
-- 在 Supabase SQL Editor 中执行此脚本

CREATE TABLE IF NOT EXISTS tag_defs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT '#f97316',
  note_md         TEXT NOT NULL DEFAULT '',
  note_updated_at DATE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS problem_tags (
  problem_id INTEGER NOT NULL,
  tag_id     TEXT NOT NULL REFERENCES tag_defs(id) ON DELETE CASCADE,
  PRIMARY KEY (problem_id, tag_id)
);

CREATE TABLE IF NOT EXISTS completed (
  problem_id   INTEGER PRIMARY KEY,
  completed_at DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS picked_ids (
  problem_id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key        TEXT PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS（个人单用户项目：允许 anon 读写；anon key 仅放 config.js，不提交 git）
ALTER TABLE tag_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE completed ENABLE ROW LEVEL SECURITY;
ALTER TABLE picked_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_meta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS personal_rw ON tag_defs;
CREATE POLICY personal_rw ON tag_defs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS personal_rw ON problem_tags;
CREATE POLICY personal_rw ON problem_tags FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS personal_rw ON completed;
CREATE POLICY personal_rw ON completed FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS personal_rw ON picked_ids;
CREATE POLICY personal_rw ON picked_ids FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS personal_rw ON sync_meta;
CREATE POLICY personal_rw ON sync_meta FOR ALL USING (true) WITH CHECK (true);
