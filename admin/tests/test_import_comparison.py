import copy
from pathlib import Path
import sys
import tkinter as tk
from tkinter import ttk
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core
import main
import ui


def row(ident, name, host):
    return {'id': ident, 'name': name, 'host': host, 'protocol': 'ssh', 'port': 22, 'folder': 'Net'}


def walk(widget):
    for child in widget.winfo_children():
        yield child
        yield from walk(child)


def button(win, label):
    return next(w for w in walk(win) if isinstance(w, ttk.Button) and w.cget('text') == label)


class ComparisonTests(unittest.TestCase):
    def test_exact_changes_and_effective_choices(self):
        base = core.validate_catalog({'version': 1, 'sessions': [row('a', 'Alpha', 'a.test'), row('b', 'Other', 'same.test'), row('c', 'Third', 'same.test')]})
        before = copy.deepcopy(base)
        rows = [row('a', 'ALPHA', 'A.TEST'), {'name': 'New', 'host': 'same.test', 'folder': 'Net'}]
        plan = core.plan_merge(base, rows)
        self.assertEqual([item['status'] for item in plan['items']], ['변경', '확인필요'])
        lookup = {s['id']: s for s in base['sessions']}
        for choice, expected in [({'action':'skip'}, '건너뜀'), ({'action':'new'}, '추가'), ({'action':'existing','id':'b'}, '변경')]:
            choices = {2: choice}
            counts, unresolved = ui.import_summary(plan, choices, base)
            self.assertEqual((counts['변경'], counts[expected], unresolved), (2 if expected == '변경' else 1, 2 if expected == '변경' else 1, 0))
            item = ui.import_result(plan['items'][1], choices, lookup)
            self.assertEqual(item['status'], expected)
            result = core.apply_plan(base, plan, choices)
            if expected == '건너뜀':
                self.assertIsNone(item['before']); self.assertIsNone(item['after']); self.assertEqual(result['sessions'][1:], base['sessions'][1:])
            elif expected == '추가':
                self.assertIsNone(item['before']); self.assertEqual(result['sessions'][-1]['name'], item['after']['name'])
            else:
                self.assertEqual(item['before']['id'], 'b'); self.assertEqual(result['sessions'][1]['name'], item['after']['name'])
        self.assertEqual(base, before)
        no_id = core.plan_merge(base, [{'name':'ALPHA','host':'A.TEST','protocol':'ssh','port':22,'folder':'Net'}])
        self.assertEqual(no_id['items'][0]['status'], '변경')

    def test_existing_resolution_can_be_unchanged_and_invalid_stays_unresolved(self):
        base = core.validate_catalog({'version':1, 'sessions':[row('a','Alpha','same.test'),row('b','Alpha','same.test')]})
        plan = core.plan_merge(base, [{'name':'Alpha','host':'same.test','folder':'Net'}])
        counts, unresolved = ui.import_summary(plan, {1:{'action':'existing','id':'a'}}, base)
        self.assertEqual((counts['동일'], unresolved), (1, 0))
        self.assertEqual(ui.import_summary(plan, {1:{'action':'existing','id':'missing'}}, base)[1], 1)

    def test_hidden_preview_choices_footer_cancel_and_grab(self):
        root=tk.Tk(); root.withdraw(); self.addCleanup(root.destroy)
        errors=[]; root.report_callback_exception=lambda kind, error, trace: errors.append(error)
        base=core.validate_catalog({'version':1,'sessions':[row('a','First','same.test'),row('b','Second','same.test')]})
        app=main.App.__new__(main.App); app.root=root; app.catalog=copy.deepcopy(base); app.pending=None
        commits=[]; app.commit=lambda cat: commits.append(cat)
        original=tk.Toplevel; actions=iter(['skip','new','existing'])
        def hidden(*args,**kwargs):
            win=original(*args,**kwargs); win.withdraw(); return win
        def exercise(win,*args):
            if win.title()=='행 처리':
                action=next(actions); radios=[w for w in walk(win) if isinstance(w,ttk.Radiobutton)]
                if action=='existing':
                    candidate=next(w for w in walk(win) if isinstance(w,ttk.Treeview)); candidate.selection_set('a')
                next(w for w in radios if w.cget('value')==action).invoke()
                button(win,'확인').invoke(); return
            tree=next(w for w in walk(win) if isinstance(w,ttk.Treeview))
            tree.selection_set('1')
            for action, status, old, new in [('skip','건너뛰기','적용 안 함','적용 안 함'),('new','추가','없음','Updated'),('existing','갱신','First','Updated')]:
                button(win,'선택 행 처리').invoke()
                self.assertIs(root.grab_current(),win)
                self.assertEqual(tree.set('1','status'),status)
                self.assertEqual((win.comparison_tree.set('name','before'),win.comparison_tree.set('name','after')),(old,new))
                self.assertEqual(bool(win.comparison_tree.item('name','tags')),action!='skip')
                self.assertIn(f'{status} 1',next(w.cget('text') for w in walk(win) if isinstance(w,ttk.Label) and '확인 필요' in str(w.cget('text'))))
            button(win,'취소').invoke()
        with patch.object(main.tk,'Toplevel',hidden), patch.object(original,'wait_window',exercise):
            self.assertFalse(app.preview([{'name':'Updated','host':'same.test','folder':'Net'}]))
        self.assertEqual(app.catalog,base); self.assertEqual(commits,[]); self.assertIsNone(app.pending); self.assertEqual(errors,[])

    def test_preview_footer_geometry_in_hidden_frame(self):
        for scale in (1.0,1.33,1.67,2.0):
            with self.subTest(scale=scale):
                root=tk.Tk(); root.withdraw(); root.tk.call('tk','scaling',scale)
                app=main.App.__new__(main.App); app.root=root; app.catalog=core.validate_catalog({'version':1,'sessions':[]}); app.pending=None
                app.commit=lambda cat: self.fail('unexpected commit')
                long_host='a'*200+'.test'; long_folder='long-folder-'*70
                def hidden(*args,**kwargs):
                    win=tk.Frame(root,width=540,height=360); win.place(x=0,y=0,width=540,height=360); win.grid_propagate(False)
                    win.title=lambda *a:None; win.geometry=lambda *a:None; win.transient=lambda *a:None; win.grab_set=lambda *a:None
                    win.protocol=lambda *a:None; win.wait_window=lambda *a:exercise(win)
                    return win
                def exercise(win):
                    tree=next(w for w in walk(win) if isinstance(w,ttk.Treeview)); tree.selection_set('1')
                    root.update()
                    comparison=win.comparison_tree
                    self.assertEqual(comparison.set('host','after'),long_host)
                    self.assertEqual(comparison.set('folder','after'),long_folder)
                    self.assertTrue(comparison.cget('xscrollcommand'))
                    horizontal=next(w for w in comparison.master.winfo_children() if isinstance(w,ttk.Scrollbar) and str(w.cget('orient'))=='horizontal')
                    self.assertTrue(horizontal.cget('command'))
                    root.tk.call(comparison.cget('xscrollcommand'),0.25,0.75)
                    self.assertEqual(horizontal.get(),(0.25,0.75))
                    self.assertGreater(int(comparison.column('after','width')),350)
                    self.assertGreaterEqual(int(comparison.column('after','width')),tk.font.Font(root=root,font=ttk.Style(root).lookup('Treeview','font') or 'TkDefaultFont').measure(long_folder))
                    self.assertGreaterEqual(int(comparison.column('before','minwidth')),220)
                    self.assertTrue(comparison.column('after','stretch'))
                    footer=button(win,'적용').master
                    self.assertLessEqual(footer.winfo_y()+footer.winfo_height(),win.winfo_height())
                    self.assertGreater(button(win,'적용').winfo_height(),1)
                    button(win,'취소').invoke()
                try:
                    with patch.object(main.tk,'Toplevel',hidden):
                        self.assertFalse(app.preview([dict(row('a','Alpha',long_host),folder=long_folder)]))
                finally:
                    root.update_idletasks(); root.destroy()


if __name__=='__main__': unittest.main()
