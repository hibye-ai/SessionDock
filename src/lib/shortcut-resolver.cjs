'use strict';
const { getAction } = require('./shortcut-catalog.cjs');
const { normalizeSequence, strokeFromEvent } = require('./shortcut-keys.cjs');
const NONE = Object.freeze({ action: null, consume: false, prefix: false });
function createShortcutResolver(bindings, { now = () => performance.now(), prefixTimeout = 2000 } = {}) {
  if (!Array.isArray(bindings) || bindings.length > 256 || typeof now !== 'function' || !Number.isFinite(prefixTimeout) || prefixTimeout <= 0 || prefixTimeout > 60000) throw new TypeError('단축키 실행 설정이 올바르지 않습니다.');
  const index = new Map(); let pending = null, disposed = false;
  for (const source of bindings) {
    if (!source || !getAction(source.actionId) || !Number.isInteger(source.contexts) || source.contexts < 1 || source.contexts > 7 || typeof source.repeat !== 'boolean' || typeof source.isDefault !== 'boolean') throw new TypeError('단축키 실행 항목이 올바르지 않습니다.');
    const parts = normalizeSequence(source.sequence).split(' then '), row = Object.freeze({ actionId: source.actionId, contexts: source.contexts, repeat: source.repeat, isDefault: source.isDefault });
    let node = index.get(parts[0]); if (!node) index.set(parts[0], node = { single: [], next: new Map() });
    if (parts.length === 1) node.single.push(row);
    else { if (!node.next.has(parts[1])) node.next.set(parts[1], []); node.next.get(parts[1]).push(row); }
  }
  const reset = () => { pending = null; };
  const eligible = (row, mask, mapped) => !!(row.contexts & mask) && !(mask === 4 && mapped);
  const result = (row, repeat) => ({ action: repeat && !row.repeat ? null : row.actionId, consume: true, prefix: false });
  return Object.freeze({
    resolve(event, { terminal = false, editable = false, dialog = false, capture = false, sendTextMapped = false } = {}) {
      if (disposed) return NONE;
      if (dialog || capture) { reset(); return NONE; }
      if (!event || event.type !== 'keydown') return NONE;
      const stroke = strokeFromEvent(event), mask = terminal ? 4 : editable ? 2 : 1;
      if (!stroke) {
        if (event.defaultPrevented || event.metaKey || !/^(?:Alt|Control|Shift)(?:Left|Right)$/.test(event.code || '')) reset();
        return NONE;
      }
      const time = now();
      if (pending && (pending.mask !== mask || time - pending.at >= prefixTimeout || time < pending.at)) reset();
      if (pending) {
        if (stroke.stroke === 'Escape') { reset(); return { action: null, consume: true, prefix: false }; }
        if (stroke.repeat && stroke.stroke === pending.first) return { action: null, consume: true, prefix: true };
        const row = pending.node.next.get(stroke.stroke)?.find(row => eligible(row, mask, sendTextMapped)); reset();
        if (row) return result(row, stroke.repeat);
        // An unmatched key remains ordinary input, or starts another shortcut.
      }
      const node = index.get(stroke.stroke); if (!node) return NONE;
      const row = node.single.find(row => eligible(row, mask, sendTextMapped)); if (row) return result(row, stroke.repeat);
      if ([...node.next.values()].some(rows => rows.some(row => eligible(row, mask, sendTextMapped)))) {
        if (!stroke.repeat) pending = { node, first: stroke.stroke, mask, at: time };
        return { action: null, consume: true, prefix: !!pending };
      }
      return NONE;
    }, reset,
    dispose() { reset(); disposed = true; index.clear(); }
  });
}
module.exports = { createShortcutResolver };
