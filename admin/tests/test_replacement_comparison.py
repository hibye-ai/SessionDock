import copy
import os
from pathlib import Path
import sys
import tempfile
import tkinter as tk
from tkinter import ttk
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core
import main


def walk(widget):
    for child in widget.winfo_children():
        yield child
        yield from walk(child)


class DirectReplacementWorkflowTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        env=patch.dict(os.environ,{'LOCALAPPDATA':temp.name}); env.start(); self.addCleanup(env.stop)
        self.root=tk.Tk(); self.root.withdraw(); self.addCleanup(self.root.destroy)
        self.app=main.App(self.root); self.addCleanup(self.app.project.close)
        self.base=core.validate_catalog({'version':1,'sessions':[{'id':'one','name':'Alpha','host':'a.test','folder':'net','notes':'keep'}],'folders':['empty']})
        self.app.commit(self.base)

    def dialog(self, exercise):
        original=tk.Toplevel
        def hidden(*args,**kwargs):
            win=original(*args,**kwargs); win.withdraw(); return win
        with patch.object(main.tk,'Toplevel',hidden),patch.object(original,'wait_window',exercise): self.app.paste()

    def button(self,win,label):
        return next(w for w in walk(win) if isinstance(w,ttk.Button) and w.cget('text')==label)

    def input(self,win,text,has_id=False):
        win.paste_options.count.set('0'); win.paste_options.header.set(False); win.paste_options.has_id.set(has_id)
        win.paste_editor.insert('1.0',text); self.root.update()

    def test_single_commit_duplicate_rows_explicit_id_undo_redo(self):
        def exercise(win,*args):
            self.input(win,'one\tAlpha\ta.test\tssh\t22\ntwo\tAlpha\ta.test\tssh\t22',True)
            self.assertFalse(any(isinstance(w,ttk.Button) and w.cget('text')=='변경 비교' for w in walk(win)))
            with patch.object(self.app,'commit',wraps=self.app.commit) as commit,patch.object(self.app.project,'save',wraps=self.app.project.save) as save:
                self.button(win,'목록 덮어쓰기').invoke(); commit.assert_called_once(); save.assert_called_once()
            self.assertFalse(win.winfo_exists())
        self.dialog(exercise)
        after=copy.deepcopy(self.app.catalog)
        self.assertEqual([s['id'] for s in after['sessions']],['one','two'])
        self.assertNotIn('notes',after['sessions'][0]); self.assertEqual(after['folders'],[])
        self.app.undo(); self.assertEqual(self.app.catalog,self.base)
        self.app.redo(); self.assertEqual(self.app.catalog,after)
        self.assertEqual(self.app.project.load()[0],after)

    def test_cancel_and_failed_save_keep_input_options_and_history(self):
        def exercise(win,*args):
            self.input(win,'New\td.test\tssh\t22')
            before=(copy.deepcopy(self.app.catalog),self.app.history[:],self.app.history_index)
            with patch.object(self.app.project,'save',side_effect=OSError('failure')):
                self.button(win,'목록 덮어쓰기').invoke()
            self.assertTrue(win.winfo_exists()); self.assertEqual(win.paste_editor.get('1.0','end-1c'),'New\td.test\tssh\t22')
            self.assertEqual(win.paste_options.values(),(0,False,False))
            self.assertEqual((self.app.catalog,self.app.history,self.app.history_index),before)
            self.button(win,'취소').invoke(); self.assertEqual(self.app.catalog,self.base)
        self.dialog(exercise)

    def test_direct_5000_rows(self):
        def exercise(win,*args):
            self.input(win,'\n'.join('same\ta.test\tssh\t22' for _ in range(5000)))
            self.button(win,'목록 덮어쓰기').invoke()
            self.assertFalse(win.winfo_exists())
        self.dialog(exercise)
        self.assertEqual(len(self.app.catalog['sessions']),5000)
        self.assertEqual(len({s['id'] for s in self.app.catalog['sessions']}),5000)

    def test_footer_at_small_sizes(self):
        def exercise(win,*args):
            for scale in (1.0,1.33,1.67,2.0):
                self.root.tk.call('tk','scaling',scale); win.geometry('540x360'); self.root.update_idletasks()
                self.assertEqual(win.paste_footer.grid_info()['row'],1)
                self.assertLessEqual(win.paste_footer.winfo_reqheight()+20,360)
                self.assertLessEqual(sum(self.button(win,label).winfo_reqwidth() for label in ('취소','목록 덮어쓰기'))+30,520)
            win.destroy()
        self.dialog(exercise)


if __name__=='__main__': unittest.main()
