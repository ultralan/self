/**
 * 原子同步 DB — 唯一数据管道
 *
 * 规则：
 * - 所有读写经 commit() + 互斥锁
 * - localRev / syncedRev 追踪本地与云端一致性
 * - localRev > syncedRev → 只 push，禁止 pull
 * - localRev === syncedRev → 仅当云端 updated_at 更新时才 pull
 * - localStorage 仅作 API 故障时的兜底快照
 */
(function (global) {
  const CACHE_KEYS = {
    picked: 'lcPickedIds',
    completed: 'lcCompleted',
    tagDefs: 'lcTagDefs',
    problemTags: 'lcProblemTags',
    syncMeta: 'lcSyncMeta',
  };

  const FLUSH_DEBOUNCE_MS = 400;
  const NOTE_FLUSH_DEBOUNCE_MS = 300;
  const TICK_INTERVAL_MS = 5000;

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

  function emptyState() {
    return {
      tagDefs: {},
      problemTags: {},
      completed: {},
      picked: [],
    };
  }

  function createSyncDB() {
    let supabase = null;
    let syncStatus = 'syncing';
    let onStatusChange = null;
    let onDataChange = null;

    let state = emptyState();
    let meta = {
      cloudUpdatedAt: null,
      localRev: 0,
      syncedRev: 0,
      lastSyncedAt: null,
    };

    let lock = Promise.resolve();
    let flushTimer = null;
    let noteFlushTimer = null;
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

    function loadMeta() {
      try {
        const raw = JSON.parse(localStorage.getItem(CACHE_KEYS.syncMeta) || '{}');
        let localRev = Number(raw.localRev) || 0;
        let syncedRev = Number(raw.syncedRev) || 0;
        // 兼容旧版 pendingOps
        if (Array.isArray(raw.pendingOps) && raw.pendingOps.length > 0 && localRev === syncedRev) {
          localRev = syncedRev + 1;
        }
        return {
          cloudUpdatedAt: raw.cloudUpdatedAt || null,
          localRev,
          syncedRev,
          lastSyncedAt: raw.lastSyncedAt || null,
        };
      } catch {
        return { cloudUpdatedAt: null, localRev: 0, syncedRev: 0, lastSyncedAt: null };
      }
    }

    function saveMeta() {
      localStorage.setItem(CACHE_KEYS.syncMeta, JSON.stringify(meta));
    }

    function persistCache() {
      localStorage.setItem(CACHE_KEYS.picked, JSON.stringify(state.picked));
      localStorage.setItem(CACHE_KEYS.completed, JSON.stringify(state.completed));
      localStorage.setItem(CACHE_KEYS.tagDefs, JSON.stringify(state.tagDefs));
      localStorage.setItem(CACHE_KEYS.problemTags, JSON.stringify(state.problemTags));
      saveMeta();
    }

    function loadCache() {
      state.picked = JSON.parse(localStorage.getItem(CACHE_KEYS.picked) || '[]');
      state.completed = JSON.parse(localStorage.getItem(CACHE_KEYS.completed) || '{}');
      const rawTags = JSON.parse(localStorage.getItem(CACHE_KEYS.tagDefs) || '{}');
      state.tagDefs = {};
      for (const [id, t] of Object.entries(rawTags)) {
        state.tagDefs[id] = normalizeTagDef({ ...t, id });
      }
      state.problemTags = JSON.parse(localStorage.getItem(CACHE_KEYS.problemTags) || '{}');
      meta = loadMeta();
    }

    function hasLocalChanges() {
      return meta.localRev !== meta.syncedRev;
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
      return next;
    }

    function applyRemoteState(next, cloudUpdatedAt) {
      state = next;
      meta.cloudUpdatedAt = cloudUpdatedAt || new Date().toISOString();
      meta.syncedRev = meta.localRev;
      meta.lastSyncedAt = new Date().toISOString();
      persistCache();
    }

    async function fetchCloud() {
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
      return {
        state: rowsToState(tagsRes.data, ptRes.data, compRes.data, pickRes.data),
        updatedAt: metaRes.data?.updated_at || null,
      };
    }

    async function replaceCloud(snapshot) {
      const now = new Date().toISOString();
      const tagRows = Object.values(snapshot.tagDefs).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        note_md: t.noteMd || '',
        note_updated_at: t.noteUpdatedAt || null,
        updated_at: now,
      }));

      // FK: 先清 problem_tags，再清 tag_defs，再写入
      const { error: delPt } = await supabase.from('problem_tags').delete().not('tag_id', 'is', null);
      if (delPt) throw delPt;

      const { error: delTags } = await supabase.from('tag_defs').delete().not('id', 'is', null);
      if (delTags) throw delTags;

      if (tagRows.length > 0) {
        const { error } = await supabase.from('tag_defs').insert(tagRows);
        if (error) throw error;
      }

      const ptRows = [];
      for (const [pid, tagIds] of Object.entries(snapshot.problemTags)) {
        for (const tid of tagIds) {
          ptRows.push({ problem_id: parseInt(pid, 10), tag_id: tid });
        }
      }
      if (ptRows.length > 0) {
        const { error } = await supabase.from('problem_tags').insert(ptRows);
        if (error) throw error;
      }

      const { error: delComp } = await supabase.from('completed').delete().not('problem_id', 'is', null);
      if (delComp) throw delComp;

      const compRows = Object.entries(snapshot.completed).map(([pid, date]) => ({
        problem_id: parseInt(pid, 10),
        completed_at: date,
      }));
      if (compRows.length > 0) {
        const { error } = await supabase.from('completed').insert(compRows);
        if (error) throw error;
      }

      const { error: delPick } = await supabase.from('picked_ids').delete().not('problem_id', 'is', null);
      if (delPick) throw delPick;

      if (snapshot.picked.length > 0) {
        const pickRows = snapshot.picked.map((pid) => ({ problem_id: pid }));
        const { error } = await supabase.from('picked_ids').insert(pickRows);
        if (error) throw error;
      }

      const { error: metaErr } = await supabase
        .from('sync_meta')
        .upsert({ key: 'global', updated_at: now }, { onConflict: 'key' });
      if (metaErr) throw metaErr;

      return now;
    }

    async function push() {
      if (!supabase || !hasLocalChanges()) return true;
      setStatus('syncing');
      const snapshot = JSON.parse(JSON.stringify(state));
      const revAtPush = meta.localRev;
      try {
        const cloudUpdatedAt = await replaceCloud(snapshot);
        if (meta.localRev !== revAtPush) {
          // 推送期间又有新改动，需再推一轮
          return false;
        }
        meta.syncedRev = meta.localRev;
        meta.cloudUpdatedAt = cloudUpdatedAt;
        meta.lastSyncedAt = cloudUpdatedAt;
        saveMeta();
        persistCache();
        setStatus('synced');
        return true;
      } catch (e) {
        console.warn('[sync-db] push failed', e);
        setStatus('offline');
        return false;
      }
    }

    async function pull() {
      if (!supabase || hasLocalChanges()) return { ok: false, applied: false };
      try {
        const revBefore = meta.localRev;
        const cloud = await fetchCloud();
        if (hasLocalChanges() || meta.localRev !== revBefore) {
          return { ok: false, applied: false };
        }
        const cloudIsNewer =
          !meta.cloudUpdatedAt || !cloud.updatedAt || cloud.updatedAt > meta.cloudUpdatedAt;
        if (!cloudIsNewer) return { ok: true, applied: false };
        applyRemoteState(cloud.state, cloud.updatedAt);
        return { ok: true, applied: true };
      } catch (e) {
        console.warn('[sync-db] pull failed', e);
        return { ok: false, applied: false };
      }
    }

    async function tick() {
      return withLock(async () => {
        if (hasLocalChanges()) {
          const ok = await push();
          while (hasLocalChanges()) {
            const again = await push();
            if (!again) break;
          }
          if (ok) notify();
          return;
        }
        const result = await pull();
        if (result.applied) {
          setStatus('synced');
          notify();
        } else if (result.ok) {
          setStatus('synced');
        }
      });
    }

    function scheduleFlush(delay = FLUSH_DEBOUNCE_MS) {
      if (!supabase) return;
      setStatus('syncing');
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        tick();
      }, delay);
    }

    function startTicker() {
      clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        tick();
      }, TICK_INTERVAL_MS);
    }

    async function commit(mutator, { flush = false, debounce } = {}) {
      return withLock(async () => {
        if (!supabase) return false;
        const draft = JSON.parse(JSON.stringify(state));
        mutator(draft);
        state = draft;
        meta.localRev += 1;
        persistCache();
        notify();
        if (flush) {
          clearTimeout(flushTimer);
          clearTimeout(noteFlushTimer);
          await tick();
        } else if (debounce === 'note') {
          clearTimeout(noteFlushTimer);
          noteFlushTimer = setTimeout(() => tick(), NOTE_FLUSH_DEBOUNCE_MS);
        } else {
          scheduleFlush();
        }
        return true;
      });
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

    const api = {
      todayStr,
      canWrite: () => !!supabase,
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

      async bootstrapFromCloud() {
        return withLock(async () => {
          if (hasLocalChanges()) {
            const ok = await push();
            if (!ok) {
              setStatus('offline');
              return;
            }
          }
          const pulled = await pull();
          if (pulled.applied) {
            setStatus('synced');
            notify();
          } else if (pulled.ok) {
            setStatus('synced');
          } else {
            setStatus('offline');
          }
        });
      },

      async init() {
        // 1. 立刻用本地缓存渲染（stale-while-revalidate）
        loadCache();
        notify();

        const cfg = global.CONFIG;
        if (!cfg?.SUPABASE_URL || !cfg?.SUPABASE_ANON_KEY || !global.supabase?.createClient) {
          setStatus('error');
          return;
        }

        // 2. 后台与云端对齐，不阻塞首屏
        supabase = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
        setStatus('syncing');
        startTicker();
        bootstrapFromCloud().catch((e) => {
          console.warn('[sync-db] bootstrap failed', e);
          setStatus('offline');
        });
      },

      async commit(mutator, opts) {
        return commit(mutator, opts);
      },

      async deleteTag(tagId) {
        return commit(
          (draft) => {
            delete draft.tagDefs[tagId];
            for (const pid of Object.keys(draft.problemTags)) {
              draft.problemTags[pid] = draft.problemTags[pid].filter((id) => id !== tagId);
              if (draft.problemTags[pid].length === 0) delete draft.problemTags[pid];
            }
          },
          { flush: true }
        );
      },

      async saveTags(obj) {
        return commit(
          (draft) => {
            draft.tagDefs = {};
            for (const [id, t] of Object.entries(obj)) {
              draft.tagDefs[id] = normalizeTagDef({ ...t, id });
            }
          },
          { flush: true }
        );
      },

      async saveProblemTags(obj) {
        return commit((draft) => {
          draft.problemTags = JSON.parse(JSON.stringify(obj));
        });
      },

      async saveCompleted(map) {
        return commit((draft) => {
          draft.completed = {};
          for (const [k, v] of map.entries()) draft.completed[String(k)] = v;
        });
      },

      async savePickedIds(set) {
        return commit((draft) => {
          draft.picked = [...set];
        });
      },

      async saveTagNote(tagId, noteMd) {
        return commit(
          (draft) => {
            if (!draft.tagDefs[tagId]) return;
            draft.tagDefs[tagId].noteMd = noteMd;
            draft.tagDefs[tagId].noteUpdatedAt = todayStr();
          },
          { debounce: 'note' }
        );
      },

      async importFromJson(data) {
        return commit(
          (draft) => {
            if (data.lcPickedIds) draft.picked = [...data.lcPickedIds];
            if (data.lcCompleted) draft.completed = { ...data.lcCompleted };
            if (data.lcTagDefs) {
              draft.tagDefs = {};
              for (const [id, t] of Object.entries(data.lcTagDefs)) {
                draft.tagDefs[id] = normalizeTagDef({ ...t, id });
              }
            }
            if (data.lcProblemTags) draft.problemTags = { ...data.lcProblemTags };
          },
          { flush: true }
        );
      },

      exportToJson() {
        return {
          version: 2,
          exportedAt: todayStr(),
          lcPickedIds: [...state.picked],
          lcCompleted: { ...state.completed },
          lcTagDefs: state.tagDefs,
          lcProblemTags: state.problemTags,
        };
      },

      async resetCompleted() {
        return commit(
          (draft) => {
            draft.completed = {};
            draft.picked = [];
          },
          { flush: true }
        );
      },

      async resetAll() {
        return commit(
          (draft) => {
            draft.tagDefs = {};
            draft.problemTags = {};
            draft.completed = {};
            draft.picked = [];
          },
          { flush: true }
        );
      },

      flushSync: () => withLock(() => tick()),
      tick,
      pullFromCloud: () => withLock(() => pull()),
    };

    return api;
  }

  global.createSyncDB = createSyncDB;
})(window);
