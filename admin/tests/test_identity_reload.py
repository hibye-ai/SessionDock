import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core
import main

def catalog(sessions=()):
    return core.validate_catalog({'version': 1, 'sessions': list(sessions)})

def row(ident='id', name='old', host='2001:db8::1', folder='old'):
    return {'id': ident, 'name': name, 'host': host, 'folder': folder, 'notes': 'keep', 'encoding': 'cp949'}

class MergeIdentityTests(unittest.TestCase):
    def test_new_explicit_id_duplicate_and_apply_defense(self):
        base = catalog(); first = row('new', 'first'); second = row('new', 'second')
        with self.assertRaisesRegex(core.ValidationError, '2행.*중복'): core.plan_merge(base, [first, second])
        plan = core.plan_merge(base, [first, row('other', 'second')])
        plan['items'][1]['profile']['id'] = 'new'
        with self.assertRaisesRegex(core.ValidationError, '2행.*중복'): core.apply_plan(base, plan)
        duplicate = core.plan_merge(base, [first, first])
        self.assertEqual(duplicate['duplicates'], 1)
        self.assertEqual(len(core.apply_plan(base, duplicate)['sessions']), 1)

    def test_existing_explicit_conflict_resolutions(self):
        base = catalog([row()]); plan = core.plan_merge(base, [row(name='first'), row(name='second')])
        self.assertEqual(plan['items'][1]['status'], '확인필요')
        skipped = core.apply_plan(base, plan, {2:'skip'})
        self.assertEqual(len(skipped['sessions']), 1)
        self.assertEqual(skipped['sessions'][0]['name'], 'first')
        added = core.apply_plan(base, plan, {2:'new'})
        self.assertEqual(len(added['sessions']), 2)
        self.assertNotEqual(added['sessions'][0]['id'], added['sessions'][1]['id'])
        self.assertEqual(added['sessions'][1]['name'], 'second')

    def test_ipv6_matching_scope_and_ambiguity(self):
        base = catalog([row()]); incoming = {'name':'renamed','host':'2001:0DB8:0:0:0:0:0:1','folder':'new'}
        for result in (core.apply_plan(base,core.plan_merge(base,[incoming])),):
            s = result['sessions'][0]
            self.assertEqual((s['id'], s['name'], s['host'], s['folder'], s['notes'], s['encoding']), ('id','renamed',incoming['host'],'new','keep','cp949'))
        self.assertEqual(core.endpoint(core.profile(row(host='FE80::1%eth0'))), core.endpoint(core.profile(row(host='fe80:0:0:0:0:0:0:1%eth0'))))
        self.assertNotEqual(core.endpoint(core.profile(row(host='fe80::1%eth0'))), core.endpoint(core.profile(row(host='fe80::1%eth1'))))
        self.assertNotEqual(core.endpoint(core.profile(row(host='fe80::1%Eth0'))), core.endpoint(core.profile(row(host='fe80::1%eth0'))))
        self.assertEqual(core.endpoint(core.profile(row(host='Example.COM'))), core.endpoint(core.profile(row(host='example.com'))))
        ambiguous = catalog([row(),row('other','different','2001:0db8::1','another')])
        fresh=core.replace_catalog(ambiguous,[incoming])['sessions'][0]
        self.assertNotIn('notes',fresh); self.assertNotIn(fresh['id'],('id','other'))
        plan=core.plan_merge(ambiguous,[incoming]); self.assertEqual(plan['items'][0]['status'],'확인필요')
        with self.assertRaises(core.ValidationError): core.apply_plan(ambiguous,plan)

