'use strict';

// Keep an early completion until the renderer is ready; consume it once so a
// page reload never repeats the notice or starts another read.
function createSharedStartup({ initialize, onChanged = () => {}, onNotice = () => {} }) {
  let operation, notice = null;
  const signal = callback => { try { callback(); } catch { /* The queued notice survives a lost UI event. */ } };
  const publish = value => { notice = value; signal(onNotice); };
  return {
    start() {
      operation ||= Promise.resolve().then(initialize).then(sources => {
        if (!Array.isArray(sources)) throw new Error('Invalid shared startup result');
        signal(onChanged);
        if (!sources.length) return;
        const failed = sources.filter(source => source.status !== 'ready').length;
        publish({ error: failed > 0, message: failed === 0 ? '공유 세션 목록을 불러왔습니다.' : failed === sources.length ? '공유 세션 목록을 불러오지 못했습니다.' : '일부 공유 세션 목록을 불러오지 못했습니다.' });
      }).catch(() => publish({ error: true, message: '공유 세션 목록을 불러오지 못했습니다.' }));
      return operation;
    },
    takeNotice() { const result = notice; notice = null; return result; }
  };
}
module.exports = { createSharedStartup };
