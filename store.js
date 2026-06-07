/**
 * 数据层：云端为准 + localStorage 仅作 API 不可用时的兜底缓存
 */
(function (global) {
  const KEYS = {
    picked: 'lcPickedIds',
    completed: 'lcCompleted',
    tagDefs: 'lcTagDefs',
    problemTags: 'lcProblemTags',
    syncMeta: 'lcSyncMeta',
  };

  let supabase = null;
  let syncStatus = 'syncing';
  let onStatusChange = null;

  let tagDefs = {};
  let problemTags = {};
  let completedMap = new Map();
  let pickedIds = new Set();

  let pushTimer = null;
  let pullTimer = null;
  let pushInFlight = false;
  let pushAgain = false;
  const noteSaveTimers = {};
  let onDataChange = null;

  const PUSH_DEBOUNCE_MS = 400;
  const NOTE_PUSH_DEBOUNCE_MS = 300;
  const PULL_INTERVAL_MS = 5000;

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
    };
  }

  function loadSyncMeta() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEYS.syncMeta) || '{}');
      return {
        lastSyncedAt: raw.lastSyncedAt || null,
        cloudUpdatedAt: raw.cloudUpdatedAt || null,
        pendingOps: Array.isArray(raw.pendingOps) ? raw.pendingOps : [],
      };
    } catch {
      return { lastSyncedAt: null, cloudUpdatedAt: null, pendingOps: [] };
    }
  }

  function saveSyncMeta(meta) {
    localStorage.setItem(KEYS.syncMeta, JSON.stringify(meta));
  }

  function setStatus(status) {
    syncStatus = status;
    if (onStatusChange) onStatusChange(status);
  }

  function persistCache() {
    localStorage.setItem(KEYS.picked, JSON.stringify([...pickedIds]));
    const completedObj = {};
    for (const [k, v] of completedMap) completedObj[k] = v;
    localStorage.setItem(KEYS.completed, JSON.stringify(completedObj));
    localStorage.setItem(KEYS.tagDefs, JSON.stringify(tagDefs));
    localStorage.setItem(KEYS.problemTags, JSON.stringify(problemTags));
  }

  function loadFromCache() {
    pickedIds = new Set(JSON.parse(localStorage.getItem(KEYS.picked) || '[]'));
    const rawCompleted = JSON.parse(localStorage.getItem(KEYS.completed) || '{}');
    completedMap = new Map(
      Object.entries(rawCompleted).map(([k, v]) => [parseInt(k, 10), v])
    );
    const rawTags = JSON.parse(localStorage.getItem(KEYS.tagDefs) || '{}');
    tagDefs = {};
    for (const [id, t] of Object.entries(rawTags)) {
      tagDefs[id] = normalizeTagDef({ ...t, id });
    }
    problemTags = JSON.parse(localStorage.getItem(KEYS.problemTags) || '{}');
  }

  function applyCloudSnapshot(tagsRows, ptRows, compRows, pickRows, cloudUpdatedAt) {
    tagDefs = rowsToTagDefs(tagsRows);
    problemTags = {};
    for (const row of ptRows || []) {
      const pid = String(row.problem_id);
      if (!problemTags[pid]) problemTags[pid] = [];
      problemTags[pid].push(row.tag_id);
    }
    completedMap = new Map(
      (compRows || []).map((r) => [r.problem_id, r.completed_at])
    );
    pickedIds = new Set((pickRows || []).map((r) => r.problem_id));
    persistCache();
    const meta = loadSyncMeta();
    saveSyncMeta({
      ...meta,
      cloudUpdatedAt: cloudUpdatedAt || new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      pendingOps: [],
    });
  }

  function rowsToTagDefs(rows) {
    const out = {};
    for (const r of rows || []) {
      out[r.id] = normalizeTagDef({
        id: r.id,
        name: r.name,
        color: r.color,
        noteMd: r.note_md,
        noteUpdatedAt: r.note_updated_at,
      });
    }
    return out;
  }

  function tagDefsToRows() {
    const now = new Date().toISOString();
    return Object.values(tagDefs).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      note_md: t.noteMd || '',
      note_updated_at: t.noteUpdatedAt || null,
      updated_at: now,
    }));
  }

  function canWrite() {
    return !!supabase;
  }

  function hasPendingLocalChanges() {
    return loadSyncMeta().pendingOps.length > 0;
  }

  async function pullFromCloud() {
    if (!supabase || pushInFlight) return { ok: false, applied: false };
    try {
      if (hasPendingLocalChanges()) return { ok: false, applied: false };

      const [tagsRes, ptRes, compRes, pickRes, metaRes] = await Promise.all([
        supabase.from('tag_defs').select('*'),
        supabase.from('problem_tags').select('*'),
        supabase.from('completed').select('*'),
        supabase.from('picked_ids').select('*'),
        supabase.from('sync_meta').select('*').eq('key', 'global').maybeSingle(),
      ]);

      if (tagsRes.error) throw tagsRes.error;
      if (ptRes.error) throw ptRes.error;
      if (compRes.error) throw compRes.error;
      if (pickRes.error) throw pickRes.error;

      // 拉取过程中若产生本地修改，放弃覆盖（双向管道：本地待上传优先）
      if (hasPendingLocalChanges()) return { ok: false, applied: false };

      const cloudUpdatedAt = metaRes.data?.updated_at || null;
      const meta = loadSyncMeta();
      const cloudIsNewer =
        !meta.cloudUpdatedAt || !cloudUpdatedAt || cloudUpdatedAt > meta.cloudUpdatedAt;

      if (!cloudIsNewer) return { ok: true, applied: false };

      applyCloudSnapshot(
        tagsRes.data,
        ptRes.data,
        compRes.data,
        pickRes.data,
        cloudUpdatedAt
      );
      return { ok: true, applied: true };
    } catch (e) {
      console.warn('pullFromCloud failed', e);
      return { ok: false, applied: false };
    }
  }

  async function pushToCloud() {
    if (!supabase) return false;
    if (pushInFlight) {
      pushAgain = true;
      return false;
    }
    pushInFlight = true;
    setStatus('syncing');
    try {
      const tagRows = tagDefsToRows();

      // 全量替换：删除的标签必须从云端清掉（upsert 无法表达删除）
      const { error: delTags } = await supabase.from('tag_defs').delete().neq('id', '');
      if (delTags) throw delTags;
      if (tagRows.length > 0) {
        const { error } = await supabase.from('tag_defs').insert(tagRows);
        if (error) throw error;
      }

      const { error: delPt } = await supabase.from('problem_tags').delete().gte('problem_id', 0);
      if (delPt) throw delPt;

      const ptRows = [];
      for (const [pid, tagIds] of Object.entries(problemTags)) {
        for (const tid of tagIds) {
          ptRows.push({ problem_id: parseInt(pid, 10), tag_id: tid });
        }
      }
      if (ptRows.length > 0) {
        const { error } = await supabase.from('problem_tags').insert(ptRows);
        if (error) throw error;
      }

      const { error: delComp } = await supabase.from('completed').delete().gte('problem_id', 0);
      if (delComp) throw delComp;

      const compRows = [...completedMap.entries()].map(([pid, date]) => ({
        problem_id: pid,
        completed_at: date,
      }));
      if (compRows.length > 0) {
        const { error } = await supabase.from('completed').insert(compRows);
        if (error) throw error;
      }

      const { error: delPick } = await supabase.from('picked_ids').delete().gte('problem_id', 0);
      if (delPick) throw delPick;

      const pickRows = [...pickedIds].map((pid) => ({ problem_id: pid }));
      if (pickRows.length > 0) {
        const { error } = await supabase.from('picked_ids').insert(pickRows);
        if (error) throw error;
      }

      const now = new Date().toISOString();
      const { error: metaErr } = await supabase
        .from('sync_meta')
        .upsert({ key: 'global', updated_at: now }, { onConflict: 'key' });
      if (metaErr) throw metaErr;

      const meta = loadSyncMeta();
      saveSyncMeta({
        ...meta,
        lastSyncedAt: now,
        cloudUpdatedAt: now,
        pendingOps: [],
      });
      persistCache();
      setStatus('synced');
      notifyDataChange();
      return true;
    } catch (e) {
      console.warn('pushToCloud failed', e);
      const meta = loadSyncMeta();
      if (!meta.pendingOps.includes('full')) meta.pendingOps.push('full');
      saveSyncMeta(meta);
      setStatus('offline');
      return false;
    } finally {
      pushInFlight = false;
      if (pushAgain) {
        pushAgain = false;
        schedulePush();
      }
    }
  }

  function markLocalDirty() {
    const meta = loadSyncMeta();
    if (!meta.pendingOps.includes('full')) meta.pendingOps.push('full');
    saveSyncMeta(meta);
    if (supabase) setStatus('syncing');
  }

  function schedulePush(immediate = false) {
    if (!supabase) return;
    setStatus('syncing');
    clearTimeout(pushTimer);
    if (immediate) {
      pushToCloud();
      return;
    }
    pushTimer = setTimeout(() => {
      pushToCloud();
    }, PUSH_DEBOUNCE_MS);
  }

  function persistAndSync({ immediate = false } = {}) {
    if (!canWrite()) return;
    markLocalDirty();
    persistCache();
    schedulePush(immediate);
  }

  function notifyDataChange() {
    if (onDataChange) onDataChange();
  }

  function startPeriodicSync() {
    if (!supabase) return;
    clearInterval(pullTimer);
    pullTimer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (hasPendingLocalChanges() || pushInFlight) {
        await pushToCloud();
        return;
      }
      const pulled = await pullFromCloud();
      if (pulled.ok && pulled.applied) {
        setStatus('synced');
        notifyDataChange();
      } else if (pulled.ok) {
        setStatus('synced');
      }
    }, PULL_INTERVAL_MS);
  }

  async function init() {
    const cfg = global.CONFIG;
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      loadFromCache();
      setStatus('error');
      notifyDataChange();
      return;
    }
    if (!global.supabase || !global.supabase.createClient) {
      loadFromCache();
      setStatus('error');
      notifyDataChange();
      return;
    }

    supabase = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    setStatus('syncing');

    const meta = loadSyncMeta();
    if (meta.pendingOps.length > 0) {
      loadFromCache();
      const pushed = await pushToCloud();
      if (!pushed) {
        notifyDataChange();
        startPeriodicSync();
        return;
      }
    }

    const pulled = await pullFromCloud();
    if (pulled.applied) {
      setStatus('synced');
      notifyDataChange();
    } else if (pulled.ok) {
      loadFromCache();
      setStatus('synced');
      notifyDataChange();
    } else {
      loadFromCache();
      setStatus('offline');
      notifyDataChange();
    }

    startPeriodicSync();
  }

  const store = {
    init,
    todayStr,
    canWrite,
    getSyncStatus: () => syncStatus,
    setOnStatusChange(fn) {
      onStatusChange = fn;
    },
    setOnDataChange(fn) {
      onDataChange = fn;
    },

    getTagDefs: () => tagDefs,
    getProblemTags: () => problemTags,
    getCompleted: () => completedMap,
    getPickedIds: () => pickedIds,

    saveTags(obj) {
      if (!canWrite()) return;
      tagDefs = {};
      for (const [id, t] of Object.entries(obj)) {
        tagDefs[id] = normalizeTagDef({ ...t, id });
      }
      persistAndSync({ immediate: true });
    },

    saveProblemTags(obj) {
      if (!canWrite()) return;
      problemTags = obj;
      persistAndSync();
    },

    saveCompleted(map) {
      if (!canWrite()) return;
      completedMap = map;
      persistAndSync();
    },

    savePickedIds(set) {
      if (!canWrite()) return;
      pickedIds = set;
      persistAndSync();
    },

    saveTagNote(tagId, noteMd) {
      if (!canWrite() || !tagDefs[tagId]) return;
      tagDefs[tagId].noteMd = noteMd;
      tagDefs[tagId].noteUpdatedAt = todayStr();
      markLocalDirty();
      persistCache();
      clearTimeout(noteSaveTimers[tagId]);
      noteSaveTimers[tagId] = setTimeout(() => {
        schedulePush();
      }, NOTE_PUSH_DEBOUNCE_MS);
    },

    importFromJson(data) {
      if (!canWrite()) return;
      if (data.lcPickedIds) pickedIds = new Set(data.lcPickedIds);
      if (data.lcCompleted) {
        completedMap = new Map(
          Object.entries(data.lcCompleted).map(([k, v]) => [parseInt(k, 10), v])
        );
      }
      if (data.lcTagDefs) {
        tagDefs = {};
        for (const [id, t] of Object.entries(data.lcTagDefs)) {
          tagDefs[id] = normalizeTagDef({ ...t, id });
        }
      }
      if (data.lcProblemTags) problemTags = data.lcProblemTags;
      persistCache();
      const meta = loadSyncMeta();
      meta.pendingOps = ['full'];
      saveSyncMeta(meta);
      schedulePush(true);
    },

    exportToJson() {
      const completedObj = {};
      for (const [k, v] of completedMap) completedObj[k] = v;
      return {
        version: 2,
        exportedAt: todayStr(),
        lcPickedIds: [...pickedIds],
        lcCompleted: completedObj,
        lcTagDefs: tagDefs,
        lcProblemTags: problemTags,
      };
    },

    resetCompleted() {
      if (!canWrite()) return;
      completedMap = new Map();
      pickedIds = new Set();
      persistAndSync({ immediate: true });
    },

    resetAll() {
      if (!canWrite()) return;
      pickedIds = new Set();
      completedMap = new Map();
      tagDefs = {};
      problemTags = {};
      persistCache();
      const meta = loadSyncMeta();
      meta.pendingOps = ['full'];
      saveSyncMeta(meta);
      schedulePush(true);
    },

    flushSync: () => pushToCloud(),
    pullFromCloud,
  };

  global.createStore = () => store;
})(window);
