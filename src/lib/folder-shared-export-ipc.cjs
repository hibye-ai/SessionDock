'use strict';

const { randomUUID } = require('node:crypto');
const {
  buildFolderSharedExport,
  safeDefaultFilename,
  inspectJsonDestination,
  replaceConfirmedJson,
  writeFreshJsonExclusive
} = require('./folder-shared-export.cjs');

const PLAN_TTL_MS = 10 * 60 * 1000;

function failure(message, code = 'ERR_VALIDATION') {
  return Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// Main owns subtree projection, revision verification, native save dialog and
// file replacement confirmation. Renderer supplies only a local folder path for
// preview and `{token, confirm: true}` after explicit user confirmation.
function registerFolderSharedExport({
  handle,
  dialog,
  getWindow,
  store,
  protectedFiles,
  owner,
  isShuttingDown = () => false
}) {
  let pending = null;
  let inFlight = false;

  handle('folders:shared-export-preview', folderPath => {
    if (isShuttingDown()) throw failure('앱 종료 중이라 게시할 수 없습니다.', 'ERR_SHUTTING_DOWN');
    if (inFlight) throw failure('다른 공유 세션 게시가 진행 중입니다.', 'ERR_BUSY');
    pending = null;
    const built = buildFolderSharedExport(store, folderPath);
    const token = randomUUID();
    pending = {
      token,
      folder: built.preview.folder,
      revision: built.revision,
      epoch: owner(),
      expires: Date.now() + PLAN_TTL_MS
    };
    return { ...built.preview, token };
  }, { mainFrame: true });

  handle('folders:shared-export-cancel', input => {
    if (input !== undefined && input !== null && !isPlainObject(input)) {
      throw failure('취소 요청이 올바르지 않습니다.', 'ERR_VALIDATION');
    }
    if (pending && (!input?.token || input.token === pending.token)) {
      pending = null;
    }
    return true;
  }, { mainFrame: true });

  handle('folders:shared-export-save', async input => {
    if (isShuttingDown()) throw failure('앱 종료 중이라 저장할 수 없습니다.', 'ERR_SHUTTING_DOWN');
    if (inFlight) throw failure('다른 공유 세션 게시가 진행 중입니다.', 'ERR_BUSY');
    if (!isPlainObject(input) ||
        Object.keys(input).some(key => !['token', 'confirm'].includes(key)) ||
        input.confirm !== true ||
        typeof input.token !== 'string' ||
        !input.token) {
      throw failure('미리보기 확인 후 저장해 주세요.', 'ERR_VALIDATION');
    }
    const plan = pending;
    if (!plan || plan.token !== input.token) {
      throw failure('미리보기가 유효하지 않습니다. 다시 확인해 주세요.', 'ERR_STALE_PLAN');
    }
    if (plan.epoch !== owner() || Date.now() > plan.expires) {
      pending = null;
      throw failure('미리보기가 만료되었습니다. 창을 닫고 다시 확인해 주세요.', 'ERR_STALE_PLAN');
    }
    inFlight = true;
    try {
      let beforeDialog;
      try { beforeDialog = buildFolderSharedExport(store, plan.folder); }
      catch {
        pending = null;
        throw failure('폴더가 변경되었습니다. 창을 닫고 다시 확인해 주세요.', 'ERR_STALE_PLAN');
      }
      if (beforeDialog.revision !== plan.revision) {
        pending = null;
        throw failure('폴더 내용이 변경되었습니다. 창을 닫고 다시 확인해 주세요.', 'ERR_STALE_PLAN');
      }
      const chosen = await dialog.showSaveDialog(getWindow(), {
        title: '공유 세션 저장',
        buttonLabel: '저장',
        defaultPath: safeDefaultFilename(plan.folder),
        filters: [{ name: 'SessionDock 공유 세션', extensions: ['json'] }]
      });
      if (chosen.canceled || !chosen.filePath) return null;
      const validate = () => {
        if (!isShuttingDown() && pending === plan && plan.epoch === owner() && Date.now() <= plan.expires) {
          let built;
          try { built = buildFolderSharedExport(store, plan.folder); } catch { /* stale plan */ }
          if (built?.revision === plan.revision) return built;
        }
        if (pending === plan) pending = null;
        throw failure('폴더나 창 상태가 변경되었습니다. 창을 닫고 다시 확인해 주세요.', 'ERR_STALE_PLAN');
      };
      const afterDialog = validate();
      const destination = await inspectJsonDestination(chosen.filePath, protectedFiles());
      validate();
      if (destination.stamp !== null) {
        const { response } = await dialog.showMessageBox(getWindow(), {
          type: 'warning',
          message: '기존 JSON 파일을 덮어쓸까요?',
          detail: `${chosen.filePath}\n\n기존 내용은 병합하지 않고 새 목록으로 덮어씁니다. 원본 세션은 바뀌지 않습니다.`,
          buttons: ['덮어쓰기', '취소'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        if (response !== 0) return null;
        validate();
      }
      const written = destination.stamp === null
        ? await writeFreshJsonExclusive(chosen.filePath, afterDialog.bytes, protectedFiles(), validate)
        : await replaceConfirmedJson(chosen.filePath, afterDialog.bytes, destination, protectedFiles, validate);
      pending = null;
      return {
        path: written.path,
        folder: plan.folder,
        sessionCount: afterDialog.preview.sessionCount,
        folderCount: afterDialog.preview.folderCount
      };
    } finally {
      inFlight = false;
    }
  }, { mainFrame: true });
}

module.exports = { registerFolderSharedExport };
