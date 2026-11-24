import copy
import os
from pathlib import Path
import sys
import tempfile
import time
import tkinter as tk
from tkinter import ttk
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core
import main
import ui


def session(i, **values):
    return dict({'id':str(i), 'name':f'R{i}', 'host':f'192.0.2.{int(i)%255}', 'protocol':'ssh', 'port':22, 'folder':'base', 'tags':['keep'], 'notes':'keep'}, **values)


def walk(widget):
    for child in widget.winfo_children():
        yield child
        yield from walk(child)


def button(window, label):
    return next(w for w in walk(window) if isinstance(w, ttk.Button) and w.cget('text') == label)


class RefreshTests(unittest.TestCase):
    def test_natural_unicode_filter_and_addresses(self):
        rows=[session(1,name='R10',host='192.0.2.10'), session(2,name='R2',host='192.0.2.2',protocol='telnet',port=23), session(3,name='R²',host='example.test'),session(4,name='R1',host='2001:db8::1')]
        self.assertEqual([s['name'] for s in ui.list_page(rows)['rows']],['R1','R2','R10','R²'])
        self.assertEqual([s['id'] for s in ui.list_page(rows,folder='base',query='r2',protocol='telnet')['rows']],['2'])
        self.assertEqual([s['id'] for s in ui.list_page(rows,sort='host')['rows']],['2','1','4','3'])
        self.assertEqual(ui.natural('²'),((0,'²'),))

    def test_empty_protocol_filter_and_multiple_selection_hint(self):
        app,root=self.make_app()
        cat=core.validate_catalog({'version':1,'sessions':[session(1),session(2)]})
        app.commit(cat)
        app.protocol_filter.set('Telnet'); app.filter_changed()
        self.assertEqual(app.status.cget('text'),'검색 또는 필터 결과가 없습니다.')
        app.protocol_filter.set('전체'); app.filter_changed()
        app.tree.selection_set(('1','2')); app.selection_changed()
        self.assertEqual(app.detail_hint.cget('text'),'여러 세션이 선택되었습니다.')

    def test_preview_validation_conflicting_target(self):
        base=core.validate_catalog({'version':1,'sessions':[session(1),session(2)]})
        plan=core.plan_merge(base,[dict(session(1),name='changed'),dict(session(1),name='other')])
        self.assertEqual(ui.import_validation(base,plan,{})[0],1)
        unresolved,error=ui.import_validation(base,plan,{2:'1'})
        self.assertEqual(unresolved,0); self.assertIn('같은 기존 세션',error)
        self.assertEqual(ui.import_validation(base,plan,{2:'skip'}),(0,''))

    def make_app(self):
        temporary=tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        env=patch.dict(os.environ,{'LOCALAPPDATA':temporary.name}); env.start(); self.addCleanup(env.stop)
        root=tk.Tk(); root.withdraw()
        def close_root(): root.update_idletasks(); root.destroy()
        self.addCleanup(close_root)
        app=main.App(root); self.addCleanup(app.project.close)
        return app,root

    def test_history_cas_bounds_and_reset(self):
        app,root=self.make_app(); base=core.validate_catalog({'version':1,'sessions':[session(1)]}); app.commit(base)
        for i in range(22):
            cat=copy.deepcopy(app.catalog); cat['sessions'][0]['name']=f'edit{i}'; app.commit(cat)
        self.assertEqual(len(app.history),21); self.assertTrue(all(isinstance(x,bytes) for x in app.history))
        before=copy.deepcopy(app.catalog); history=app.history[:]; index=app.history_index
        with patch.object(app.project,'save',side_effect=core.ConflictError('conflict')),patch.object(main.messagebox,'showerror') as shown:
            app.undo(); self.assertTrue(shown.called)
        self.assertEqual((app.catalog,app.history,app.history_index),(before,history,index))
        app.undo(); self.assertNotEqual(app.catalog,before); app.redo(); self.assertEqual(app.catalog,before)
        with patch.object(main,'HISTORY_MAX_BYTES',1):
            cat=copy.deepcopy(app.catalog); cat['sessions'][0]['name']='oversized'; app.commit(cat)
        self.assertEqual(app.history,[]); self.assertIn('크기 제한',app.history_notice)
        app.commit(base)
        self.assertEqual(app.history_notice,'')
        with patch.object(app,'guard',return_value=True): app.new()
        self.assertEqual(app.history,[])

    def test_open_and_publish_history_reset_and_failure(self):
        app,root=self.make_app(); cat=core.validate_catalog({'version':1,'sessions':[session(1)]}); app.commit(cat)
        with patch.object(main.filedialog,'asksaveasfilename',return_value='target.json'), patch.object(main.core,'publish',side_effect=core.ConflictError('no')),patch.object(main.messagebox,'showerror'):
            saved=app.history[:]; app.publish(); self.assertEqual(app.history,saved)
        with patch.object(main.filedialog,'asksaveasfilename',return_value='target.json'),patch.object(main.core,'publish',return_value='revision'),patch.object(main.messagebox,'showinfo') as shown:
            app.publish(); self.assertEqual(app.history,[])
            shown.assert_called_once_with('저장 완료','저장되었습니다.\ntarget.json',parent=root)
        app.commit(cat)
        with patch.object(app,'guard',return_value=True),patch.object(main.filedialog,'askopenfilename',return_value='target.json'),patch.object(main.core,'load_catalog',return_value=(cat,'revision')):
            app.open(); self.assertEqual(app.history,[])

    def test_editor_defaults_custom_port_and_duplicate_cancel(self):
        app,root=self.make_app(); cat=core.validate_catalog({'version':1,'sessions':[session(1)],'folders':['base','empty']}); app.commit(cat); app.folder='base'
        original=tk.Toplevel
        def hidden(*a,**kw):
            win=original(*a,**kw); win.withdraw(); return win
        def exercise(win,*args):
            combos=[w for w in walk(win) if isinstance(w,ttk.Combobox)]
            protocol=next(w for w in combos if 'telnet' in w.cget('values'))
            folders=next(w for w in combos if 'base' in w.cget('values'))
            self.assertEqual(folders.get(),'base')
            entries=[w for w in walk(win) if isinstance(w,ttk.Entry) and not isinstance(w,ttk.Combobox)]
            port=next(w for w in entries if w.get()=='22')
            protocol.set('telnet'); self.assertEqual(port.get(),'23')
            port.delete(0,'end'); port.insert(0,'2222'); protocol.set('ssh'); self.assertEqual(port.get(),'2222')
            win.destroy()
        before=copy.deepcopy(app.catalog)
        with patch.object(main.tk,'Toplevel',hidden),patch.object(original,'wait_window',exercise): app.add()
        self.assertEqual(app.catalog,before)
        app.tree.selection_set('1')
        def cancel(win,*args): button(win,'취소').invoke()
        with patch.object(main.tk,'Toplevel',hidden),patch.object(original,'wait_window',cancel): app.duplicate()
        self.assertEqual(app.catalog,before)

    def test_paste_replacement_one_undo_and_byte_limit(self):
        app,root=self.make_app(); original=tk.Toplevel
        def hidden(*a,**kw):
            win=original(*a,**kw); win.withdraw(); win.clipboard_get=Mock(return_value='X'); return win
        def exercise(win,*args):
            editor=next(w for w in walk(win) if isinstance(w,tk.Text))
            editor.insert('1.0','ABCDE'); editor.edit_separator(); editor.tag_add('sel','1.1','1.3'); editor.mark_set('insert','1.3')
            with patch.object(core,'MAX_BYTES',4): button(win,'클립보드 붙여넣기').invoke()
            self.assertEqual(editor.get('1.0','end-1c'),'AXDE')
            editor.edit_undo(); self.assertEqual(editor.get('1.0','end-1c'),'ABCDE')
            editor.tag_add('sel','1.1','1.3'); win.clipboard_get.return_value='한글'
            with patch.object(core,'MAX_BYTES',4): button(win,'클립보드 붙여넣기').invoke()
            self.assertEqual(editor.get('1.0','end-1c'),'ABCDE'); win.destroy()
        with patch.object(main.tk,'Toplevel',hidden),patch.object(original,'wait_window',exercise): app.paste()

    def test_large_history_serializes_only_new_snapshots(self):
        app,root=self.make_app()
        cat=core.validate_catalog({'version':1,'sessions':[session(i) for i in range(5000)]})
        app.catalog=cat; app.refresh=Mock(); app.project.save=Mock()
        started=time.perf_counter()
        with patch.object(main.core,'encode_catalog',wraps=core.encode_catalog) as encode:
            for i in range(20):
                next_cat=copy.deepcopy(app.catalog); next_cat['sessions'][0]['name']=f'edit{i}'; app.commit(next_cat)
            self.assertEqual(encode.call_count,21)
        elapsed=time.perf_counter()-started
        self.assertLessEqual(len(app.history),21); self.assertLessEqual(sum(map(len,app.history)),main.HISTORY_MAX_BYTES)
        print(f'5000 sessions, 20 history commits (mock save/refresh): {elapsed:.3f}s')

    def test_action_rows_fit_minimum_width_at_scales(self):
        app,root=self.make_app()
        for scale in (1.333333,1.666667,2.0):
            root.tk.call('tk','scaling',scale); root.update_idletasks()
            self.assertLessEqual(app.edit_button.master.winfo_reqwidth(),567)
            self.assertLessEqual(app.folder_button.master.winfo_reqwidth(),567)


if __name__=='__main__': unittest.main()
