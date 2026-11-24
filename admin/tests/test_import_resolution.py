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


def fixture(target='skip'):
    base = core.validate_catalog({'version': 1, 'folders': ['empty'], 'sessions': [
        {'id': target, 'name': 'Old-1', 'host': '192.0.2.1', 'folder': 'F',
         'encoding': 'cp949', 'tags': ['keep'], 'notes': 'preserve'},
        {'id': 'other', 'name': 'Old-2', 'host': '192.0.2.1', 'folder': 'F'},
    ]})
    rows = [{'name': 'Updated', 'host': '192.0.2.1', 'folder': 'F'}]
    return base, rows, core.plan_merge(base, rows)


def walk(widget):
    for child in widget.winfo_children():
        yield child
        yield from walk(child)


def button(win, label):
    return next(w for w in walk(win) if isinstance(w, ttk.Button) and w.cget('text') == label)


class ImportResolutionTests(unittest.TestCase):
    def test_existing_special_and_ordinary_preserves_settings(self):
        for ident in ('skip', 'new', 'ordinary'):
            with self.subTest(ident=ident):
                base, rows, plan = fixture(ident); before = copy.deepcopy(base)
                result = core.apply_plan(base, plan, {1: {'action': 'existing', 'id': ident}})
                self.assertEqual(base, before)
                self.assertEqual(len(result['sessions']), 2)
                self.assertEqual([s['id'] for s in result['sessions']], [ident, 'other'])
                selected = result['sessions'][0]
                self.assertEqual((selected['name'], selected['encoding'], selected['tags'], selected['notes']), ('Updated', 'cp949', ['keep'], 'preserve'))
                self.assertEqual(result['folders'], before['folders'])
                self.assertEqual(result['sessions'][1], before['sessions'][1])

    def test_commands_and_legacy(self):
        base, rows, plan = fixture('ordinary')
        for choice in ('skip', {'action': 'skip'}):
            self.assertEqual(core.apply_plan(base, plan, {1: choice}), base)
        for choice in ('new', {'action': 'new'}):
            result = core.apply_plan(base, plan, {1: choice})
            self.assertEqual(len(result['sessions']), 3)
            self.assertEqual(result['sessions'][:2], base['sessions'])
            self.assertEqual(result['sessions'][2]['name'], 'Updated')
        self.assertEqual(core.apply_plan(base, plan, {1: 'ordinary'})['sessions'][0]['name'], 'Updated')
        self.assertEqual(core.apply_plan(base, plan, {1: 'skip'}), base)
        with self.assertRaises(core.ValidationError): core.apply_plan(base, plan)

    def test_invalid_choices_leave_original_unchanged(self):
        base, rows, plan = fixture(); before = copy.deepcopy(base)
        bad = [None, {}, [], 1, '', {'action': 'unknown'}, {'action': []},
               {'action': 'existing'}, {'action': 'existing', 'id': None},
               {'action': 'existing', 'id': ''}, {'action': 'existing', 'id': 'missing'},
               {'action': 'existing', 'id': 'other', 'extra': True},
               {'action': 'skip', 'id': 'skip'}, {'action': 'new', 'id': 'skip'}]
        # A real ID outside this row's candidates is also rejected.
        base['sessions'].append(core.profile({'id': 'outside', 'name': 'X', 'host': '192.0.2.9'}))
        before = copy.deepcopy(base); plan = core.plan_merge(base, rows)
        bad.append({'action': 'existing', 'id': 'outside'})
        for choice in bad:
            with self.subTest(choice=choice), self.assertRaises(core.ValidationError):
                core.apply_plan(base, plan, {1: choice})
            self.assertEqual(base, before)
        broken = copy.deepcopy(plan); broken['items'][0]['candidates'].append('missing')
        with self.assertRaises(core.ValidationError): core.apply_plan(base, broken, {1: {'action': 'existing', 'id': 'missing'}})
        self.assertEqual(base, before)

    def test_duplicate_existing_and_stale_base(self):
        base, rows, _ = fixture()
        plan = core.plan_merge(base, rows + [dict(rows[0], name='Another')])
        original = copy.deepcopy(base)
        with self.assertRaisesRegex(core.ValidationError, '같은 기존 세션'):
            core.apply_plan(base, plan, {1: {'action': 'existing', 'id': 'skip'}, 2: {'action': 'existing', 'id': 'skip'}})
        self.assertEqual(base, original)
        changed = copy.deepcopy(base); changed['sessions'][0]['notes'] = 'concurrent'
        changed_before = copy.deepcopy(changed)
        with self.assertRaises(core.ConflictError):
            core.apply_plan(changed, plan, {1: {'action': 'existing', 'id': 'skip'}, 2: {'action': 'skip'}})
        self.assertEqual(changed, changed_before)

    def test_withdrawn_preview_selection_reopen_and_cancel(self):
        root = tk.Tk(); root.withdraw(); self.addCleanup(root.destroy)
        errors = []; root.report_callback_exception = lambda kind, error, trace: errors.append(error)
        original = tk.Toplevel
        def hidden(*args, **kwargs):
            win = original(*args, **kwargs); win.withdraw(); return win
        for ident in ('skip', 'new', 'ordinary'):
            with self.subTest(ident=ident):
                base, rows, plan = fixture(ident)
                app = main.App.__new__(main.App); app.root = root; app.catalog = copy.deepcopy(base); app.pending = None
                commits = []; app.commit = lambda cat: commits.append(copy.deepcopy(cat))
                visits = []
                def exercise(win, *args):
                    self.assertFalse(win.winfo_ismapped())
                    if win.title() == '행 처리':
                        visits.append(1)
                        radios = [w for w in walk(win) if isinstance(w, ttk.Radiobutton)]
                        candidates = next(w for w in walk(win) if isinstance(w, ttk.Treeview))
                        if len(visits) > 1:
                            self.assertEqual(win.getvar(radios[0].cget('variable')), 'existing')
                            self.assertEqual(candidates.selection(), (ident,))
                            button(win, '취소').invoke(); return
                        candidates.selection_set(ident)
                        next(w for w in radios if w.cget('text') == '선택한 기존 세션').invoke()
                        button(win, '확인').invoke()
                    else:
                        tree = next(w for w in walk(win) if isinstance(w, ttk.Treeview))
                        tree.selection_set('1'); button(win, '선택 행 처리').invoke()
                        self.assertEqual(tree.set('1', 'choice'), '기존 세션: ' + ident)
                        self.assertEqual(win.comparison_tree.set('name', 'before'), 'Old-1')
                        self.assertEqual(win.comparison_tree.set('name', 'after'), 'Updated')
                        button(win, '선택 행 처리').invoke()
                        self.assertEqual(tree.set('1', 'choice'), '기존 세션: ' + ident)
                        self.assertEqual(str(button(win, '적용').cget('state')), 'normal')
                        button(win, '적용').invoke()
                with patch.object(main.tk, 'Toplevel', hidden), patch.object(original, 'wait_window', exercise), \
                     patch.object(main.messagebox, 'showerror', side_effect=AssertionError('unexpected dialog')), \
                     patch.object(tk.Misc, 'clipboard_get', side_effect=AssertionError('clipboard forbidden')):
                    self.assertTrue(app.preview(rows))
                self.assertEqual(len(commits), 1); self.assertEqual(len(commits[0]['sessions']), 2)
                self.assertEqual(commits[0]['sessions'][0]['id'], ident)
                self.assertEqual(commits[0]['sessions'][0]['name'], 'Updated')
                self.assertEqual(commits[0]['sessions'][0]['encoding'], 'cp949')
                self.assertEqual(ui.import_validation(base, plan, {1: {'action': 'existing', 'id': ident}}), (0, ''))
        self.assertEqual(errors, [])


if __name__ == '__main__': unittest.main()
