/**
 * 数据层：localStorage 缓存优先 + Supabase 异步同步
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
  let syncStatus = 'no-config';
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
  const PULL_INTERVAL_MS = 15000;

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

  async function pullFromCloud() {
    if (!supabase) return false;
    try {
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

      const cloudUpdatedAt = metaRes.data?.updated_at || null;
      const meta = loadSyncMeta();

      if ((meta.pendingOps || []).length > 0) {
        return false;
      }

      const cloudHasData =
        (tagsRes.data && tagsRes.data.length > 0) ||
        (compRes.data && compRes.data.length > 0) ||
        (ptRes.data && ptRes.data.length > 0);

      const localHasData =
        Object.keys(tagDefs).length > 0 ||
        completedMap.size > 0 ||
        Object.keys(problemTags).length > 0;

      if (cloudHasData || !localHasData) {
        applyCloudSnapshot(
          tagsRes.data,
          ptRes.data,
          compRes.data,
          pickRes.data,
          cloudUpdatedAt
        );
      }
      return true;
    } catch (e) {
      console.warn('pullFromCloud failed', e);
      return false;
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

      if (tagRows.length > 0) {
        const { error } = await supabase.from('tag_defs').upsert(tagRows, { onConflict: 'id' });
        if (error) throw error;
      } else {
        const { error } = await supabase.from('tag_defs').delete().neq('id', '');
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
      setStatus('synced');
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

  function schedulePush() {
    if (!supabase) return;
    setStatus('syncing');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushToCloud();
    }, PUSH_DEBOUNCE_MS);
  }

  function persistAndSync() {
    markLocalDirty();
    persistCache();
    schedulePush();
  }

  function notifyDataChange() {
    if (onDataChange) onDataChange();
  }

  function startPeriodicPull() {
    if (!supabase) return;
    clearInterval(pullTimer);
    pullTimer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const meta = loadSyncMeta();
      if (meta.pendingOps.length > 0) return;
      const pulled = await pullFromCloud();
      if (pulled) {
        setStatus('synced');
        notifyDataChange();
      }
    }, PULL_INTERVAL_MS);
  }

  async function flushPendingOps() {
    const meta = loadSyncMeta();
    if (!meta.pendingOps.length) return true;
    return pushToCloud();
  }

  async function init() {
    loadFromCache();
    const cfg = global.CONFIG;
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      setStatus('no-config');
      return;
    }
    if (!global.supabase || !global.supabase.createClient) {
      setStatus('no-config');
      return;
    }

    supabase = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    setStatus('syncing');

    const meta = loadSyncMeta();
    if (meta.pendingOps.length > 0) {
      const pushed = await pushToCloud();
      if (!pushed) {
        setStatus('offline');
        return;
      }
    }

    const pulled = await pullFromCloud();
    setStatus(pulled ? 'synced' : 'offline');

    if (!pulled && meta.pendingOps.length === 0) {
      schedulePush();
    }

    startPeriodicPull();
  }

  const store = {
    init,
    todayStr,
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

    reloadFromMemory() {
      loadFromCache();
    },

    saveTags(obj) {
      tagDefs = {};
      for (const [id, t] of Object.entries(obj)) {
        tagDefs[id] = normalizeTagDef({ ...t, id });
      }
      persistAndSync();
    },

    saveProblemTags(obj) {
      problemTags = obj;
      persistAndSync();
    },

    saveCompleted(map) {
      completedMap = map;
      persistAndSync();
    },

    savePickedIds(set) {
      pickedIds = set;
      persistAndSync();
    },

    saveTagNote(tagId, noteMd) {
      if (!tagDefs[tagId]) return;
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
      schedulePush();
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
      completedMap = new Map();
      pickedIds = new Set();
      persistAndSync();
    },

    resetAll() {
      pickedIds = new Set();
      completedMap = new Map();
      tagDefs = {};
      problemTags = {};
      persistCache();
      const meta = loadSyncMeta();
      meta.pendingOps = ['full'];
      saveSyncMeta(meta);
      schedulePush();
    },

    flushSync: () => pushToCloud(),
    pullFromCloud,
  };

  global.createStore = () => store;
})(window);
