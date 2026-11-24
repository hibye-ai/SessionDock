import { dockIds, dockMove, projectDock, dockRatio, dockEdge, normalizeDockSnapshot, dockSnapshot } from './terminal-docking.cjs';

const TYPE = 'application/x-sessiondock-tab';
const SESSION_TYPE = 'application/x-sessiondock-session';
const LABELS = { left: '왼쪽에 분할', right: '오른쪽에 분할', top: '위에 분할', bottom: '아래에 분할' };
const MIN_WIDTH = 96, MIN_HEIGHT = 64;
const place = (node, r) => { for (const [property, key] of [['left', 'x'], ['top', 'y'], ['width', 'width'], ['height', 'height']]) node.style[property] = `${r[key]}px`; };

export function installTerminalDockUI(ctx) {
  const root = document.getElementById('terminal-panes');
  const preview = document.createElement('div'); preview.className = 'terminal-dock-preview hidden';
  preview.setAttribute('aria-hidden', 'true'); preview.append(document.createElement('span')); root.append(preview);
  let frame, dividerDrag = null, lastPreview = null;
  const clearPreview = () => { lastPreview = null; preview.classList.add('hidden'); delete preview.dataset.edge; delete preview.dataset.sourceId; };
  const canDrag = () => !!ctx.dragId() && ctx.connections().has(ctx.dragId());
  const sessionPlan = event => {
    const sessionId=ctx.sessionDragId?.();
    if(!sessionId||!ctx.sessionExists(sessionId)||document.querySelector('dialog[open]')||![...event.dataTransfer.types].includes(SESSION_TYPE))return null;
    const pane=event.target.closest('.terminal-pane');if(!pane||pane.classList.contains('hidden')||!root.contains(pane))return null;
    const target=pane.dataset.connectionId,c=ctx.connections().get(target);if(!c||c.closing||c.closePending)return null;
    const rect=pane.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;
    if(x<0||x>1||y<0||y>1)return null;
    const basis=ctx.tree()||ctx.legacyTree(),source='@new-session',edge=x>.22&&x<.78&&y>.22&&y<.78?'center':dockEdge({x:rect.left,y:rect.top,width:rect.width,height:rect.height},event.clientX,event.clientY);
    if(edge==='center')return {sessionId,source,target,edge,tree:null,area:{x:0,y:0,width:root.clientWidth,height:root.clientHeight}};
    const tree=dockMove(basis,source,target,edge);if(!tree)return null;
    const ids=dockIds(tree);try{normalizeDockSnapshot(dockSnapshot(tree,ids),ids.length);}catch{return null;}
    const projected=projectDock(tree,{x:0,y:0,width:root.clientWidth,height:root.clientHeight}),area=projected.panes.find(p=>p.id===source);
    if(!area||projected.panes.some(p=>p.width<MIN_WIDTH||p.height<MIN_HEIGHT))return null;
    return {sessionId,source,target,edge,basis,tree,area};
  };
  const plan = event => {
    if (!canDrag() || ctx.connections().size < 2 || ![...event.dataTransfer.types].includes(TYPE) || document.querySelector('dialog[open]')) return null;
    const source = ctx.dragId(), record = ctx.connections().get(source), rect = root.getBoundingClientRect();
    if (record.closing || record.closePending || rect.width < MIN_WIDTH * 2 || rect.height < MIN_HEIGHT * 2 || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
    let pane = event.target.closest('.terminal-pane');
    if (!pane || pane.classList.contains('hidden') || !root.contains(pane)) return null;
    let target = pane.dataset.connectionId, basis = ctx.tree() || ctx.legacyTree();
    // Dragging the currently visible tab in normal mode pairs it with the
    // next existing tab; it never clones or reconnects the source connection.
    if (target === source && !ctx.split()) {
      target = [...ctx.connections().keys()].find(id => id !== source); basis = { id: target };
    }
    if (!ctx.connections().has(target) || ctx.connections().get(target).closing || ctx.connections().get(target).closePending || target === source) return null;
    const p = pane.getBoundingClientRect(), edge = dockEdge({ x: p.left, y: p.top, width: p.width, height: p.height }, event.clientX, event.clientY);
    const tree = dockMove(basis, source, target, edge);
    if (!tree) return null;
    const ids = dockIds(tree);
    try { normalizeDockSnapshot(dockSnapshot(tree, ids), ids.length); } catch { return null; }
    const projection = projectDock(tree, { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight });
    const area = projection.panes.find(item => item.id === source);
    if (!area || projection.panes.some(item => item.width < MIN_WIDTH || item.height < MIN_HEIGHT)) return null;
    return { tree, source, target, edge, area };
  };
  const showPreview = action => {
    if (!action) { clearPreview(); return; }
    lastPreview = action;
    place(preview, action.area); preview.dataset.edge = action.edge; preview.dataset.sourceId = action.source;
    preview.firstChild.textContent = action.sessionId?(action.edge==='center'?'새 탭으로 연결':LABELS[action.edge]+'하여 연결'):LABELS[action.edge]; preview.classList.remove('hidden');
  };
  root.addEventListener('dragover', event => {
    const action = ctx.sessionDragId?.()?sessionPlan(event):plan(event); showPreview(action);
    if (action) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = action.sessionId?'copy':'move'; }
  });
  root.addEventListener('drop', event => {
    const pending = lastPreview, action = ctx.sessionDragId?.()?sessionPlan(event):plan(event); clearPreview();
    if (!pending || !action || pending.sessionId !== action.sessionId || pending.source !== action.source || pending.target !== action.target || JSON.stringify(pending.tree) !== JSON.stringify(action.tree)
      || ['x', 'y', 'width', 'height'].some(key => Math.abs(pending.area[key] - action.area[key]) > 1)) return;
    event.preventDefault(); event.stopPropagation();
    if(action.sessionId){
      ctx.endSessionDrag();
      Promise.resolve(ctx.openSession(action.sessionId)).then(id=>{
        if(!id||action.edge==='center'||!ctx.connections().has(id))return;
        // A closed target during IPC must not reappear as an orphan pane.
        if(!ctx.connections().has(action.target)||dockIds(action.basis).some(key=>!ctx.connections().has(key)))return;
        const tree=dockMove(action.basis,id,action.target,action.edge);if(tree)ctx.commit(tree,id);
      }).catch(ctx.onError);
      return;
    }
    ctx.commit(action.tree, action.source); ctx.endDrag();
  });
  document.addEventListener('dragover', event => { if (!root.contains(event.target)) clearPreview(); }, true);
  root.addEventListener('dragleave', event => {
    const r = root.getBoundingClientRect();
    if (event.clientX <= r.left || event.clientX >= r.right || event.clientY <= r.top || event.clientY >= r.bottom) clearPreview();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') {if(canDrag())ctx.endDrag();if(ctx.sessionDragId?.())ctx.endSessionDrag();clearPreview();} }, true);
  window.addEventListener('blur', () => { if (canDrag()) ctx.endDrag();if(ctx.sessionDragId?.())ctx.endSessionDrag(); });
  const schedule = () => {
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (ctx.tree()) renderLayout(); });
  };
  new ResizeObserver(() => { clearPreview(); schedule(); }).observe(root);
  const updateRatio = (path, value) => { const tree = ctx.tree(); if (!tree) return; ctx.setTree(dockRatio(tree, path, value)); renderLayout(false); ctx.fit(); };
  function renderLayout(rebuild = true) {
    const tree = ctx.tree(); if (!tree) return;
    const layout = projectDock(tree, { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight });
    for (const area of layout.panes) { const c = ctx.connections().get(area.id); if (c) place(c.pane, area); }
    if (rebuild && !dividerDrag) {
      root.querySelectorAll('.split-divider').forEach(node => node.remove());
      for (const d of layout.dividers) {
        const divider = document.createElement('div'); divider.className = 'split-divider dock-divider'; divider.tabIndex = 0;
        divider.dataset.axis = d.axis; divider.dataset.dockPath = JSON.stringify(d.path);
        divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', d.axis === 'columns' ? 'vertical' : 'horizontal');
        divider.setAttribute('aria-label', d.axis === 'columns' ? '좌우 분할 크기' : '상하 분할 크기');
        divider.setAttribute('aria-valuemin', '5'); divider.setAttribute('aria-valuemax', '95'); divider.title = '드래그해 크기 조절 · 두 번 클릭하면 같은 크기로';
        divider.addEventListener('pointerdown', event => {
          if (event.button !== 0 || !ctx.tree()) return;
          event.preventDefault(); const current = projectDock(ctx.tree(), { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight }).dividers.find(item => JSON.stringify(item.path) === divider.dataset.dockPath);
          if (!current) return;
          dividerDrag = { path: d.path, start: d.axis === 'columns' ? event.clientX : event.clientY, ratio: current.ratio,
            available: Math.max(1, current.parent[d.axis === 'columns' ? 'width' : 'height'] - 4), minimum: d.axis === 'columns' ? MIN_WIDTH : MIN_HEIGHT };
          divider.setPointerCapture(event.pointerId);
        });
        divider.addEventListener('pointermove', event => {
          if (!dividerDrag) return;
          const delta = (d.axis === 'columns' ? event.clientX : event.clientY) - dividerDrag.start;
          const minimum = Math.min(.45, dividerDrag.minimum / dividerDrag.available);
          updateRatio(dividerDrag.path, Math.max(minimum, Math.min(1 - minimum, dividerDrag.ratio + delta / dividerDrag.available)));
        });
        const finish = () => { if (dividerDrag) { dividerDrag = null; schedule(); } };
        divider.addEventListener('pointerup', finish); divider.addEventListener('lostpointercapture', finish);
        divider.addEventListener('keydown', event => {
          const keys = d.axis === 'columns' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
          if (!keys.includes(event.key)) return; event.preventDefault();
          const current = projectDock(ctx.tree(), { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight }).dividers.find(item => JSON.stringify(item.path) === divider.dataset.dockPath);
          if (current) updateRatio(d.path, current.ratio + (event.key === keys[0] ? -.025 : .025));
        });
        divider.addEventListener('dblclick', () => updateRatio(d.path, .5)); root.append(divider);
      }
    }
    for (const node of root.querySelectorAll('.dock-divider')) {
      const d = layout.dividers.find(item => JSON.stringify(item.path) === node.dataset.dockPath);
      if (d) { place(node, d); node.setAttribute('aria-valuenow', String(Math.round(d.ratio * 100))); }
    }
    ctx.fit();
  }
  return {
    clearPreview, renderLayout,
    startDrag(event, id) {
      const c = ctx.connections().get(id); if (!c || c.closing || event.target.closest('.tab-close')) { event.preventDefault(); return; }
      ctx.setDragId(id); clearPreview(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(TYPE, 'move'); event.currentTarget.classList.add('dragging');
    },
    reset() { dividerDrag = null; clearPreview(); root.querySelectorAll('.dock-divider').forEach(node => node.remove());
      for (const c of ctx.connections().values()) for (const key of ['left', 'top', 'width', 'height']) c.pane.style.removeProperty(key); }
  };
}
