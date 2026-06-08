/**
 * 应用数据门面 — 委托 sync-db 原子 API
 */
(function (global) {
  function createStore() {
    const db = global.createSyncDB();

    return {
      init: () => db.init(),
      todayStr: db.todayStr,
      canWrite: db.canWrite,
      getSyncStatus: db.getSyncStatus,
      setOnStatusChange: db.setOnStatusChange,
      setOnDataChange: db.setOnDataChange,

      getTagDefs: db.getTagDefs,
      getProblemTags: db.getProblemTags,
      getCompleted: db.getCompleted,
      getPickedIds: db.getPickedIds,

      deleteTag: (id) => db.deleteTag(id),
      saveTags: (obj) => db.saveTags(obj),
      saveCompleted: (map) => db.saveCompleted(map),
      savePickedIds: (set) => db.savePickedIds(set),
      saveTagNote: (id, md, options) => db.saveTagNote(id, md, options),
      addProblemTag: (problemId, tagId) => db.addProblemTag(problemId, tagId),
      removeProblemTag: (problemId, tagId) => db.removeProblemTag(problemId, tagId),

      importFromJson: (data) => db.importFromJson(data),
      exportFreshOrCachedJson: () => db.exportFreshOrCachedJson(),
      getSnapshotRecords: () => db.getSnapshotRecords(),
      exportCachedSnapshot: (id) => db.exportCachedSnapshot(id),
      resetCompleted: () => db.resetCompleted(),
      resetAll: () => db.resetAll(),

      tick: () => db.tick(),
      pullFromCloud: () => db.pullFromCloud(),
    };
  }

  global.createStore = createStore;
})(window);
