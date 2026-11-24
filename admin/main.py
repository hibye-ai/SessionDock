import argparse
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid

import core

def publish_and_persist(app,path):
    revision=core.publish(path,app.catalog,app.revision if app.source else None)
    app.source=path; app.revision=revision; app.dirty=False
    try:
        app.persist()
    except Exception as exc:
        app.local_save_failed=True
        return exc
    app.local_save_failed=False
    return None

def close_after_guard(app,guard=None):
    if not (guard or app.guard)(): return None
    try: app.persist()
    except Exception as exc:
        app.local_save_failed=True
        return exc
    app.local_save_failed=False
    if getattr(app,'timer',None): app.root.after_cancel(app.timer); app.timer=None
    app.project.close(); app.root.destroy()
    return None

def self_test():
    a={'id':'sample-a','name':'장비','host':'192.0.2.1','protocol':'ssh','port':22,'folder':'본사'}
    cat=core.validate_catalog({'version':1,'sessions':[a],'folders':['본사'],'snippets':[]})
    plan=core.plan_merge(cat,[dict(a,host='192.0.2.2')])
    out=core.apply_plan(cat,plan)
    with tempfile.TemporaryDirectory() as d:
        p=Path(d)/'shared.json'; rev=core.publish(p,cat,None); rev2=core.publish(p,out,rev)
        loaded,actual=core.load_catalog(p)
        if actual!=rev2 or loaded['sessions'][0]['host']!='192.0.2.2' or not list(Path(d).glob('shared.json.*.bak.json')): raise RuntimeError('self-test failed')
        try: core.publish(p,cat,rev)
        except core.ConflictError: pass
        else: raise RuntimeError('CAS self-test failed')
    return {'ok':True,'checks':['merge','publish','backup','revision']}

def cli():
    parser=argparse.ArgumentParser(); parser.add_argument('--self-test',action='store_true'); parser.add_argument('--validate',metavar='FILE'); parser.add_argument('--report',metavar='FILE'); args=parser.parse_args()
    if args.self_test or args.validate:
        try:
            result=self_test() if args.self_test else {'ok':True,'sessions':len(core.load_catalog(args.validate)[0]['sessions'])}
            code=0
        except Exception as exc: result={'ok':False,'error':str(exc)}; code=1
        data=json.dumps(result,ensure_ascii=False,indent=2)
        if args.report: Path(args.report).write_text(data+'\n',encoding='utf-8')
        else: print(data)
        return code
    if args.report: parser.error('--report requires --self-test or --validate')
    return run_gui()

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, font as tkfont
import ui

HISTORY_MAX_STEPS=20
HISTORY_MAX_BYTES=16*1024*1024

class ImportOptions(ttk.Frame):
    def __init__(self, parent):
        super().__init__(parent)
        self.count=tk.StringVar(value='자동'); self.header=tk.BooleanVar(value=True); self.has_id=tk.BooleanVar(value=False)
        top=ttk.Frame(self); top.pack(fill='x')
        ttk.Label(top,text='폴더 열 수 (0~16)').pack(side='left')
        ttk.Combobox(top,values=['자동']+[str(n) for n in range(17)],state='readonly',textvariable=self.count,width=6).pack(side='left',padx=6)
        ttk.Button(top,text='폴더 없음',command=lambda:self.count.set('0')).pack(side='left',padx=(0,8))
        checks=ttk.Frame(self); checks.pack(fill='x',pady=(4,0))
        ttk.Checkbutton(checks,text='첫 행은 제목',variable=self.header).pack(side='left')
        ttk.Checkbutton(checks,text='첫 열은 ID',variable=self.has_id).pack(side='left',padx=10)
        self.guide=ttk.Label(self,justify='left',wraplength=700); self.guide.pack(anchor='w',fill='x',pady=(5,0))
        self.count.trace_add('write',self.update_guide); self.has_id.trace_add('write',self.update_guide)
        self.bind('<Configure>',lambda e:self.guide.configure(wraplength=max(160,e.width-10)))
        self.update_guide()
    def values(self):
        if self.count.get()=='자동': return 'auto',self.header.get(),self.has_id.get()
        try: count=int(self.count.get())
        except ValueError: raise ValueError('폴더 열 수는 0~16의 정수여야 합니다.') from None
        if not 0<=count<=16: raise ValueError('폴더 열 수는 0~16의 정수여야 합니다.')
        return count,self.header.get(),self.has_id.get()
    def update_guide(self,*args):
        try:
            count,_,has_id=self.values(); self.guide.config(text=ui.import_columns(count,has_id))
        except ValueError as e: self.guide.config(text=str(e))

