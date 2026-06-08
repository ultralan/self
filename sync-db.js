/**
 * 云端优先数据层
 *
 * 规则：
 * - 用户写操作只写 Supabase，失败即失败，不写本地、不排队重试
 * - localStorage 只保存最近一次成功全量拉取的云端快照
 * - 导出时优先拉取云端，拉取失败才导出本地缓存快照
 */
(function (global) {
  const CACHE_KEYS = {
    picked: 'lcPickedIds',
    completed: 'lcCompleted',
    tagDefs: 'lcTagDefs',
    problemTags: 'lcProblemTags',
    syncMeta: 'lcSyncMeta',
    snapshots: 'lcSnapshotRecords',
  };

  const TICK_INTERVAL_MS = 5000;
  const SNAPSHOT_LIMIT = 8;

  function localYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayStr() {
    return localYMD(new Date());
  }

  function normalizeTagDef(tag) {
    return {
      id: tag.id,
      name: tag.name,
      color: tag.color || '#f97316',
      noteMd: tag.noteMd || tag.note_md || '',
      noteUpdatedAt: tag.noteUpdatedAt || tag.note_updated_at || null,
      updatedAt: tag.updatedAt || tag.updated_at || null,
    };
  }

  function emptyState() {
    return {
      tagDefs: {},
      problemTags: {},
      completed: {},
      picked: [],
    };
  }

  function toExportJson(snapshot) {
    return {
      version: 2,
      exportedAt: todayStr(),
      lcPickedIds: [...(snapshot.picked || [])],
      lcCompleted: { ...(snapshot.completed || {}) },
      lcTagDefs: snapshot.tagDefs || {},
      lcProblemTags: snapshot.problemTags || {},
    };
  }

  function stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${stableStringify(value[key])}`
      )).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function snapshotCounts(data) {
    return {
      completed: Object.keys(data.lcCompleted || {}).length,
      picked: (data.lcPickedIds || []).length,
      tags: Object.keys(data.lcTagDefs || {}).length,
      problemTags: Object.values(data.lcProblemTags || {}).reduce((sum, ids) => sum + (ids || []).length, 0),
    };
  }

  function createSyncDB() {
    let supabase = null;
    let syncStatus = 'syncing';
    let onStatusChange = null;
    let onDataChange = null;
    let state = emptyState();
    let lock = Promise.resolve();
    let tickTimer = null;

    function setStatus(status) {
      syncStatus = status;
      if (onStatusChange) onStatusChange(status);
    }

    function notify() {
      if (onDataChange) onDataChange();
    }

    function withLock(fn) {
      const run = lock.then(() => fn());
      lock = run.catch(() => {});
      return run;
    }

    function rowsToState(tagsRows, ptRows, compRows, pickRows) {
      const next = emptyState();
      for (const r of tagsRows || []) {
        next.tagDefs[r.id] = normalizeTagDef({
          id: r.id,
          name: r.name,
          color: r.color,
          noteMd: r.note_md,
          noteUpdatedAt: r.note_updated_at,
          updatedAt: r.updated_at,
        });
      }
      for (const row of ptRows || []) {
        const pid = String(row.problem_id);
        if (!next.problemTags[pid]) next.problemTags[pid] = [];
        next.problemTags[pid].push(row.tag_id);
      }
      for (const r of compRows || []) {
        next.completed[String(r.problem_id)] = r.completed_at;
      }
      next.picked = (pickRows || []).map((r) => r.problem_id);
      next.picked.sort((a, b) => a - b);
      for (const ids of Object.values(next.problemTags)) {
        ids.sort();
      }
      return next;
    }

    function persistCache(snapshot) {
      try {
        localStorage.setItem(CACHE_KEYS.picked, JSON.stringify(snapshot.picked));
        localStorage.setItem(CACHE_KEYS.completed, JSON.stringify(snapshot.completed));
        localStorage.setItem(CACHE_KEYS.tagDefs, JSON.stringify(snapshot.tagDefs));
        localStorage.setItem(CACHE_KEYS.problemTags, JSON.stringify(snapshot.problemTags));
        localStorage.setItem(CACHE_KEYS.syncMeta, JSON.stringify({
          cacheFallback: true,
          cloudUpdatedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
        }));
        persistSnapshotRecord(snapshot, 'cloud');
      } catch (err) {
        console.warn('[sync-db] cache fallback persist failed', err);
      }
    }

    function loadCacheSnapshot() {
      const rawMeta = JSON.parse(localStorage.getItem(CACHE_KEYS.syncMeta) || '{}');
      if (!rawMeta.cacheFallback) return null;
      const picked = JSON.parse(localStorage.getItem(CACHE_KEYS.picked) || '[]');
      const completed = JSON.parse(localStorage.getItem(CACHE_KEYS.completed) || '{}');
      const rawTags = JSON.parse(localStorage.getItem(CACHE_KEYS.tagDefs) || '{}');
      const tagDefs = {};
      for (const [id, t] of Object.entries(rawTags)) {
        tagDefs[id] = normalizeTagDef({ ...t, id });
      }
      const problemTags = JSON.parse(localStorage.getItem(CACHE_KEYS.problemTags) || '{}');
      return { picked, completed, tagDefs, problemTags };
    }

    function loadSnapshotRecords() {
      try {
        const raw = JSON.parse(localStorage.getItem(CACHE_KEYS.snapshots) || '[]');
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    }

    function saveSnapshotRecords(records) {
      const next = records.slice(0, SNAPSHOT_LIMIT);
      while (next.length > 0) {
        try {
          localStorage.setItem(CACHE_KEYS.snapshots, JSON.stringify(next));
          return;
        } catch (err) {
          next.pop();
          if (next.length === 0) throw err;
        }
      }
      localStorage.removeItem(CACHE_KEYS.snapshots);
    }

    function persistSnapshotRecord(snapshot, source) {
      const data = toExportJson(snapshot);
      const signature = stableStringify({
        lcPickedIds: data.lcPickedIds,
        lcCompleted: data.lcCompleted,
        lcTagDefs: data.lcTagDefs,
        lcProblemTags: data.lcProblemTags,
      });
      const now = new Date().toISOString();
      const records = loadSnapshotRecords();
      if (records[0]?.signature === signature) {
        records[0] = {
          ...records[0],
          capturedAt: now,
          source,
          counts: snapshotCounts(data),
          data,
        };
        saveSnapshotRecords(records);
        return;
      }
      records.unshift({
        id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        capturedAt: now,
        source,
        signature,
        counts: snapshotCounts(data),
        data,
      });
      saveSnapshotRecords(records);
    }

    function getSnapshotRecords() {
      return loadSnapshotRecords().map((record) => ({
        id: record.id,
        capturedAt: record.capturedAt,
        source: record.source,
        counts: record.counts || snapshotCounts(record.data || {}),
      }));
    }

    function exportCachedSnapshot(id) {
      const records = loadSnapshotRecords();
      const record = id ? records.find((item) => item.id === id) : records[0];
      if (!record?.data) throw new Error('没有可导出的本地快照');
      return {
        data: record.data,
        source: 'cacheSnapshot',
        capturedAt: record.capturedAt,
      };
    }

    async function fetchCloud() {
      if (!supabase) throw new Error('Supabase 未初始化');
      const [tagsRes, ptRes, compRes, pickRes] = await Promise.all([
        supabase.from('tag_defs').select('*'),
        supabase.from('problem_tags').select('*'),
        supabase.from('completed').select('*'),
        supabase.from('picked_ids').select('*'),
      ]);
      if (tagsRes.error) throw tagsRes.error;
      if (ptRes.error) throw ptRes.error;
      if (compRes.error) throw compRes.error;
      if (pickRes.error) throw pickRes.error;
      return rowsToState(tagsRes.data, ptRes.data, compRes.data, pickRes.data);
    }

    async function refreshFromCloud({ notifyUi = true } = {}) {
      const next = await fetchCloud();
      state = next;
      persistCache(next);
      setStatus('synced');
      if (notifyUi) notify();
      return next;
    }

    class NoteConflictError extends Error {
      constructor(latest) {
        super('笔记远端版本已变化');
        this.name = 'NoteConflictError';
        this.code = 'note_conflict';
        this.latest = latest || null;
      }
    }

    async function touchSyncMeta() {
      const { error } = await supabase
        .from('sync_meta')
        .upsert({ key: 'global', updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
    }

    async function fetchTagDef(tagId) {
      const { data, error } = await supabase
        .from('tag_defs')
        .select('*')
        .eq('id', tagId)
        .limit(1);
      if (error) throw error;
      return data?.[0] ? normalizeTagDef(data[0]) : null;
    }

    async function runCloudWrite(fn, { refresh = true, notifyUi = true } = {}) {
      if (!supabase) {
        setStatus('offline');
        throw new Error('云端 API 不可用，操作未保存');
      }
      return withLock(async () => {
        setStatus('syncing');
        try {
          const result = await fn();
          await touchSyncMeta();
          if (refresh) {
            await refreshFromCloud({ notifyUi });
          } else {
            persistCache(state);
            setStatus('synced');
            if (notifyUi) notify();
          }
          return result ?? true;
        } catch (err) {
          if (err?.code === 'note_conflict') {
            setStatus('synced');
            throw err;
          }
          console.warn('[sync-db] cloud write failed', err);
          setStatus('offline');
          throw err;
        }
      });
    }

    async function replaceCloud(snapshot) {
      const normalized = {
        tagDefs: {},
        problemTags: snapshot.problemTags || {},
        completed: snapshot.completed || {},
        picked: snapshot.picked || [],
      };
      for (const [id, t] of Object.entries(snapshot.tagDefs || {})) {
        normalized.tagDefs[id] = normalizeTagDef({ ...t, id });
      }

      const now = new Date().toISOString();
      const tagRows = Object.values(normalized.tagDefs).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        note_md: t.noteMd || '',
        note_updated_at: t.noteUpdatedAt || null,
        updated_at: now,
      }));

      const { error: delPt } = await supabase.from('problem_tags').delete().not('tag_id', 'is', null);
      if (delPt) throw delPt;
      const { error: delTags } = await supabase.from('tag_defs').delete().not('id', 'is', null);
      if (delTags) throw delTags;
      if (tagRows.length > 0) {
        const { error } = await supabase.from('tag_defs').insert(tagRows);
        if (error) throw error;
      }

      const ptRows = [];
      for (const [pid, tagIds] of Object.entries(normalized.problemTags)) {
        for (const tid of tagIds || []) {
          ptRows.push({ problem_id: parseInt(pid, 10), tag_id: tid });
        }
      }
      if (ptRows.length > 0) {
        const { error } = await supabase.from('problem_tags').insert(ptRows);
        if (error) throw error;
      }

      const { error: delComp } = await supabase.from('completed').delete().not('problem_id', 'is', null);
      if (delComp) throw delComp;
      const compRows = Object.entries(normalized.completed).map(([pid, date]) => ({
        problem_id: parseInt(pid, 10),
        completed_at: date,
      }));
      if (compRows.length > 0) {
        const { error } = await supabase.from('completed').insert(compRows);
        if (error) throw error;
      }

      const { error: delPick } = await supabase.from('picked_ids').delete().not('problem_id', 'is', null);
      if (delPick) throw delPick;
      if (normalized.picked.length > 0) {
        const pickRows = normalized.picked.map((pid) => ({ problem_id: pid }));
        const { error } = await supabase.from('picked_ids').insert(pickRows);
        if (error) throw error;
      }
    }

    function getPublicState() {
      return {
        tagDefs: state.tagDefs,
        problemTags: state.problemTags,
        completedMap: new Map(
          Object.entries(state.completed).map(([k, v]) => [parseInt(k, 10), v])
        ),
        pickedIds: new Set(state.picked),
      };
    }

    function startTicker() {
      clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        api.tick();
      }, TICK_INTERVAL_MS);
    }

    const api = {
      todayStr,
      canWrite: () => !!supabase && syncStatus !== 'offline' && syncStatus !== 'error',
      getSyncStatus: () => syncStatus,
      setOnStatusChange(fn) {
        onStatusChange = fn;
      },
      setOnDataChange(fn) {
        onDataChange = fn;
      },

      getTagDefs: () => state.tagDefs,
      getProblemTags: () => state.problemTags,
      getCompleted: () => getPublicState().completedMap,
      getPickedIds: () => getPublicState().pickedIds,

      async init() {
        const cfg = global.CONFIG;
        if (!cfg?.SUPABASE_URL || !cfg?.SUPABASE_ANON_KEY || !global.supabase?.createClient) {
          setStatus('error');
          return;
        }

        supabase = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
        setStatus('syncing');
        try {
          await refreshFromCloud();
          startTicker();
        } catch (err) {
          console.warn('[sync-db] init failed', err);
          setStatus('offline');
        }
      },

      async deleteTag(tagId) {
        return runCloudWrite(async () => {
          const { error } = await supabase.from('tag_defs').delete().eq('id', tagId);
          if (error) throw error;
        });
      },

      async saveTags(obj) {
        return runCloudWrite(async () => {
          const rows = Object.entries(obj || {}).map(([id, t]) => {
            const tag = normalizeTagDef({ ...t, id });
            return {
              id,
              name: tag.name,
              color: tag.color,
              note_md: tag.noteMd || '',
              note_updated_at: tag.noteUpdatedAt || null,
              updated_at: new Date().toISOString(),
            };
          });
          if (rows.length === 0) return;
          const { error } = await supabase.from('tag_defs').upsert(rows, { onConflict: 'id' });
          if (error) throw error;
        });
      },

      async addProblemTag(problemId, tagId) {
        return runCloudWrite(async () => {
          const { error } = await supabase
            .from('problem_tags')
            .upsert({ problem_id: parseInt(problemId, 10), tag_id: tagId }, { onConflict: 'problem_id,tag_id' });
          if (error) throw error;
        });
      },

      async removeProblemTag(problemId, tagId) {
        return runCloudWrite(async () => {
          const { error } = await supabase
            .from('problem_tags')
            .delete()
            .eq('problem_id', parseInt(problemId, 10))
            .eq('tag_id', tagId);
          if (error) throw error;
        });
      },

      async saveCompleted(map) {
        const next = {};
        for (const [k, v] of map.entries()) next[String(k)] = v;
        return runCloudWrite(async () => {
          const deletes = Object.keys(state.completed).filter((pid) => !Object.prototype.hasOwnProperty.call(next, pid));
          if (deletes.length > 0) {
            const { error } = await supabase.from('completed').delete().in('problem_id', deletes.map((pid) => parseInt(pid, 10)));
            if (error) throw error;
          }
          const rows = Object.entries(next).map(([pid, date]) => ({
            problem_id: parseInt(pid, 10),
            completed_at: date,
          }));
          if (rows.length > 0) {
            const { error } = await supabase.from('completed').upsert(rows, { onConflict: 'problem_id' });
            if (error) throw error;
          }
        });
      },

      async savePickedIds(set) {
        const next = [...set];
        return runCloudWrite(async () => {
          const current = new Set(state.picked.map(String));
          const wanted = new Set(next.map(String));
          const deletes = [...current].filter((pid) => !wanted.has(pid));
          if (deletes.length > 0) {
            const { error } = await supabase.from('picked_ids').delete().in('problem_id', deletes.map((pid) => parseInt(pid, 10)));
            if (error) throw error;
          }
          const inserts = next
            .map((pid) => parseInt(pid, 10))
            .filter((pid) => !current.has(String(pid)))
            .map((pid) => ({ problem_id: pid }));
          if (inserts.length > 0) {
            const { error } = await supabase.from('picked_ids').upsert(inserts, { onConflict: 'problem_id' });
            if (error) throw error;
          }
        });
      },

      async saveTagNote(tagId, noteMd, { expectedUpdatedAt = null, force = false } = {}) {
        return runCloudWrite(async () => {
          const now = new Date().toISOString();
          let query = supabase
            .from('tag_defs')
            .update({
              note_md: noteMd,
              note_updated_at: todayStr(),
              updated_at: now,
            })
            .eq('id', tagId);
          if (!force && expectedUpdatedAt) {
            query = query.eq('updated_at', expectedUpdatedAt);
          }
          const { data, error } = await query.select('*');
          if (error) throw error;
          if (!data || data.length === 0) {
            const latest = await fetchTagDef(tagId);
            if (latest) state.tagDefs[tagId] = latest;
            throw new NoteConflictError(latest);
          }
          const saved = normalizeTagDef(data[0]);
          state.tagDefs[tagId] = saved;
          return saved;
        }, { refresh: false, notifyUi: false });
      },

      async importFromJson(data) {
        const snapshot = {
          picked: data.lcPickedIds || [],
          completed: data.lcCompleted || {},
          tagDefs: data.lcTagDefs || {},
          problemTags: data.lcProblemTags || {},
        };
        return runCloudWrite(() => replaceCloud(snapshot));
      },

      async exportFreshOrCachedJson() {
        try {
          const fresh = await withLock(() => refreshFromCloud({ notifyUi: true }));
          return { data: toExportJson(fresh), source: 'cloud' };
        } catch (err) {
          console.warn('[sync-db] export cloud fetch failed, trying cacheFallback', err);
          setStatus(supabase ? 'offline' : 'error');
          const cached = loadCacheSnapshot();
          if (!cached) throw new Error('云端不可用，且没有可导出的本地缓存');
          return { data: toExportJson(cached), source: 'cacheFallback' };
        }
      },

      getSnapshotRecords,
      exportCachedSnapshot,

      async resetCompleted() {
        return runCloudWrite(async () => {
          const { error: compErr } = await supabase.from('completed').delete().not('problem_id', 'is', null);
          if (compErr) throw compErr;
          const { error: pickErr } = await supabase.from('picked_ids').delete().not('problem_id', 'is', null);
          if (pickErr) throw pickErr;
        });
      },

      async resetAll() {
        return runCloudWrite(async () => {
          await replaceCloud(emptyState());
        });
      },

      tick: () => withLock(async () => {
        try {
          await refreshFromCloud();
        } catch (err) {
          console.warn('[sync-db] pull failed', err);
          setStatus('offline');
        }
      }),
      pullFromCloud: () => api.tick(),
    };

    return api;
  }

  global.createSyncDB = createSyncDB;
})(window);
