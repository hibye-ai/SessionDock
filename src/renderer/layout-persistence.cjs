'use strict';

// All renderer layout writers share this queue. The backend preserves omitted
// named workspaces, but resets omitted legacy fields, so read/merge inside the
// queue rather than submitting a stale renderer snapshot or a bare patch.
function createLayoutPersistence({ api, onSaved = () => {} }) {
  let pending = Promise.resolve();
  const enqueue = task => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };
  const layoutFrom = layout => {
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new Error('화면 배치 설정을 불러오지 못했습니다.');
    return structuredClone(layout);
  };
  async function commit(current, patch) {
    const next = { ...current, ...structuredClone(patch) };
    // Only explicit collection edits may replace these fields, even when an
    // unrelated settings writer has changed them since our layout read.
    for (const key of ['workspaces', 'selectedWorkspaceId']) {
      if (!Object.hasOwn(patch, key)) delete next[key];
    }
    const saved = await api.saveLayout(next);
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.workspaces)) throw new Error('저장 응답에 화면 배치 또는 작업공간 목록이 없습니다.');
    onSaved(structuredClone(saved));
    return saved;
  }
  return {
    readData: () => enqueue(() => api.bootstrap()),
    save(patch) {
      const captured = structuredClone(patch);
      return enqueue(async () => commit(layoutFrom(await api.readLayout()), captured));
    },
    update(change) {
      return enqueue(async () => {
        const current = layoutFrom(await api.readLayout());
        const { patch, result } = change(structuredClone(current));
        const layout = await commit(current, patch);
        return { layout, result };
      });
    },
    saveSettings(input) {
      const captured = structuredClone(input);
      return enqueue(async () => {
        const saved = await api.saveSettings(captured);
        onSaved(structuredClone(saved.layout));
        return saved;
      });
    }
  };
}

module.exports = { createLayoutPersistence };
