'use strict';

// Profile data and Korean sort/search keys change on bootstrap, not on scrolling.
class SessionTreeModel {
  constructor(sessions, folders = [], sources = []) {
    this.sessions = new Map(sessions.map(session => [session.id, session]));
    this.records = [...sessions].sort((a, b) => SessionTreeModel.collator.compare(a.name, b.name)).map(session => ({
      session, text: `${session.name} ${session.host} ${session.username} ${session.folder} ${(session.tags || []).join(' ')}`.toLowerCase()
    }));
    this.root = { children: new Map(), sessions: [] };
    this.folders = new Map();
    const ensure = (path, base = this.root) => {
      let node = base, current = base.path || '';
      for (const part of path.split('/').filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        if (!node.children.has(part)) {
          const child = { name: part, path: current, children: new Map(), sessions: [], sharedSourceId: base.sharedSourceId || '' };
          node.children.set(part, child); this.folders.set(current, child);
        }
        node = node.children.get(part);
      }
      return node;
    };
    for (const path of folders) ensure(path).explicit = true;
    const shared = new Map();
    const sharedRoot = id => {
      if (!shared.has(id)) {
        const source = sources.find(source => source.id === id);
        const node = { name: `공유 · ${source?.name || '세션'}`, path: `@shared/${id}`, sharedSourceId: id, source, children: new Map(), sessions: [], sharedRoot: true };
        shared.set(id, node); this.root.children.set(Symbol(id), node); this.folders.set(node.path, node);
      }
      return shared.get(id);
    };
    for (const source of sources) {
      const root = sharedRoot(source.id);
      for (const path of source.folders || []) ensure(path, root).explicit = true;
    }
    for (const { session } of this.records) {
      let node;
      if (session.sharedSourceId) node = session.folder ? ensure(session.folder, sharedRoot(session.sharedSourceId)) : sharedRoot(session.sharedSourceId);
      else if (session.folder) node = ensure(session.folder);
      else {
        if (!this.unassigned) {
          this.unassigned = { name: '미분류', path: '', virtual: true, children: new Map(), sessions: [] };
          this.root.children.set(Symbol('unassigned'), this.unassigned); this.folders.set('', this.unassigned);
        }
        node = this.unassigned;
      }
      node.sessions.push(session);
    }
    const sort = node => { node.children = [...node.children.values()].sort((a, b) => SessionTreeModel.collator.compare(a.name, b.name)); node.children.forEach(sort); node.total = node.sessions.length + node.children.reduce((sum,child)=>sum+child.total,0); };
    sort(this.root);
  }

  view({ filter = 'all', search = '', online = new Set(), collapsed = new Set() } = {}) {
    const text = search.toLowerCase();
    const queryKey = JSON.stringify([filter, text, filter === 'online' ? [...online].sort() : null]);
    let query = queryKey === this.query?.key ? this.query : filter === 'all' && !text ? this.allQuery : null;
    if (!query) {
      const matches = new Set(this.records.filter(({ session, text: candidate }) =>
        (filter !== 'favorite' || session.favorite) && (filter !== 'online' || online.has(session.id)) && candidate.includes(text)
      ).map(({ session }) => session.id));
      const info = new Map();
      const visit = node => {
        let count = node.sessions.reduce((sum, session) => sum + Number(matches.has(session.id)), 0), children = false;
        for (const child of node.children) { const result = visit(child); count += result.count; children ||= result.include; }
        const empty = filter === 'all' && ((node.explicit && (!text || node.path.toLowerCase().includes(text))) || (node.sharedRoot && !text));
        const result = { count, include: count > 0 || children || empty }; info.set(node, result); return result;
      };
      visit(this.root); query = { key: queryKey, matches, info };
      if (filter === 'all' && !text) this.allQuery = query;
    }
    this.query = query;
    const key = `${queryKey}:${search ? '' : JSON.stringify([...collapsed])}`;
    if (this.lastView?.key === key) return this.lastView;
    const items = [], sessionIds = [], index = new Map(); let height = 0;
    const append = item => { item.offset = height; height += item.height; index.set(item.key, items.length); items.push(item); };
    const flatten = (node, depth = 0) => {
      for (const child of node.children) {
        const { count, include } = query.info.get(child); if (!include) continue;
        const closed = !search && collapsed.has(child.path);
        append({ kind: 'folder', key: `folder:${child.path}`, node: child, depth, count, collapsed: closed, height: 26 });
        if (!closed) flatten(child, depth + 1);
      }
      for (const session of node.sessions) if (query.matches.has(session.id)) {
        append({ kind: 'session', key: `session:${session.id}`, session, depth, height: 27 }); sessionIds.push(session.id);
      }
    };
    flatten(this.root);
    return this.lastView = { key, items, sessionIds, index, height, matchedCount: query.matches.size };
  }
}
SessionTreeModel.collator = new Intl.Collator('ko');

function viewportRange(items, scrollTop, clientHeight, overscan = 10) {
  const lowerBound = value => {
    let low = 0, high = items.length;
    while (low < high) { const mid = (low + high) >>> 1; if (items[mid].offset + items[mid].height <= value) low = mid + 1; else high = mid; }
    return low;
  };
  return { start: Math.max(0, lowerBound(scrollTop) - overscan), end: Math.min(items.length, lowerBound(scrollTop + clientHeight) + overscan + 1) };
}
module.exports = { SessionTreeModel, viewportRange };
