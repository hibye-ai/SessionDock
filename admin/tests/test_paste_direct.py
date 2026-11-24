import copy
import os
from pathlib import Path
import sys
import tempfile
import tkinter as tk
from tkinter import ttk
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core
import main
import ui


def row(ident, name, host, folder='old', **extra):
    return dict({'id':ident, 'name':name, 'host':host, 'folder':folder, 'protocol':'ssh', 'port':22}, **extra)


def walk(widget):
    for child in widget.winfo_children():
        yield child
        yield from walk(child)


class ReplacementTests(unittest.TestCase):
    def setUp(self):
        self.base=core.validate_catalog({'version':1,'sessions':[row('skip','A','a.test',notes='safe',tags=['keep']),row('new','B','b.test',fontSize=14)],'folders':['empty']})

    def test_fresh_rows_discard_old_settings_and_keep_all_duplicates(self):
        before=copy.deepcopy(self.base)
        data=[dict(name='A',host='a.test',folder='old'),dict(name='A',host='a.test',folder='old'),dict(id='skip',name='A',host='a.test',folder='old')]
        out=core.replace_catalog(self.base,data)
        self.assertEqual(len(out['sessions']),3)
        self.assertEqual(len({s['id'] for s in out['sessions']}),3)
        self.assertEqual(out['sessions'][2]['id'],'skip')
        for item in out['sessions']:
            self.assertNotIn('notes',item); self.assertNotIn('tags',item); self.assertNotIn('fontSize',item)
        self.assertEqual(out['folders'],['old']); self.assertEqual(self.base,before)

    def test_4908_ambiguous_and_5000_rows_preserved(self):
        base=core.validate_catalog({'version':1,'sessions':[row('a','same','same.test'),row('b','other','same.test'),row('c','same','other.test')]})
        data=[dict(name='same',host='same.test',folder='old') for _ in range(5000)]
        result=core.replace_catalog(base,data)
        self.assertEqual(len(result['sessions']),5000)
        self.assertEqual(len({s['id'] for s in result['sessions']}),5000)
        self.assertEqual(result['sessions'][4907]['name'],'same')

    def test_validation_and_id_collision(self):
        before=copy.deepcopy(self.base)
        for rows in ([],[{}],[row('x','x','bad host')],[row('x','x','x.test')]*10001):
            with self.assertRaises(core.ValidationError): core.replace_catalog(self.base,rows)
        for rows in ([row('skip','A','a.test')]*2,[row('brandnew','X','x.test')]*2):
            with self.assertRaisesRegex(core.ValidationError,'2행.*중복'): core.replace_catalog(self.base,rows)
        with self.assertRaisesRegex(core.ValidationError,'1행.*ID'): core.replace_catalog(self.base,[row('bad id','A','a.test')])
        with patch.object(core.uuid,'uuid4',side_effect=['explicit','fresh','fresh','fresh-2']):
            out=core.replace_catalog(self.base,[dict(name='X',host='x.test'),dict(name='Y',host='y.test'),row('explicit','Z','z.test')])
        self.assertEqual([s['id'] for s in out['sessions']],['fresh','fresh-2','explicit']); self.assertEqual(self.base,before)
        with self.assertRaises(core.ValidationError): core.replace_catalog(self.base,[dict(name='A',host='a.test')]*5001)

    def make_app(self):
        temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        env=patch.dict(os.environ,{'LOCALAPPDATA':temp.name}); env.start(); self.addCleanup(env.stop)
        root=tk.Tk(); root.withdraw(); self.addCleanup(root.destroy)
        app=main.App(root); self.addCleanup(app.project.close); app.commit(self.base)
        return app,root

    def test_compare_commit_undo_redo_and_cas_failure(self):
        app,root=self.make_app(); original=tk.Toplevel; app.preview=Mock()
        app.folder='empty'; app.page=2; app.source='source.json'; app.revision='revision'
        def hidden(*args,**kwargs):
            win=original(*args,**kwargs); win.withdraw(); return win
        def exercise(win,*args):
            widgets=list(walk(win)); editor=next(w for w in widgets if isinstance(w,tk.Text))
            buttons={w.cget('text'):w for w in widgets if isinstance(w,ttk.Button)}
            buttons['폴더 없음'].invoke()
            next(w for w in widgets if isinstance(w,ttk.Checkbutton) and w.cget('text')=='첫 행은 제목').invoke()
            editor.insert('1.0','C\tc.test\tssh\t22'); root.update()
            rival=core.Project(app.project.path); self.addCleanup(rival.close); rival.save(self.base,'other','changed',False)
            before=(copy.deepcopy(app.catalog),app.history[:],app.history_index,app.folder,app.source,app.revision,app.dirty)
            buttons['목록 덮어쓰기'].invoke()
            self.assertTrue(win.winfo_exists()); self.assertEqual(editor.get('1.0','end-1c'),'C\tc.test\tssh\t22')
            self.assertEqual((app.catalog,app.history,app.history_index,app.folder,app.source,app.revision,app.dirty),before)
            self.assertEqual(rival.load()[1:3],('other','changed'))
            app.project._snapshot=app.project._read_snapshot()
            with patch.object(app,'commit',wraps=app.commit) as commit: buttons['목록 덮어쓰기'].invoke(); commit.assert_called_once()
            self.assertFalse(win.winfo_exists()); app.preview.assert_not_called()
        with patch.object(main.tk,'Toplevel',hidden),patch.object(original,'wait_window',exercise): app.paste()
        self.assertIs(app.folder,ui.ALL); self.assertEqual(app.source,'source.json'); self.assertEqual(app.revision,'revision')
        after=copy.deepcopy(app.catalog); app.undo(); self.assertEqual(app.catalog,self.base); app.redo(); self.assertEqual(app.catalog,after)
        self.assertEqual(app.project.load()[0],after)

    def test_footer_allocation_at_small_sizes_and_scaling(self):
        app,root=self.make_app(); original=tk.Toplevel
        def hidden(*args,**kwargs):
            win=original(*args,**kwargs); win.withdraw(); return win
        def exercise(win,*args):
            for scale in (1.33,1.67,2.0):
                root.tk.call('tk','scaling',scale); win.geometry('540x360'); root.update_idletasks()
                widgets=list(walk(win)); options=next(w for w in widgets if isinstance(w,main.ImportOptions)); options.count.set('16'); options.has_id.set(True)
                error=next(w for w in widgets if isinstance(w,ttk.Label) and str(w.cget('foreground'))=='#a12622')
                root.setvar(error.cget('textvariable'),'긴 오류 안내입니다. '*40); root.update_idletasks()
                button=next(w for w in widgets if isinstance(w,ttk.Button) and w.cget('text')=='목록 덮어쓰기')
                cancel=next(w for w in widgets if isinstance(w,ttk.Button) and w.cget('text')=='취소')
                self.assertLessEqual(button.winfo_reqwidth()+cancel.winfo_reqwidth()+30,520)
                self.assertLessEqual(win.paste_footer.winfo_reqheight()+20,360)
                self.assertEqual(win.grid_rowconfigure(0)['weight'],1)
                self.assertEqual(win.paste_footer.grid_info()['row'],1)
            win.destroy()
        with patch.object(main.tk,'Toplevel',hidden),patch.object(original,'wait_window',exercise): app.paste()

    def test_scrolling_recalculates_after_long_error_and_option_change(self):
        app,root=self.make_app()
        def hidden(*args,**kwargs):
            win=tk.Frame(root,width=540,height=360); win.place(x=0,y=0,width=540,height=360); win.grid_propagate(False)
            win.title=lambda *a:None; win.transient=lambda *a:None; win.grab_set=lambda *a:None
            win.geometry=lambda *a:None; win.minsize=lambda *a:None; win.wait_window=lambda *a:exercise(win)
            return win
        def exercise(win):
            widgets=list(walk(win)); options=next(w for w in widgets if isinstance(w,main.ImportOptions))
            error=next(w for w in widgets if isinstance(w,ttk.Label) and str(w.cget('foreground'))=='#a12622')
            options.count.set('16'); options.has_id.set(True)
            root.setvar(error.cget('textvariable'),'긴 오류 안내입니다. '*40); root.update_idletasks()
            region=list(map(int,win.paste_canvas.cget('scrollregion').split()))
            self.assertGreaterEqual(region[3],win.paste_content.winfo_reqheight())
            self.assertGreaterEqual(int(float(win.paste_canvas.itemcget(1,'height'))),win.paste_content.winfo_reqheight())
            self.assertGreater(region[3],win.paste_canvas.winfo_height())
            root.setvar(error.cget('textvariable'),''); options.count.set('0'); root.update_idletasks()
            region=list(map(int,win.paste_canvas.cget('scrollregion').split()))
            self.assertEqual(region[3],max(win.paste_canvas.winfo_height(),win.paste_content.winfo_reqheight()))
            win.destroy()
        with patch.object(main.tk,'Toplevel',hidden): app.paste()


if __name__=='__main__': unittest.main()