class App:
    def __init__(self,root):
        self.root=root; root.title('SessionDock Admin'); root.geometry('1080x680'); root.minsize(760,480)
        path=Path(os.environ.get('LOCALAPPDATA',str(Path.home()))) / 'SessionDock Admin'; path.mkdir(parents=True,exist_ok=True)
        self.project=core.Project(path/'project.sqlite3'); saved=self.project.load()
        self.catalog,self.source,self.revision,self.dirty=saved if saved else (core.validate_catalog({'version':1,'sessions':[]}),None,None,False)
        self.pending=None; self.page=0; self.timer=None; self.local_save_failed=False
        self.history=[]; self.history_index=-1; self.history_notice=''
        self.folder=ui.ALL; self.sort='name'; self.descending=False; self.folder_ids={}; self.detail_visible=True
        style=ttk.Style(root)
        if 'clam' in style.theme_names(): style.theme_use('clam')
        style.configure('.',font=('맑은 고딕',9),background='#f3f7f7',foreground='#213738')
        style.configure('Treeview',background='#ffffff',fieldbackground='#ffffff',rowheight=25)
        style.map('Treeview',background=[('selected','#147d7b')],foreground=[('selected','#ffffff')])
        style.configure('Accent.TButton',background='#147d7b',foreground='white',padding=(10,5))
        style.map('Accent.TButton',background=[('active','#106866')])
        style.configure('Title.TLabel',font=('맑은 고딕',13,'bold'))
        menu=tk.Menu(root); root.config(menu=menu)
        for title,items in [('파일',[('새 문서',self.new),('JSON 열기',self.open),('최신 작업 다시 불러오기',self.reload_latest),('저장 / 게시',self.publish),('TSV 내보내기',self.export_tsv)]),('가져오기',[('엑셀',self.excel),('CSV / TSV',self.open_tsv),('붙여넣기',self.paste)]),('세션',[('추가',self.add),('수정',self.edit),('복제',self.duplicate),('폴더 변경',self.change_folder),('삭제',self.delete)])]:
            sub=tk.Menu(menu,tearoff=False)
            for label,fn in items: sub.add_command(label=label,command=fn)
            menu.add_cascade(label=title,menu=sub)
        self.history_menu=tk.Menu(menu,tearoff=False); self.history_menu.add_command(label='실행 취소',command=self.undo); self.history_menu.add_command(label='다시 실행',command=self.redo); menu.add_cascade(label='편집',menu=self.history_menu)
        header=ttk.Frame(root,padding=(10,3)); header.pack(fill='x')
        ttk.Label(header,text='세션 관리자',style='Title.TLabel').pack(side='left')
        self.state_label=ttk.Label(header); self.state_label.pack(side='right')
        self.pathlabel=ttk.Label(root,anchor='w',padding=(10,0,10,4)); self.pathlabel.pack(fill='x')
        bar=ttk.Frame(root,padding=(8,0,8,6)); bar.pack(fill='x')
        general=ttk.Frame(bar); general.pack(fill='x')
        for label,fn in [('새 문서',self.new),('JSON 열기',self.open)]: ttk.Button(general,text=label,command=fn).pack(side='left',padx=2)
        ttk.Button(general,text='저장 / 게시',style='Accent.TButton',command=self.publish).pack(side='right')
        self.undo_button=ttk.Button(general,text='실행 취소',command=self.undo); self.undo_button.pack(side='left',padx=(12,2))
        self.redo_button=ttk.Button(general,text='다시 실행',command=self.redo); self.redo_button.pack(side='left',padx=2)
        imports=ttk.Frame(bar); imports.pack(fill='x',pady=(4,0)); ttk.Label(imports,text='가져오기').pack(side='left',padx=(2,6))
        for label,fn in [('엑셀',self.excel),('CSV / TSV',self.open_tsv),('붙여넣기',self.paste)]: ttk.Button(imports,text=label,command=fn).pack(side='left',padx=2)
        body=ttk.Frame(root,padding=(8,0,8,8)); body.pack(fill='both',expand=True)
        body.columnconfigure(1,weight=1); body.rowconfigure(0,weight=1)
        self.folder_panel=ttk.Frame(body,width=170); self.folder_panel.grid(row=0,column=0,sticky='nsew',padx=(0,7)); self.folder_panel.pack_propagate(False)
        ttk.Label(self.folder_panel,text='폴더').pack(anchor='w',pady=(0,4))
        self.folder_tree=ttk.Treeview(self.folder_panel,show='tree',selectmode='browse'); self.folder_tree.pack(side='left',fill='both',expand=True)
        fs=ttk.Scrollbar(self.folder_panel,orient='vertical',command=self.folder_tree.yview); fs.pack(side='right',fill='y'); self.folder_tree.configure(yscrollcommand=fs.set)
        self.folder_tree.bind('<<TreeviewSelect>>',self.folder_changed)
        center=ttk.Frame(body); center.grid(row=0,column=1,sticky='nsew'); center.rowconfigure(1,weight=1); center.columnconfigure(0,weight=1)
        filters=ttk.Frame(center); filters.grid(row=0,column=0,sticky='ew',pady=(0,5)); ttk.Label(filters,text='검색').pack(side='left')
        self.query=tk.StringVar(); self.search=ttk.Entry(filters,textvariable=self.query); self.search.pack(side='left',fill='x',expand=True,padx=5); self.query.trace_add('write',self.debounce)
        self.protocol_filter=tk.StringVar(value='전체')
        protocol=ttk.Combobox(filters,textvariable=self.protocol_filter,values=('전체','SSH','Telnet'),state='readonly',width=8); protocol.pack(side='left',padx=(0,5)); protocol.bind('<<ComboboxSelected>>',lambda e:self.filter_changed())
        ttk.Button(filters,text='초기화',command=self.clear_filters).pack(side='left')
        container=ttk.Frame(center); container.grid(row=1,column=0,sticky='nsew'); container.rowconfigure(0,weight=1); container.columnconfigure(0,weight=1)
        cols=('name','host','protocol','port','folder'); self.tree=ttk.Treeview(container,columns=cols,show='headings',selectmode='extended')
        for c,title,width in [('name','이름',160),('host','주소',150),('protocol','프로토콜',90),('port','포트',65),('folder','폴더',150)]:
            self.tree.heading(c,text=title,command=lambda col=c:self.sort_by(col)); self.tree.column(c,width=width,minwidth=55,stretch=True)
        self.tree.tag_configure('odd',background='#f0f7f6'); self.tree.grid(row=0,column=0,sticky='nsew')
        sy=ttk.Scrollbar(container,orient='vertical',command=self.tree.yview); sy.grid(row=0,column=1,sticky='ns')
        sx=ttk.Scrollbar(container,orient='horizontal',command=self.tree.xview); sx.grid(row=1,column=0,sticky='ew'); self.tree.configure(yscrollcommand=sy.set,xscrollcommand=sx.set)
        self.tree.bind('<Double-1>',self.double_click); self.tree.bind('<<TreeviewSelect>>',self.selection_changed)
        bottom=ttk.Frame(center); bottom.grid(row=2,column=0,sticky='ew',pady=(6,0))
        ttk.Button(bottom,text='추가',command=self.add).pack(side='left'); self.edit_button=ttk.Button(bottom,text='수정',command=self.edit); self.edit_button.pack(side='left',padx=3)
        self.delete_button=ttk.Button(bottom,text='삭제',command=self.delete); self.delete_button.pack(side='left')
        more=ttk.Frame(center); more.grid(row=3,column=0,sticky='ew',pady=(3,0))
        self.duplicate_button=ttk.Button(more,text='복제',command=self.duplicate); self.duplicate_button.pack(side='left')
        self.folder_button=ttk.Button(more,text='폴더 변경',command=self.change_folder); self.folder_button.pack(side='left',padx=3)
        self.details_button=ttk.Button(more,text='상세',command=self.show_details); self.details_button.pack(side='left')
        pages=ttk.Frame(center); pages.grid(row=4,column=0,sticky='ew',pady=(4,0))
        self.selection_label=ttk.Label(pages); self.selection_label.pack(side='left')
        self.next_button=ttk.Button(pages,text='다음',command=lambda:self.turn(1)); self.next_button.pack(side='right')
        self.prev_button=ttk.Button(pages,text='이전',command=lambda:self.turn(-1)); self.prev_button.pack(side='right',padx=3)
        self.status=ttk.Label(pages,anchor='e'); self.status.pack(side='right',padx=8)
        self.detail=ttk.LabelFrame(body,text='선택한 세션',padding=8,width=210); self.detail.grid(row=0,column=2,sticky='nsew',padx=(7,0)); self.detail.pack_propagate(False)
        self.detail_hint=ttk.Label(self.detail,text='세션을 선택하세요.'); self.detail_hint.pack(anchor='w',pady=(0,6))
        self.details={}
        for key,label in [('name','이름'),('host','주소'),('protocol','프로토콜'),('port','포트'),('folder','폴더'),('id','ID')]:
            ttk.Label(self.detail,text=label).pack(anchor='w'); value=tk.StringVar(); entry=ttk.Entry(self.detail,textvariable=value,state='readonly'); entry.pack(fill='x',pady=(0,5)); self.details[key]=value
        root.bind('<Configure>',self.resize); root.protocol('WM_DELETE_WINDOW',self.close)
        for key,fn in [('<Control-o>',self.open),('<Control-s>',self.publish),('<Control-f>',lambda:self.search.focus_set())]: root.bind(key,lambda e,f=fn:self.shortcut(e,f))
        for key,fn in [('<Insert>',self.add),('<Delete>',self.delete),('<F2>',self.edit),('<Return>',self.edit)]: self.tree.bind(key,lambda e,f=fn:self.shortcut(e,f))
        self.tree.bind('<Control-z>',lambda e:self.shortcut(e,self.undo)); self.tree.bind('<Control-y>',lambda e:self.shortcut(e,self.redo))
        self.refresh()
    def persist(self): self.project.save(self.catalog,self.source,self.revision,self.dirty)
    def guard(self,skip_local_failure=False):
        if self.pending and not messagebox.askyesno('확인','진행 중인 가져오기를 취소하시겠습니까?',parent=self.root): return False
        if self.local_save_failed and not skip_local_failure and not messagebox.askyesno('확인','로컬 작업 저장에 실패했습니다. 계속하시겠습니까?',parent=self.root): return False
        if self.dirty and not messagebox.askyesno('확인','게시하지 않은 변경 사항이 있습니다. 계속하시겠습니까?',parent=self.root): return False
        return True
    def new(self):
        if not self.guard(): return
        try:
            cat=core.validate_catalog({'version':1,'sessions':[]}); self.project.save(cat,None,None,False)
            self.catalog,self.source,self.revision,self.dirty,self.pending=cat,None,None,False,None; self.local_save_failed=False; self.clear_history(); self.reset_view(); self.refresh()
        except Exception as e: messagebox.showerror('새 문서 실패',str(e),parent=self.root)
    def open(self):
        if not self.guard(): return
        path=filedialog.askopenfilename(filetypes=[('JSON','*.json')],parent=self.root)
        if not path: return
        try:
            cat,rev=core.load_catalog(path); self.project.save(cat,path,rev,False)
            self.catalog,self.source,self.revision,self.dirty,self.pending=cat,path,rev,False,None; self.local_save_failed=False; self.clear_history(); self.reset_view(); self.refresh()
        except Exception as e: messagebox.showerror('열기 실패',str(e),parent=self.root)
    def reload_latest(self):
        if not messagebox.askyesno('최신 작업 다시 불러오기','현재 창의 작업과 실행 취소 기록을 버리고 최신 작업을 불러오시겠습니까?',parent=self.root): return
        try:
            saved=self.project.reload()
            cat,source,revision,dirty=saved if saved else (core.validate_catalog({'version':1,'sessions':[]}),None,None,False)
        except Exception as e:
            messagebox.showerror('다시 불러오기 실패',str(e),parent=self.root); return
        self.catalog,self.source,self.revision,self.dirty,self.pending=cat,source,revision,dirty,None
        self.local_save_failed=False; self.clear_history(); self.reset_view()
        self.sort='name'; self.descending=False; self.tree.selection_remove(*self.tree.selection()); self.tree.focus('')
        self.refresh()
    def publish(self):
        if self.pending: messagebox.showerror('게시 불가','가져오기 미리보기를 먼저 완료하거나 닫으세요.',parent=self.root); return
        path=self.source or filedialog.asksaveasfilename(defaultextension='.json',filetypes=[('JSON','*.json')],parent=self.root)
        if not path: return
        try:
            local_error=publish_and_persist(self,path)
        except Exception as e:
            messagebox.showerror('게시 실패',str(e),parent=self.root); return
        self.clear_history(); self.refresh()
        if local_error: messagebox.showwarning('게시 완료 · 로컬 저장 실패','공유 JSON은 게시되었으나 로컬 작업본 저장에 실패했습니다. 현재 창에서 다시 저장 / 게시할 수 있습니다.\n'+str(local_error),parent=self.root)
        else: messagebox.showinfo('저장 완료','저장되었습니다.\n'+str(path),parent=self.root)
    def debounce(self,*args):
        if self.timer: self.root.after_cancel(self.timer)
        self.timer=self.root.after(250,self.filter_changed)
    def filter_changed(self): self.timer=None; self.page=0; self.refresh()
    def clear_filters(self):
        self.query.set(''); self.protocol_filter.set('전체')
        if self.timer: self.root.after_cancel(self.timer); self.timer=None
        self.filter_changed()
    def reset_view(self):
        if self.timer: self.root.after_cancel(self.timer); self.timer=None
        self.query.set('')
        self.protocol_filter.set('전체')
        if self.timer: self.root.after_cancel(self.timer); self.timer=None
        self.folder=ui.ALL; self.page=0; self.folder_signature=None
    def shortcut(self,event,fn):
        if self.root.grab_current() is not None: return 'break'
        fn(); return 'break'
    def resize(self,event):
        if event.widget is not self.root: return
        visible=event.width >= 980
        if visible != self.detail_visible:
            self.detail_visible=visible
            if visible: self.detail.grid()
            else: self.detail.grid_remove()
    def sort_by(self,column):
        if self.sort==column: self.descending=not self.descending
        else: self.sort=column; self.descending=False
        self.refresh()
    def double_click(self,event):
        if self.tree.identify_region(event.x,event.y) not in ('cell','tree'): return
        row=self.tree.identify_row(event.y)
        if row:
            self.tree.selection_set(row); self.tree.focus(row); self.edit()
    def folder_changed(self,event=None):
        selected=self.folder_tree.selection()
        if not selected or selected[0] not in self.folder_ids: return
        folder=self.folder_ids[selected[0]]
        if folder != self.folder:
            self.folder=folder; self.page=0; self.refresh()
    def refresh_folders(self):
        paths=ui.folder_paths(self.catalog['folders'],self.catalog['sessions'])
        signature=tuple(paths)
        if getattr(self,'folder_signature',None)==signature: return
        opened={self.folder_ids[i] for i in self.folder_tree.get_children('') if i in self.folder_ids and self.folder_tree.item(i,'open')}
        def collect(parent):
            for item in self.folder_tree.get_children(parent):
                if self.folder_tree.item(item,'open') and item in self.folder_ids: opened.add(self.folder_ids[item])
                collect(item)
        collect('')
        y=self.folder_tree.yview(); self.folder_tree.delete(*self.folder_tree.get_children()); self.folder_ids={}
        self.folder_tree.insert('','end',iid='filter:all',text='전체'); self.folder_ids['filter:all']=ui.ALL
        self.folder_tree.insert('','end',iid='filter:unfiled',text='미분류'); self.folder_ids['filter:unfiled']=ui.UNFILED
        path_ids={}
        for n,path in enumerate(paths):
            parent=path.rpartition('/')[0]; ident='path:'+str(n); path_ids[path]=ident
            self.folder_tree.insert(path_ids.get(parent,''),'end',iid=ident,text=path.rsplit('/',1)[-1],open=path in opened)
            self.folder_ids[ident]=path
        self.folder_signature=signature
        if self.folder not in (ui.ALL,ui.UNFILED) and self.folder not in paths: self.folder=ui.ALL
        self.folder_tree.selection_set(next(i for i,f in self.folder_ids.items() if f==self.folder))
        if y: self.folder_tree.yview_moveto(y[0])
    def selection_changed(self,event=None):
        ids=self.tree.selection(); self.edit_button.config(state='normal' if len(ids)==1 else 'disabled'); self.delete_button.config(state='normal' if ids else 'disabled')
        self.duplicate_button.config(state='normal' if len(ids)==1 else 'disabled'); self.folder_button.config(state='normal' if ids else 'disabled'); self.details_button.config(state='normal' if len(ids)==1 else 'disabled')
        self.selection_label.config(text=f'선택 {len(ids):,}개')
        selected=next((s for s in self.catalog['sessions'] if len(ids)==1 and s['id']==ids[0]),None)
        self.detail_hint.config(text='' if selected else ('여러 세션이 선택되었습니다.' if len(ids)>1 else '세션을 선택하세요.'))
        for key,var in self.details.items():
            value=selected.get(key,'') if selected else ''
            var.set(str(value).upper() if key=='protocol' else str(value))
    def refresh(self):
        self.refresh_folders()
        for column,title in [('name','이름'),('host','주소'),('protocol','프로토콜'),('port','포트'),('folder','폴더')]:
            self.tree.heading(column,text=title+(' ▼' if self.descending else ' ▲') if column==self.sort else title)
        selected=set(self.tree.selection()); focused=self.tree.focus(); y=self.tree.yview(); x=self.tree.xview()
        protocol={'SSH':'ssh','Telnet':'telnet'}.get(self.protocol_filter.get(),'all') if hasattr(self,'protocol_filter') else 'all'
        result=ui.list_page(self.catalog['sessions'],self.query.get(),self.folder,self.sort,self.descending,self.page,protocol=protocol); self.page=result['page']
        self.tree.delete(*self.tree.get_children())
        for index,s in enumerate(result['rows']):
            self.tree.insert('','end',iid=s['id'],values=(s['name'],s['host'],s['protocol'].upper(),s['port'],s['folder']),tags=('odd',) if index%2 else ())
        retained=[s['id'] for s in result['rows'] if s['id'] in selected]
        if retained: self.tree.selection_set(retained)
        available={s['id'] for s in result['rows']}
        self.tree.focus(focused if focused in available else (retained[0] if retained else ''))
        if y: self.tree.yview_moveto(y[0])
        if x: self.tree.xview_moveto(x[0])
        self.selection_changed()
        self.prev_button.config(state='normal' if self.page>0 else 'disabled'); self.next_button.config(state='normal' if self.page+1<result['pages'] else 'disabled')
        empty=('검색 또는 필터 결과가 없습니다.' if self.query.get().strip() or self.folder is not ui.ALL or protocol!='all' else '세션이 없습니다. 가져오기 또는 추가를 선택하세요.')
        self.status.config(text=(f"{result['first']:,}–{result['last']:,} / {result['total']:,} · {self.page+1}/{result['pages']}쪽" if result['total'] else empty))
        self.state_label.config(text='로컬 저장 실패' if self.local_save_failed else ('게시하지 않은 변경' if self.dirty else ('게시됨' if self.source else '새 문서')))
        self.pathlabel.config(text='게시 대상: '+(self.source or '미지정'))
        if hasattr(self,'undo_button'): self.update_history_buttons()
    def turn(self,n): self.page+=n; self.refresh()
    def clear_history(self):
        self.history=[]; self.history_index=-1; self.history_notice=''
    def update_history_buttons(self):
        undo_state='normal' if self.history_index>0 else 'disabled'
        redo_state='normal' if self.history_index>=0 and self.history_index<len(self.history)-1 else 'disabled'
        self.undo_button.config(state=undo_state); self.redo_button.config(state=redo_state)
        self.history_menu.entryconfig(0,state=undo_state); self.history_menu.entryconfig(1,state=redo_state)
    def record_history(self,before,after):
        self.history_notice=''
        if not self.history: self.history=[before]; self.history_index=0
        self.history=self.history[:self.history_index+1]+[after]
        self.history_index=len(self.history)-1
        while len(self.history)>HISTORY_MAX_STEPS+1: self.history.pop(0); self.history_index-=1
        while len(self.history)>1 and sum(map(len,self.history))>HISTORY_MAX_BYTES:
            self.history.pop(0); self.history_index-=1
        if len(self.history[0])>HISTORY_MAX_BYTES or len(self.history)<2:
            self.clear_history(); self.history_notice='실행 취소 기록이 크기 제한으로 초기화되었습니다.'
    def history_move(self,offset):
        index=self.history_index+offset
        if index<0 or index>=len(self.history): return
        cat=core.validate_catalog(json.loads(self.history[index]))
        try: self.project.save(cat,self.source,self.revision,True)
        except Exception as e: messagebox.showerror('저장 실패',str(e),parent=self.root); return
        self.catalog=cat; self.dirty=True; self.local_save_failed=False; self.history_index=index; self.refresh()
    def undo(self): self.history_move(-1)
    def redo(self): self.history_move(1)
    def commit(self,cat):
        before=core.encode_catalog(self.catalog) if not self.history else None
        after=core.encode_catalog(cat)
        self.project.save(cat,self.source,self.revision,True); self.catalog=cat; self.dirty=True; self.local_save_failed=False
        self.record_history(before,after); self.refresh()
        if self.history_notice: self.status.config(text=self.history_notice)
    def editor(self,old=None,duplicate=False):
        win=tk.Toplevel(self.root); win.title('세션 복제' if duplicate else ('세션 수정' if old else '세션 추가')); win.transient(self.root); win.grab_set(); fields={}
        win.columnconfigure(1,weight=1); first=None
        for i,(key,label) in enumerate([('name','이름'),('host','주소'),('protocol','프로토콜'),('port','포트'),('folder','폴더')]):
            default={'protocol':'ssh','port':22,'folder':self.folder if self.folder is not ui.ALL else ''}
            ttk.Label(win,text=label).grid(row=i,column=0,padx=8,pady=5,sticky='w'); var=tk.StringVar(value=str((old or {}).get(key,default.get(key,'')))); fields[key]=var
            if key=='protocol': w=ttk.Combobox(win,textvariable=var,values=('ssh','telnet'),state='readonly')
            elif key=='folder': w=ttk.Combobox(win,textvariable=var,values=ui.folder_paths(self.catalog['folders'],self.catalog['sessions']),width=40)
            else: w=ttk.Entry(win,textvariable=var,width=40)
            w.grid(row=i,column=1,padx=8,pady=5,sticky='ew')
            if first is None: first=w
        previous=[fields['protocol'].get()]
        def protocol_changed(*args):
            protocol=fields['protocol'].get(); port=fields['port'].get().strip()
            if port in ('', '23' if previous[0]=='telnet' else '22'): fields['port'].set('23' if protocol=='telnet' else '22')
            previous[0]=protocol
        fields['protocol'].trace_add('write',protocol_changed)
        if old and not duplicate: ttk.Label(win,text='ID: '+old['id']).grid(row=5,column=0,columnspan=2,padx=8,sticky='w')
        def save():
            try:
                p=copy.deepcopy(old) if old else {'id':str(uuid.uuid4())}
                if duplicate: p['id']=str(uuid.uuid4())
                p.update({k:v.get() for k,v in fields.items()}); p=core.profile(p)
                sessions=[p if s['id']==p['id'] else s for s in self.catalog['sessions']] if old and not duplicate else self.catalog['sessions']+[p]
                self.commit(core.validate_catalog({'version':1,'sessions':sessions,'folders':self.catalog['folders']})); win.destroy()
            except Exception as e: messagebox.showerror('저장 실패',str(e),parent=win)
        buttons=ttk.Frame(win); buttons.grid(row=6,column=1,padx=8,pady=8,sticky='e')
        ttk.Button(buttons,text='취소',command=win.destroy).pack(side='left',padx=4); ttk.Button(buttons,text='저장',style='Accent.TButton',command=save).pack(side='left')
        win.bind('<Escape>',lambda e:win.destroy()); first.focus_set(); win.wait_window()
    def add(self): self.editor()
    def edit(self):
        ids=self.tree.selection()
        if len(ids)==1: self.editor(next(s for s in self.catalog['sessions'] if s['id']==ids[0]))
    def duplicate(self):
        ids=self.tree.selection()
        if len(ids)==1: self.editor(copy.deepcopy(next(s for s in self.catalog['sessions'] if s['id']==ids[0])),duplicate=True)
    def change_folder(self):
        ids=set(self.tree.selection())
        if not ids: return
        win=tk.Toplevel(self.root); win.title('폴더 변경'); win.transient(self.root); win.grab_set()
        ttk.Label(win,text=f'선택 {len(ids):,}개 · 비워 두면 미분류').pack(anchor='w',padx=10,pady=8)
        value=tk.StringVar(); box=ttk.Combobox(win,textvariable=value,values=ui.folder_paths(self.catalog['folders'],self.catalog['sessions'])); box.pack(fill='x',padx=10)
        def save():
            try:
                sessions=[dict(s,folder=value.get()) if s['id'] in ids else s for s in self.catalog['sessions']]
                self.commit(core.validate_catalog({'version':1,'sessions':sessions,'folders':self.catalog['folders']})); win.destroy()
            except Exception as e: messagebox.showerror('폴더 변경 실패',str(e),parent=win)
        buttons=ttk.Frame(win); buttons.pack(anchor='e',padx=10,pady=8)
        ttk.Button(buttons,text='취소',command=win.destroy).pack(side='left',padx=4); ttk.Button(buttons,text='변경',command=save).pack(side='left')
        win.bind('<Escape>',lambda e:win.destroy()); box.focus_set(); win.wait_window()
    def show_details(self):
        ids=self.tree.selection()
        if len(ids)!=1: return
        selected=next(s for s in self.catalog['sessions'] if s['id']==ids[0])
        win=tk.Toplevel(self.root); win.title('세션 상세'); win.transient(self.root)
        for i,(key,label) in enumerate([('name','이름'),('host','주소'),('protocol','프로토콜'),('port','포트'),('folder','폴더'),('id','ID')]):
            ttk.Label(win,text=label).grid(row=i,column=0,padx=8,pady=4,sticky='w')
            entry=ttk.Entry(win,width=45); entry.insert(0,str(selected.get(key,''))); entry.config(state='readonly'); entry.grid(row=i,column=1,padx=8,pady=4,sticky='ew')
        win.columnconfigure(1,weight=1)
    def delete(self):
        ids=set(self.tree.selection())
        if ids and messagebox.askyesno('삭제',f'{len(ids)}개 세션을 삭제하시겠습니까?',parent=self.root):
            try: self.commit(core.validate_catalog({'version':1,'sessions':[s for s in self.catalog['sessions'] if s['id'] not in ids],'folders':self.catalog['folders']}))
            except Exception as e: messagebox.showerror('삭제 실패',str(e),parent=self.root)
    def options(self):
        win=tk.Toplevel(self.root); win.title('가져오기 설정'); win.transient(self.root); win.grab_set(); result=[]
        options=ImportOptions(win); options.pack(fill='x',padx=10,pady=10)
        def ok():
            try:
                result.append(options.values()); win.destroy()
            except ValueError as e: messagebox.showerror('설정 오류',str(e),parent=win)
        buttons=ttk.Frame(win); buttons.pack(anchor='e',padx=10,pady=(0,10))
        ttk.Button(buttons,text='취소',command=win.destroy).pack(side='left',padx=4); ttk.Button(buttons,text='확인',style='Accent.TButton',command=ok).pack(side='left')
        win.bind('<Escape>',lambda e:win.destroy()); win.focus_set(); win.wait_window(); return result[0] if result else None
    def excel(self):
        path=filedialog.askopenfilename(filetypes=[('엑셀','*.xlsx')],parent=self.root)
        if not path: return
        opt=self.options()
        if not opt: return
        try:
            wb=core.inspect_xlsx(path); names=wb.sheetnames; wb.close()
            win=tk.Toplevel(self.root); win.title('시트 선택'); win.transient(self.root); win.grab_set(); var=tk.StringVar(value=names[0] if names else ''); box=ttk.Combobox(win,textvariable=var,values=names,state='readonly'); box.pack(padx=10,pady=10); chosen=[]
            def ok(): chosen.append(var.get()); win.destroy()
            buttons=ttk.Frame(win); buttons.pack(pady=8); ttk.Button(buttons,text='취소',command=win.destroy).pack(side='left',padx=4); ttk.Button(buttons,text='확인',style='Accent.TButton',command=ok).pack(side='left')
            win.bind('<Escape>',lambda e:win.destroy()); box.focus_set(); win.wait_window()
            if chosen: self.preview(core.read_xlsx(path,chosen[0],*opt))
        except Exception as e: messagebox.showerror('엑셀 오류',str(e),parent=self.root)
    def paste(self):
        if self.pending: messagebox.showerror('가져오기','진행 중인 가져오기가 있습니다.',parent=self.root); return
        win=tk.Toplevel(self.root); win.title('붙여넣기'); win.transient(self.root); win.grab_set()
        win.columnconfigure(0,weight=1); win.rowconfigure(0,weight=1)
        canvas=tk.Canvas(win,highlightthickness=0); canvas.grid(row=0,column=0,sticky='nsew')
        scroll=ttk.Scrollbar(win,orient='vertical',command=canvas.yview); scroll.grid(row=0,column=1,sticky='ns'); canvas.configure(yscrollcommand=scroll.set)
        content=ttk.Frame(canvas); content.columnconfigure(0,weight=1); content.rowconfigure(2,weight=1)
        content_id=canvas.create_window(0,0,window=content,anchor='nw')
        def resize_content(e):
            canvas.itemconfigure(content_id,width=e.width)
            schedule_layout()
        canvas.bind('<Configure>',resize_content)
        options=ImportOptions(content); options.grid(row=0,column=0,sticky='ew',padx=10,pady=(10,6))
        ttk.Label(content,text='탭으로 구분된 텍스트 입력').grid(row=1,column=0,sticky='w',padx=10)
        frame=ttk.Frame(content); frame.grid(row=2,column=0,sticky='nsew',padx=10,pady=5); frame.columnconfigure(0,weight=1); frame.rowconfigure(0,weight=1)
        editor=tk.Text(frame,wrap='none',undo=True,height=10); editor.grid(row=0,column=0,sticky='nsew')
        sy=ttk.Scrollbar(frame,orient='vertical',command=editor.yview); sy.grid(row=0,column=1,sticky='ns')
        sx=ttk.Scrollbar(frame,orient='horizontal',command=editor.xview); sx.grid(row=1,column=0,sticky='ew'); editor.configure(yscrollcommand=sy.set,xscrollcommand=sx.set)
        status=tk.StringVar(value='0행'); error=tk.StringVar()
        def changed(event=None):
            if event is not None and not editor.edit_modified(): return
            data=editor.get('1.0','end-1c'); status.set(f'{len(data.splitlines()):,}행'); apply_button.config(state='normal' if data.strip() else 'disabled'); error.set(''); editor.edit_modified(False)
        editor.bind('<<Modified>>',changed)
        def options_changed(*args):
            error.set('')
        for variable in (options.count,options.header,options.has_id): variable.trace_add('write',options_changed)
        def clipboard():
            try:
                data=win.clipboard_get()
                if not isinstance(data,str) or not data: raise ValueError('클립보드에 텍스트가 없습니다.')
                existing=editor.get('1.0','end-1c')
                selected=editor.tag_ranges('sel')
                removed=editor.get(selected[0],selected[1]) if selected else ''
                if len(existing.encode('utf-8'))-len(removed.encode('utf-8'))+len(data.encode('utf-8'))>core.MAX_BYTES: raise ValueError('붙여넣기 크기가 20 MiB를 초과합니다.')
                editor.edit_separator()
                editor.config(autoseparators=False)
                try:
                    if selected: editor.mark_set('insert',selected[0]); editor.delete(selected[0],selected[1])
                    editor.insert('insert',data)
                finally: editor.config(autoseparators=True)
                editor.edit_separator(); error.set('')
            except tk.TclError: error.set('클립보드에서 텍스트를 읽을 수 없습니다. 텍스트를 복사한 뒤 다시 시도하세요.')
            except ValueError as e: error.set(str(e))
        actions=ttk.Frame(content); actions.grid(row=3,column=0,sticky='ew',padx=10)
        ttk.Button(actions,text='클립보드 붙여넣기',command=clipboard).pack(side='left'); ttk.Button(actions,text='비우기',command=lambda:editor.delete('1.0','end')).pack(side='left',padx=5)
        ttk.Label(actions,textvariable=status).pack(side='right')
        error_label=ttk.Label(content,textvariable=error,foreground='#a12622',wraplength=700); error_label.grid(row=4,column=0,sticky='ew',padx=10,pady=(5,0))
        pending_layout=[None]
        def update_layout():
            needed=max(canvas.winfo_height(),content.winfo_reqheight())
            if int(float(canvas.itemcget(content_id,'height'))) != needed: canvas.itemconfigure(content_id,height=needed)
            canvas.configure(scrollregion=canvas.bbox('all'))
            pending_layout[0]=None
        def layout_after_geometry():
            pending_layout[0]=canvas.after_idle(update_layout)
        def schedule_layout(*args):
            if pending_layout[0] is None: pending_layout[0]=canvas.after_idle(layout_after_geometry)
        def cancel_layout(event):
            if event.widget is canvas and pending_layout[0] is not None:
                canvas.after_cancel(pending_layout[0]); pending_layout[0]=None
        canvas.bind('<Destroy>',cancel_layout)
        def content_changed(e):
            wrap=max(160,e.width-20)
            if int(error_label.cget('wraplength')) != wrap: error_label.configure(wraplength=wrap)
            schedule_layout()
        content.bind('<Configure>',content_changed)
        for variable in (error,options.count,options.header,options.has_id): variable.trace_add('write',schedule_layout)
        schedule_layout()
        def replace():
            try:
                data=editor.get('1.0','end-1c')
                if not data.strip(): raise ValueError('적용할 텍스트가 없습니다.')
                rows=core.read_tsv(data,*options.values(),include_row_numbers=True)
                result=core.replace_catalog(self.catalog,rows)
                self.commit(result)
                if self.folder is not ui.ALL and self.folder is not ui.UNFILED and self.folder not in result['folders']:
                    self.folder=ui.ALL; self.page=0; self.refresh()
                if not self.history_notice: self.status.config(text=f'붙여넣기 적용 완료: 총 {len(result["sessions"]):,}개')
                win.destroy()
            except Exception as e: error.set(str(e))
        buttons=ttk.Frame(win); buttons.grid(row=1,column=0,columnspan=2,sticky='ew',padx=10,pady=10)
        ttk.Label(buttons,text='기존 세션과 빈 폴더가 삭제됩니다.').pack(anchor='w')
        input_row=ttk.Frame(buttons); input_row.pack(fill='x',pady=(4,0))
        ttk.Button(input_row,text='취소',command=win.destroy).pack(side='right')
        apply_button=ttk.Button(input_row,text='목록 덮어쓰기',style='Accent.TButton',command=replace,state='disabled'); apply_button.pack(side='right',padx=5)
        win.update_idletasks()
        width=min(820,win.winfo_screenwidth()); height=min(max(540,content.winfo_reqheight()+buttons.winfo_reqheight()+30),win.winfo_screenheight())
        win.minsize(min(540,win.winfo_screenwidth()),min(360,win.winfo_screenheight())); win.geometry(f'{width}x{height}')
        win.paste_content=content; win.paste_footer=buttons; win.paste_canvas=canvas; win.paste_editor=editor; win.paste_options=options
        win.bind('<Escape>',lambda e:win.destroy()); editor.focus_set(); win.wait_window()
    def open_tsv(self):
        path=filedialog.askopenfilename(filetypes=[('CSV / TSV','*.csv *.tsv'),('텍스트','*.txt')],parent=self.root)
        if not path: return
        opt=self.options()
        if not opt: return
        try:
            data=core.read_bytes(path).decode('utf-8-sig'); reader=core.read_csv if Path(path).suffix.lower()=='.csv' else core.read_tsv; self.preview(reader(data,*opt))
        except Exception as e: messagebox.showerror('표 가져오기 오류',str(e),parent=self.root)
    def export_tsv(self):
        path=filedialog.asksaveasfilename(defaultextension='.tsv',filetypes=[('TSV','*.tsv')],parent=self.root)
        if not path: return
        try:
            core.export_tsv(path,self.catalog,[self.source,self.project.path])
        except Exception as e: messagebox.showerror('내보내기 실패',str(e),parent=self.root)
    def preview(self,rows,parent=None):
        if self.pending: messagebox.showerror('가져오기','진행 중인 가져오기가 있습니다.',parent=self.root); return
        plan=core.plan_merge(self.catalog,rows); self.pending=plan; choices={}; applied=[]; win=tk.Toplevel(parent or self.root); win.title('가져오기 미리보기'); win.geometry('940x560'); win.transient(parent or self.root); win.grab_set()
        win.rowconfigure(1,weight=2); win.rowconfigure(2,weight=1); win.columnconfigure(0,weight=1)
        summary=ttk.Label(win,padding=(8,8,8,0),wraplength=700,justify='left'); summary.grid(row=0,column=0,sticky='ew')
        win.bind('<Configure>',lambda e:summary.configure(wraplength=max(200,e.width-24)) if e.widget is win else None)
        frame=ttk.Frame(win); frame.grid(row=1,column=0,sticky='nsew',padx=8,pady=8); frame.rowconfigure(0,weight=1); frame.columnconfigure(0,weight=1)
        tree=ttk.Treeview(frame,columns=('row','status','name','host','protocol','port','folder','choice'),show='headings')
        for c,t,w in [('row','행',55),('status','결과',90),('name','이름',150),('host','주소',150),('protocol','프로토콜',85),('port','포트',65),('folder','폴더',150),('choice','선택',160)]: tree.heading(c,text=t); tree.column(c,width=w)
        tree.grid(row=0,column=0,sticky='nsew'); scroll=ttk.Scrollbar(frame,orient='vertical',command=tree.yview); scroll.grid(row=0,column=1,sticky='ns')
        scrollx=ttk.Scrollbar(frame,orient='horizontal',command=tree.xview); scrollx.grid(row=1,column=0,sticky='ew'); tree.configure(yscrollcommand=scroll.set,xscrollcommand=scrollx.set)
        tree.tag_configure('review',background='#fff0d5'); tree.tag_configure('changed',background='#e4f4f1'); items={i['row']:i for i in plan['items']}; lookup={s['id']:s for s in self.catalog['sessions']}
        def choice_label(value):
            if value is None: return ''
            choice=core.import_choice(value)
            return {'skip':'건너뛰기','new':'신규 추가'}.get(choice['action']) or '기존 세션: '+choice['id']
        def display():
            tree.delete(*tree.get_children())
            for i in plan['items']:
                p=i['profile']; status=ui.import_result(i,choices,lookup)['status']; tree.insert('','end',iid=str(i['row']),values=(i['row'],{'변경':'갱신','동일':'유지','확인필요':'확인 필요','건너뜀':'건너뛰기'}.get(status,status),p['name'],p['host'],p['protocol'].upper(),p['port'],p['folder'],choice_label(choices.get(i['row']))),tags=('review',) if status=='확인필요' else (('changed',) if status=='변경' else ()))
        def update_summary():
            counts,_=ui.import_summary(plan,choices,self.catalog); unresolved,error=ui.import_validation(self.catalog,plan,choices)
            duplicate=f" · 중복 제외 {plan['duplicates']}" if plan['duplicates'] else ''
            summary.config(text=f"추가 {counts['추가']} · 갱신 {counts['변경']} · 유지 {counts['동일']} · 건너뛰기 {counts['건너뜀']} · 확인 필요 {unresolved}{duplicate}"+(f' · {error}' if error else ''))
            apply_button.config(state='disabled' if unresolved or error else 'normal')
        display()
        comparison_frame=ttk.Frame(win); comparison_frame.grid(row=2,column=0,sticky='nsew',padx=8); comparison_frame.rowconfigure(0,weight=1); comparison_frame.columnconfigure(0,weight=1)
        comparison=ttk.Treeview(comparison_frame,columns=('field','before','after'),show='headings',height=5,selectmode='none')
        for col,label,width,minimum,stretch in [('field','항목',110,100,False),('before','현재 AS-IS',350,220,True),('after','적용 후 TO-BE',350,220,True)]: comparison.heading(col,text=label); comparison.column(col,width=width,minwidth=minimum,stretch=stretch)
        comparison.grid(row=0,column=0,sticky='nsew'); comparison_scroll=ttk.Scrollbar(comparison_frame,orient='vertical',command=comparison.yview); comparison_scroll.grid(row=0,column=1,sticky='ns'); comparison.configure(yscrollcommand=comparison_scroll.set)
        comparison_scrollx=ttk.Scrollbar(comparison_frame,orient='horizontal',command=comparison.xview); comparison_scrollx.grid(row=1,column=0,sticky='ew'); comparison.configure(xscrollcommand=comparison_scrollx.set)
        comparison_font=tkfont.Font(root=win,font=ttk.Style(win).lookup('Treeview','font') or 'TkDefaultFont')
        comparison.tag_configure('changed',background='#e4f4f1'); win.comparison_tree=comparison
        def selected_comparison(event=None):
            comparison.delete(*comparison.get_children())
            selected=tree.selection()
            if not selected: return
            item=items[int(selected[0])]; result=ui.import_result(item,choices,lookup); before=result['before']; after=result['after']; status=result['status']
            widths={'before':350,'after':350}
            for key,label in [('name','이름'),('host','주소'),('protocol','프로토콜'),('port','포트'),('folder','폴더')]:
                if status=='확인필요': old=new='선택 필요'
                elif status=='건너뜀': old=new='적용 안 함'
                else: old=str(before[key]) if before is not None else '없음'; new=str(after[key])
                changed=status not in ('확인필요','건너뜀') and (before is None or before[key]!=after[key])
                comparison.insert('','end',iid=key,values=(('● ' if changed else '')+label,old,new),tags=('changed',) if changed else ())
                widths['before']=max(widths['before'],comparison_font.measure(old)+24); widths['after']=max(widths['after'],comparison_font.measure(new)+24)
            for col,width in widths.items(): comparison.column(col,width=width)
            comparison.xview_moveto(0)
        tree.bind('<<TreeviewSelect>>',selected_comparison)
        def choose():
            selected=tree.selection()
            if not selected: return
            item=items[int(selected[0])]
            if item['status']!='확인필요': return
            previous=core.import_choice(choices.get(item['row'],{'action':'skip'})); initial=previous['action']
            dialog=tk.Toplevel(win); dialog.title('행 처리'); dialog.geometry('720x420'); dialog.transient(win); dialog.grab_set(); var=tk.StringVar(value=initial); ttk.Radiobutton(dialog,text='건너뛰기',variable=var,value='skip').pack(anchor='w',padx=8,pady=(8,0)); ttk.Radiobutton(dialog,text='신규 추가',variable=var,value='new').pack(anchor='w',padx=8); ttk.Radiobutton(dialog,text='선택한 기존 세션',variable=var,value='existing').pack(anchor='w',padx=8)
            buttons=ttk.Frame(dialog); buttons.pack(side='bottom',pady=8); ttk.Button(buttons,text='취소',command=dialog.destroy).pack(side='left',padx=4)
            frame=ttk.Frame(dialog); frame.pack(fill='both',expand=True,padx=8,pady=8); frame.rowconfigure(0,weight=1); frame.columnconfigure(0,weight=1); candidates=ttk.Treeview(frame,columns=('name','host','protocol','port','folder','id'),show='headings',selectmode='browse')
            for col,label in [('name','이름'),('host','주소'),('protocol','프로토콜'),('port','포트'),('folder','폴더'),('id','ID')]: candidates.heading(col,text=label); candidates.column(col,width=130)
            candidates.grid(row=0,column=0,sticky='nsew'); scroll=ttk.Scrollbar(frame,orient='vertical',command=candidates.yview); scroll.grid(row=0,column=1,sticky='ns'); scrollx=ttk.Scrollbar(frame,orient='horizontal',command=candidates.xview); scrollx.grid(row=1,column=0,sticky='ew'); candidates.configure(yscrollcommand=scroll.set,xscrollcommand=scrollx.set); candidates.bind('<<TreeviewSelect>>',lambda e:var.set('existing'))
            lookup={s['id']:s for s in self.catalog['sessions']}
            for ident in item['candidates']:
                s=lookup[ident]; candidates.insert('','end',iid=ident,values=(s['name'],s['host'],s['protocol'].upper(),s['port'],s['folder'],ident))
            if initial=='existing' and previous['id'] in item['candidates']: candidates.selection_set(previous['id']); candidates.focus(previous['id']); candidates.see(previous['id'])
            def done():
                action=var.get(); choice={'action':action}
                if action=='existing':
                    if not candidates.selection(): messagebox.showerror('선택 필요','기존 세션을 선택하세요.',parent=dialog); return
                    choice['id']=candidates.selection()[0]
                choices[item['row']]=choice; dialog.destroy(); status=ui.import_result(item,choices,lookup)['status']; tree.set(str(item['row']),'choice',choice_label(choice)); tree.set(str(item['row']),'status',{'변경':'갱신','동일':'유지','확인필요':'확인 필요','건너뜀':'건너뛰기'}.get(status,status)); tree.item(str(item['row']),tags=('review',) if status=='확인필요' else (('changed',) if status=='변경' else ())); update_summary(); selected_comparison()
            ttk.Button(buttons,text='확인',style='Accent.TButton',command=done).pack(side='left')
            def cancel_candidate(event=None):
                dialog.destroy(); return 'break'
            dialog.bind('<Escape>',cancel_candidate); candidates.focus_set()
            try: dialog.wait_window()
            finally:
                if win.winfo_exists(): win.grab_set()
        def apply():
            try: self.commit(core.apply_plan(self.catalog,plan,choices)); self.pending=None; applied.append(True); win.destroy()
            except Exception as e: messagebox.showerror('적용 실패',str(e),parent=win)
        def cancel(): self.pending=None; win.destroy()
        bar=ttk.Frame(win); bar.grid(row=3,column=0,sticky='ew',padx=8,pady=8); ttk.Button(bar,text='선택 행 처리',command=choose).pack(side='left'); ttk.Button(bar,text='취소',command=cancel).pack(side='right'); apply_button=ttk.Button(bar,text='적용',style='Accent.TButton',command=apply); apply_button.pack(side='right',padx=4)
        def escape_preview(event):
            if event.widget.winfo_toplevel() is win: cancel()
            return 'break'
        update_summary(); tree.bind('<Double-1>',lambda e:choose()); tree.bind('<Return>',lambda e:choose()); win.bind('<Escape>',escape_preview); win.protocol('WM_DELETE_WINDOW',cancel); tree.focus_set()
        try: win.wait_window()
        finally: self.pending=None
        return bool(applied)
    def close(self):
        previous_failure=self.local_save_failed
        error=close_after_guard(self,lambda:self.guard(skip_local_failure=True))
        if error:
            self.local_save_failed=previous_failure
            if messagebox.askyesno('로컬 저장 실패',f'로컬 작업을 저장하지 못했습니다: {error}\n\n현재 창의 변경 사항을 버리고 닫으시겠습니까?',parent=self.root):
                if self.timer: self.root.after_cancel(self.timer); self.timer=None
                self.project.close(); self.root.destroy()

def run_gui():
    root=tk.Tk(); App(root); root.mainloop(); return 0

if __name__=='__main__': sys.exit(cli())
