'use strict';
const own = (node, key) => Object.prototype.hasOwnProperty.call(node, key);
const AXES = ['columns', 'rows'];
const EDGES = ['left', 'right', 'top', 'bottom'];
function dockIds(tree) { return !tree ? [] : own(tree, 'id') ? [tree.id] : [...dockIds(tree.first), ...dockIds(tree.second)]; }
function mapDock(tree, map) {
  if (!tree) return null;
  if (own(tree, 'id')) { const id = map(tree.id); return id === null || id === undefined ? null : { id }; }
  const first = mapDock(tree.first, map), second = mapDock(tree.second, map);
  return !first ? second : !second ? first : { axis: tree.axis, ratio: tree.ratio, first, second };
}
function replaceDock(tree, id, replacement) {
  if (!tree) return null;
  if (own(tree, 'id')) return tree.id === id ? replacement : { ...tree };
  return { ...tree, first: replaceDock(tree.first, id, replacement), second: replaceDock(tree.second, id, replacement) };
}
function dockMove(tree, source, target, edge) {
  if (source === target || !EDGES.includes(edge) || !dockIds(tree).includes(target)) return null;
  const base = mapDock(tree, id => id === source ? null : id);
  const before = edge === 'left' || edge === 'top', axis = ['left', 'right'].includes(edge) ? 'columns' : 'rows';
  return replaceDock(base, target, { axis, ratio: .5, first: { id: before ? source : target }, second: { id: before ? target : source } });
}
function projectDock(tree, rectangle, gap = 4, path = []) {
  if (!tree) return { panes: [], dividers: [] };
  if (own(tree, 'id')) return { panes: [{ id: tree.id, ...rectangle }], dividers: [] };
  const horizontal = tree.axis === 'columns', extent = horizontal ? rectangle.width : rectangle.height;
  const actualGap = Math.min(gap, Math.max(0, extent)), available = Math.max(0, extent - actualGap), firstSize = available * tree.ratio;
  const first = { ...rectangle, [horizontal ? 'width' : 'height']: firstSize };
  const second = { ...rectangle, [horizontal ? 'x' : 'y']: rectangle[horizontal ? 'x' : 'y'] + firstSize + actualGap,
    [horizontal ? 'width' : 'height']: available - firstSize };
  const divider = { ...(horizontal ? { x: rectangle.x + firstSize, y: rectangle.y, width: actualGap, height: rectangle.height }
    : { x: rectangle.x, y: rectangle.y + firstSize, width: rectangle.width, height: actualGap }), axis: tree.axis, path, ratio: tree.ratio, parent: rectangle };
  const a = projectDock(tree.first, first, gap, [...path, 'first']), b = projectDock(tree.second, second, gap, [...path, 'second']);
  return { panes: [...a.panes, ...b.panes], dividers: [divider, ...a.dividers, ...b.dividers] };
}
function dockRatio(tree, path, ratio) {
  if (!tree || own(tree, 'id') || !Number.isFinite(ratio)) return tree;
  if (!path.length) return { ...tree, ratio: Math.max(.05, Math.min(.95, ratio)) };
  const [child, ...rest] = path;
  if (!['first', 'second'].includes(child)) return tree;
  return { ...tree, [child]: dockRatio(tree[child], rest, ratio) };
}
function dockEdge(rectangle, x, y) {
  if (rectangle.width <= 0 || rectangle.height <= 0) return null;
  const u = (x - rectangle.x) / rectangle.width, v = (y - rectangle.y) / rectangle.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [['right', 1 - u], ['left', u], ['bottom', 1 - v], ['top', v]].sort((a, b) => a[1] - b[1])[0][0];
}
// Convert the existing rows/columns grid only when a drag needs a nested tree.
function gridDock(ids, direction, columns = [], rows = []) {
  const chain = (nodes, axis, weights) => {
    if (!nodes.length) return null;
    if (nodes.length === 1) return nodes[0];
    const w = nodes.map((_, i) => weights[i] || 1), total = w.reduce((a, b) => a + b, 0), middle = Math.ceil(nodes.length / 2);
    return { axis, ratio: Math.max(.05, Math.min(.95, w.slice(0, middle).reduce((a, b) => a + b, 0) / total)),
      first: chain(nodes.slice(0, middle), axis, w.slice(0, middle)), second: chain(nodes.slice(middle), axis, w.slice(middle)) };
  };
  const count = direction === 'rows' ? 1 : Math.min(2, ids.length), groups = [];
  for (let i = 0; i < ids.length; i += Math.max(1, count)) groups.push(chain(ids.slice(i, i + count).map(id => ({ id })), 'columns', columns));
  return chain(groups, 'rows', rows);
}
function dockSnapshot(tree, ids) {
  const indexes = new Map(ids.map((id, index) => [id, index]));
  const selected = mapDock(tree, id => indexes.get(id));
  const encode = node => own(node, 'id') ? { tabIndex: node.id } : { axis: node.axis, ratio: node.ratio, first: encode(node.first), second: encode(node.second) };
  return selected && dockIds(selected).length > 1 ? encode(selected) : null;
}
function normalizeDockSnapshot(input, count) {
  const invalid = () => { throw Object.assign(new Error('드래그 분할 배치가 올바르지 않습니다.'), { code: 'ERR_VALIDATION' }); };
  const seen = new Set(); let nodes = 0;
  const read = (node, depth) => {
    if (++nodes > 127 || depth > 24 || !node || typeof node !== 'object' || Array.isArray(node) || ![Object.prototype, null].includes(Object.getPrototypeOf(node))) invalid();
    if (own(node, 'tabIndex')) {
      if (!Number.isInteger(node.tabIndex) || node.tabIndex < 0 || node.tabIndex >= count || seen.has(node.tabIndex)) invalid();
      seen.add(node.tabIndex); return { tabIndex: node.tabIndex };
    }
    if (!AXES.includes(node.axis) || !Number.isFinite(node.ratio) || node.ratio < .05 || node.ratio > .95 || !own(node, 'first') || !own(node, 'second')) invalid();
    return { axis: node.axis, ratio: node.ratio, first: read(node.first, depth + 1), second: read(node.second, depth + 1) };
  };
  const result = read(input, 0); if (seen.size < 2) invalid(); return result;
}
function restoreDock(snapshot, ids) {
  if (!snapshot) return null;
  const read = node => own(node, 'tabIndex') ? { id: node.tabIndex } : { ...node, first: read(node.first), second: read(node.second) };
  return mapDock(read(snapshot), index => ids[index] ?? null);
}
module.exports = { dockIds, mapDock, replaceDock, dockMove, projectDock, dockRatio, dockEdge, gridDock, dockSnapshot, normalizeDockSnapshot, restoreDock };