class ReloadTests(unittest.TestCase):
    def test_reload_snapshot_validation_and_rival_write(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'state.sqlite'; a=core.Project(path); b=core.Project(path)
            try:
                a.save(catalog([row()])); before=b._snapshot
                self.assertEqual(b.load()[0]['sessions'][0]['id'],'id'); self.assertEqual(b._snapshot,before)
                self.assertEqual(b.reload()[0]['sessions'][0]['id'],'id')
                a.reload(); a.save(catalog([row(name='rival')]))
                with self.assertRaises(core.ConflictError): b.save(catalog())
                b.reload(); good_snapshot=b._snapshot
                a.reload(); a.db.execute('UPDATE state SET catalog=? WHERE id=1',('{broken',)); a.db.commit()
                with self.assertRaises(json.JSONDecodeError): b.reload()
                self.assertEqual(b._snapshot,good_snapshot)
                with self.assertRaises(core.ConflictError): b.save(catalog())
            finally: a.close(); b.close()

    def make_app(self):
        app=main.App.__new__(main.App); app.root=Mock(); app.project=Mock(); app.catalog=catalog([row()]); app.source='old'; app.revision='rev'; app.dirty=True; app.pending={'old':1}; app.timer='timer'; app.local_save_failed=True; app.history=[b'old']; app.history_index=0; app.history_notice='old'; app.tree=Mock(); app.tree.selection.return_value=('id',); app.sort='host'; app.descending=True; app.reset_view=Mock(); app.refresh=Mock()
        return app

    def state(self, app):
        return copy.deepcopy((app.catalog, app.source, app.revision, app.dirty, app.pending, app.timer, app.local_save_failed, app.history, app.history_index, app.history_notice, app.sort, app.descending))

    def test_ui_reload_cancel_failure_and_success(self):
        app=self.make_app(); before=self.state(app)
        with patch.object(main.messagebox,'askyesno',return_value=False): app.reload_latest()
        app.project.reload.assert_not_called(); self.assertEqual(self.state(app),before)
        app.project.reload.side_effect=OSError('read')
        with patch.object(main.messagebox,'askyesno',return_value=True), patch.object(main.messagebox,'showerror') as error: app.reload_latest()
        self.assertTrue(error.called); self.assertEqual(self.state(app),before)
        latest=catalog([row(name='latest')]); app.project.reload.side_effect=None; app.project.reload.return_value=(latest,'new','r2',False)
        with patch.object(main.messagebox,'askyesno',return_value=True): app.reload_latest()
        self.assertEqual((app.catalog,app.source,app.revision,app.dirty,app.pending,app.local_save_failed),(latest,'new','r2',False,None,False))
        self.assertEqual((app.history,app.history_index,app.history_notice),([], -1, ''))
        app.reset_view.assert_called_once(); app.refresh.assert_called_once()

    def test_close_save_errors_ask_once_after_real_guard(self):
        for exception in (OSError('disk'), core.ConflictError('rival')):
            for prior_failure in (False, True):
                for discard in (False, True):
                    with self.subTest(exception=exception, prior_failure=prior_failure, discard=discard):
                        app=self.make_app(); app.local_save_failed=prior_failure
                        app.persist=Mock(side_effect=exception); before=self.state(app)
                        with patch.object(main.messagebox,'askyesno',side_effect=[True,True,discard]) as ask, patch.object(main.messagebox,'showerror') as error:
                            app.close()
                        self.assertEqual(ask.call_count,3)
                        self.assertIn(str(exception),ask.call_args.args[1])
                        self.assertIn('버리고',ask.call_args.args[1])
                        error.assert_not_called(); app.persist.assert_called_once()
                        if discard:
                            app.root.after_cancel.assert_called_once_with('timer'); app.project.close.assert_called_once(); app.root.destroy.assert_called_once()
                        else:
                            self.assertEqual(self.state(app),before); app.root.after_cancel.assert_not_called(); app.project.close.assert_not_called(); app.root.destroy.assert_not_called()

    def test_close_real_guard_cancel_and_success(self):
        for answers in ([False], [True,False]):
            app=self.make_app(); app.persist=Mock(); before=self.state(app)
            with patch.object(main.messagebox,'askyesno',side_effect=answers) as ask: app.close()
            self.assertEqual(ask.call_count,len(answers)); self.assertEqual(self.state(app),before)
            app.persist.assert_not_called(); app.root.destroy.assert_not_called()
        app=self.make_app(); app.persist=Mock()
        with patch.object(main.messagebox,'askyesno',side_effect=[True,True]) as ask: app.close()
        self.assertEqual(ask.call_count,2); app.persist.assert_called_once(); self.assertFalse(app.local_save_failed)
        app.root.after_cancel.assert_called_once_with('timer'); self.assertIsNone(app.timer); app.project.close.assert_called_once(); app.root.destroy.assert_called_once()

    def test_close_real_sqlite_rival_survives_discard_or_cancel(self):
        for discard in (False,True):
            with self.subTest(discard=discard), tempfile.TemporaryDirectory() as d:
                path=Path(d)/'state.sqlite'; writer=core.Project(path); writer.save(catalog([row()]))
                app=self.make_app(); app.project=core.Project(path); app.pending=None; app.dirty=False
                app.catalog=app.project.load()[0]; app.catalog['sessions'][0]['name']='unsaved'
                writer.save(catalog([row(name='rival')]))
                before=self.state(app)
                with patch.object(main.messagebox,'askyesno',return_value=discard) as ask: app.close()
                self.assertEqual(ask.call_count,1); self.assertIn('버리고',ask.call_args.args[1])
                self.assertEqual(writer.load()[0]['sessions'][0]['name'],'rival')
                if discard:
                    app.root.after_cancel.assert_called_once_with('timer'); app.root.destroy.assert_called_once()
                else:
                    self.assertEqual(self.state(app),before); app.root.destroy.assert_not_called(); app.project.close()
                writer.close()

    def test_new_and_open_conflict_guide_reload_and_preserve_state(self):
        app=self.make_app(); before=self.state(app); app.guard=Mock(return_value=True)
        app.project.save.side_effect=core.ConflictError('파일 메뉴의 최신 작업 다시 불러오기를 사용하세요.')
        with patch.object(main.messagebox,'showerror') as error:
            app.new()
            self.assertIn('최신 작업 다시 불러오기',error.call_args.args[1])
        self.assertEqual(self.state(app),before)
        with patch.object(main.filedialog,'askopenfilename',return_value='input.json'), patch.object(main.core,'load_catalog',return_value=(catalog(),'r')), patch.object(main.messagebox,'showerror') as error:
            app.open()
            self.assertIn('최신 작업 다시 불러오기',error.call_args.args[1])
        self.assertEqual(self.state(app),before)

if __name__ == '__main__': unittest.main()
