'use strict';
const { normalizeDockSnapshot } = require('../renderer/terminal-docking.cjs');
function layoutSettings(input = {}, previous = {}) {
  const invalid = () => { throw Object.assign(new Error('화면 배치 설정이 올바르지 않습니다.'), { code: 'ERR_VALIDATION' }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const bool = (key, fallback) => { const value = input[key] ?? fallback; if (typeof value !== 'boolean') invalid(); return value; };
  // A sidebar width measured from the DOM can arrive as a fraction (DPI scaling,
  // zoom) or a hair outside the drag clamp; both are measurement artifacts, not
  // operator mistakes. Round and clamp those instead of rejecting the whole
  // autosave — that rejection surfaced "화면 배치 설정이 올바르지 않습니다." over
  // and over while the drag itself was perfectly legal. A genuinely
  // out-of-range integer (0, 189, 900) is still an error.
  const width = input.sidebarWidth ?? 258;
  if (typeof width !== 'number' || !Number.isFinite(width)) invalid();
  const pixels = Number.isInteger(width) ? width : Math.max(190, Math.min(430, Math.round(width)));
  if (pixels < 190 || pixels > 430) invalid();
  const direction = input.splitDirection ?? 'columns'; if (!['columns','rows'].includes(direction)) invalid();
  const tracks = (key, fallback, source = input) => {
    const value = source[key] ?? fallback;
    if (!Array.isArray(value) || !value.length || value.length > 128) invalid();
    // A weight that is not a finite positive number is malformed data, not a
    // measurement artifact like a fractional pixel width: a zero/NaN/negative
    // weight can only come from a zero-extent division. The renderer sanitizes
    // those before sending (`persistLayout`), so keep rejecting them here rather
    // than persisting a layout that cannot be rendered.
    if (value.some(weight => !Number.isFinite(weight) || weight < .001 || weight > 1000)) invalid();
    return [...value];
  };
  // An empty string is a tree-model artifact (a folder renamed or deleted
  // between renders), never a path. Drop it instead of failing the autosave;
  // real paths are still length/control-character checked.
  const collapsed = input.collapsedFolders ?? [];
  if (!Array.isArray(collapsed) || collapsed.length > 10000) invalid();
  const collapsedFolders = collapsed.filter(path => typeof path === 'string' && path.trim());
  if (collapsedFolders.some(path => path.length > 1024 || /[\x00-\x1f\x7f]/.test(path))) invalid();

  const normalizeWorkspace = workspace => {
    if(!workspace||typeof workspace!=='object'||Array.isArray(workspace)||!Array.isArray(workspace.sessionIds)||workspace.sessionIds.length>64||workspace.sessionIds.some(id=>typeof id!=='string'||!id||id.length>128||!/^[A-Za-z0-9_-]+$/.test(id)||['__proto__','constructor','prototype'].includes(id))||!Number.isInteger(workspace.activeIndex)||workspace.activeIndex<0||workspace.activeIndex>=Math.max(1,workspace.sessionIds.length)||typeof workspace.split!=='boolean')invalid();
    const workspaceDirection=workspace.splitDirection??direction;if(!['columns','rows'].includes(workspaceDirection))invalid();
    const result = {sessionIds:[...workspace.sessionIds],activeIndex:workspace.activeIndex,split:workspace.split,splitDirection:workspaceDirection,splitColumns:tracks('splitColumns',[1,1],workspace),splitRows:tracks('splitRows',[1],workspace)};
    // A docked snapshot describes a *split* layout. When `split` is off the
    // renderer can still hold a stale tree for one tick; drop it rather than
    // rejecting the autosave, so the saved workspace always matches its flag.
    if (workspace.dockLayout !== undefined) {
      if (workspace.split) result.dockLayout = normalizeDockSnapshot(workspace.dockLayout, workspace.sessionIds.length);
    }
    return result;
  };
  const workspace = normalizeWorkspace(input.workspace ?? {sessionIds:[],activeIndex:0,split:false});
  // Older renderers save only the legacy layout. An omitted collection or
  // selection must preserve the named workspaces until explicitly replaced.
  const collection = input.workspaces === undefined ? (previous.workspaces ?? []) : input.workspaces;
  if (!Array.isArray(collection) || collection.length > 50) invalid();
  const uuid = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  const ids = new Set();
  const workspaces = collection.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !uuid(item.id) ||
        typeof item.name !== 'string' || item.name.length > 256 || !item.name.trim() || /[\x00-\x1f\x7f]/.test(item.name)) invalid();
    const id = item.id.toLowerCase();
    if (ids.has(id)) invalid();
    ids.add(id);
    return { id, name: item.name.trim(), workspace: normalizeWorkspace(item.workspace) };
  });
  const selected = input.selectedWorkspaceId === undefined ? (previous.selectedWorkspaceId ?? '') : input.selectedWorkspaceId;
  if (selected !== '' && (!uuid(selected) || !ids.has(selected.toLowerCase()))) invalid();
  // Selection is metadata for explicit restoration only; this module never
  // looks up sessions or starts connections, including during store loading.
  return { sidebarWidth:pixels,sidebarVisible:bool('sidebarVisible',true),commandVisible:bool('commandVisible',true),snippetsVisible:bool('snippetsVisible',false),splitDirection:direction,splitColumns:tracks('splitColumns',[1,1]),splitRows:tracks('splitRows',[1]),collapsedFolders:[...new Set(collapsedFolders)],workspace,workspaces,selectedWorkspaceId:selected.toLowerCase() };
}
module.exports = { layoutSettings };
