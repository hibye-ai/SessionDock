from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import core
import main

def session(ident='a',name='R1',host='192.0.2.1',folder='A'):
    return {'id':ident,'name':name,'host':host,'protocol':'ssh','port':22,'folder':folder}

def catalog(sessions=()): return {'version':1,'sessions':list(sessions),'folders':['empty'],'snippets':[]}

class CoreTests(unittest.TestCase):
    def test_merge_ambiguous_resolutions_and_preservation(self):
        base=catalog([session('a'),session('b'),session('c','R2','192.0.2.2')])
        plan=core.plan_merge(base,[{'name':'R1','host':'192.0.2.1','protocol':'ssh','port':22,'folder':'A'}, {'name':'R3','host':'192.0.2.3','protocol':'ssh','port':22,'folder':'C'}])
        self.assertEqual(plan['items'][0]['status'],'확인필요')
        with self.assertRaises(core.ValidationError): core.apply_plan(base,plan)
        result=core.apply_plan(base,plan,{1:'skip'})
        self.assertEqual({s['id'] for s in result['sessions']} & {'a','b','c'},{'a','b','c'}); self.assertEqual(len(result['sessions']),4)
        self.assertIn('empty',result['folders'])
    def test_exact_reservation_and_id(self):
        base=catalog([session()]); rows=[dict(session(),id='',name='new'),dict(session(),id='')]
        plan=core.plan_merge(base,rows); result=core.apply_plan(base,plan)
        self.assertEqual(len(result['sessions']),2); self.assertEqual(result['sessions'][0]['name'],'R1')
        plan=core.plan_merge(base,[dict(session(),name='changed',host='192.0.2.9')]); self.assertEqual(core.apply_plan(base,plan)['sessions'][0]['id'],'a')
    def test_duplicate_and_conflict(self):
        row=session(); plan=core.plan_merge(catalog([row]),[row,row]); self.assertEqual(plan['duplicates'],1)
        plan=core.plan_merge(catalog([row]),[dict(row,name='X'),dict(row,name='Y')]); self.assertEqual(plan['items'][1]['status'],'확인필요')
        with self.assertRaises(core.ValidationError): core.apply_plan(catalog([row]),plan,{2:'a'})
    def test_whitelist_and_keymap(self):
        p=core.profile(dict(session(),password='secret',credentialId='a',privateKeyPath='secret',forwards=[{}],encoding='windows949',keymap=[{'key':'shift+control+Up','text':'\\x1b'}]))
        self.assertNotIn('password',p); self.assertNotIn('forwards',p); self.assertEqual(p['encoding'],'cp949'); self.assertEqual(p['keymap'][0]['key'],'Ctrl+Shift+ArrowUp')
        for bad in ([{'key':'F3','text':'x'}],[{'key':'A','text':'\\x2'}],[{'key':'A','text':'x'},{'key':'KeyA','text':'x'}]):
            with self.assertRaises(core.ValidationError): core.profile(dict(session(),keymap=bad))
        with self.assertRaises(core.ValidationError): core.profile(dict(session(),encoding='unknown'))
    def test_backup_revision_and_lock(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'a.json'; first=core.publish(p,catalog([session()]),None); original=p.read_bytes()
            second=core.publish(p,catalog([session(host='192.0.2.2')]),first)
            self.assertEqual(next(Path(d).glob('a.json.*.bak.json')).read_bytes(),original)
            with self.assertRaises(core.ConflictError): core.publish(p,catalog(),first)
            self.assertEqual(core.load_catalog(p)[1],second)
            lock=p.parent/('.sessiondock-publish-'+core.sha(p.name.lower().encode())+'.lock'); lock.mkdir()
            with self.assertRaises(core.ConflictError): core.publish(p,catalog(),second)
            self.assertEqual(core.load_catalog(p)[1],second)
    def test_change_during_temp_write_does_not_replace(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'a.json'; rev=core.publish(p,catalog([session()]),None); changed=core.encode_catalog(catalog([session('b')]))
            real=core.os.fsync; count=[0]
            def race(fd):
                real(fd); count[0]+=1
                if count[0]==3: p.write_bytes(changed)
            with patch.object(core.os,'fsync',race):
                with self.assertRaises(core.ConflictError): core.publish(p,catalog([session('c')]),rev)
            self.assertEqual(p.read_bytes(),changed)
    def test_project_transaction(self):
        with tempfile.TemporaryDirectory() as d:
            db=core.Project(Path(d)/'p.sqlite'); db.save(catalog([session()]),'a', 'r',True)
            with self.assertRaises(core.ValidationError): db.save(catalog([session(),session()]))
            self.assertEqual(db.load()[0]['sessions'][0]['id'],'a'); db.close()
    def test_project_stale_close_and_legacy_database(self):
        import sqlite3
        from types import SimpleNamespace
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'legacy.sqlite'
            from contextlib import closing
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), catalog TEXT NOT NULL, source TEXT, revision TEXT, dirty INTEGER NOT NULL)')
                db.execute('INSERT INTO state VALUES (1,?,?,?,?)',(core.encode_catalog(catalog([session()])).decode(),None,None,0))
                db.commit()
            first=core.Project(path); second=core.Project(path)
            old=second.load(); updated=first.load()[0]; updated['sessions'][0]['name']='new'
            first.save(updated,None,None,True)
            app=SimpleNamespace(project=second, root=SimpleNamespace(destroy=Mock()), guard=lambda:True, persist=lambda:second.save(*old))
            self.assertIsInstance(main.close_after_guard(app),core.ConflictError)
            self.assertTrue(app.local_save_failed); app.root.destroy.assert_not_called()
            self.assertEqual(second.load()[0]['sessions'][0]['name'],'new')
            with self.assertRaises(core.ConflictError): second.save(*old)
            first.save(updated,None,None,False); first.close(); second.close()
            reopened=core.Project(path); self.assertEqual(reopened.load()[0]['sessions'][0]['name'],'new'); reopened.close()
    def test_project_empty_and_legacy_writer_conflicts(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'p.sqlite'; a=core.Project(path); b=core.Project(path)
            a.save(catalog([session()]))
            with self.assertRaises(core.ConflictError): b.save(catalog())
            from contextlib import closing
            with closing(sqlite3.connect(path)) as db:
                db.execute('UPDATE state SET dirty=0 WHERE id=1'); db.commit()
            with self.assertRaises(core.ConflictError): a.save(catalog())
            a.close(); b.close()
    def test_sanitization_warning_priority_and_idempotence(self):
        original=dict(session(),jumpSessionId='fixture-route',proxy={},forwards=[{}],authType='key',privateKeyPath='fixture-path',importWarnings=[f'warning {i}' for i in range(64)])
        safe=core.profile(original); warnings=safe['importWarnings']
        self.assertEqual(len(warnings),64); self.assertIn('점프',warnings[0]); self.assertIn('개인키',warnings[1])
        self.assertNotIn('fixture-route',str(safe)); self.assertNotIn('fixture-path',str(safe))
        self.assertEqual(core.profile(safe),safe)
        self.assertEqual(original['authType'],'key'); self.assertEqual(len(original['importWarnings']),64)
    def test_tsv_and_xlsx(self):
        from openpyxl import Workbook
        t='ID\t폴더\t이름\t주소\t프로토콜\t포트\na\tA\tR1\t192.0.2.1\tssh\t22\n'
        self.assertEqual(core.read_tsv(t,1,True,True)[0]['id'],'a')
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'a.xlsx'; wb=Workbook(); ws=wb.active; ws.append(['name','host','protocol','port']); ws.append(['R1','192.0.2.1','ssh',22]); wb.save(p)
            self.assertEqual(len(core.read_xlsx(p,ws.title,0,True,False)),1)
            ws['A2']='=1+1'; wb.save(p)
            with self.assertRaises(core.ValidationError): core.read_xlsx(p,ws.title,0,True,False)
    def test_xlsx_sparse_extra_cells_and_false_dimension(self):
        from openpyxl import Workbook
        import zipfile
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'a.xlsx'; wb=Workbook(); ws=wb.active
            ws.append(['name','host','protocol','port','header ignored'])
            ws.append(['R1','192.0.2.1','ssh',22,'   '])
            ws['XFD2']=' '; wb.save(p)
            self.assertEqual(len(core.read_xlsx(p,ws.title,0)),1)
            for coordinate,value in [('E2','extra'),('XFD2','extra'),('XFD2','=1+1')]:
                ws['E2']=' '; ws['XFD2']=' '; ws[coordinate]=value; wb.save(p)
                with self.assertRaisesRegex(core.ValidationError,'2행'): core.read_xlsx(p,ws.title,0)
            ws['XFD2']='hidden'; wb.save(p)
            with zipfile.ZipFile(p) as source:
                entries=[(item,source.read(item)) for item in source.infolist()]
            with zipfile.ZipFile(p,'w') as target:
                for item,data in entries:
                    if item.filename=='xl/worksheets/sheet1.xml': data=data.replace(b'ref="A1:XFD2"',b'ref="A1:D2"')
                    target.writestr(item,data)
            with self.assertRaisesRegex(core.ValidationError,'2행'): core.read_xlsx(p,ws.title,0)
            with self.assertRaisesRegex(core.ValidationError,'폴더'): core.read_xlsx(p,ws.title,-1)
    def test_close_retains_state_if_save_fails_or_guard_denies(self):
        from unittest.mock import Mock
        app=Mock(); app.guard.return_value=False
        self.assertIsNone(main.close_after_guard(app)); app.persist.assert_not_called(); app.root.destroy.assert_not_called()
        app.guard.return_value=True; app.persist.side_effect=OSError('disk')
        self.assertIsInstance(main.close_after_guard(app),OSError)
        self.assertTrue(app.local_save_failed); app.project.close.assert_not_called(); app.root.destroy.assert_not_called()
        app.persist.side_effect=None
        self.assertIsNone(main.close_after_guard(app)); self.assertFalse(app.local_save_failed)
        app.project.close.assert_called_once(); app.root.destroy.assert_called_once()
    def test_scale(self):
        sessions=[session(str(i),'r'+str(i),'192.0.2.'+str(i%255),str(i)) for i in range(5000)]
        base=catalog(sessions); rows=[dict(s,id='') for s in sessions]
        result=core.apply_plan(base,core.plan_merge(base,rows)); self.assertEqual(len(result['sessions']),5000)
    def test_published_even_when_project_save_fails_and_can_retry(self):
        class State:
            catalog=catalog([session()]); source=None; revision=None; dirty=True
            def persist(self): raise OSError('local disk error')
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'a.json'; state=State()
            self.assertIsInstance(main.publish_and_persist(state,p),OSError)
            self.assertEqual(state.source,p); self.assertFalse(state.dirty); self.assertTrue(state.local_save_failed)
            self.assertEqual(state.revision,core.load_catalog(p)[1])
            with patch.object(state,'persist') as save:
                self.assertIsNone(main.publish_and_persist(state,p)); save.assert_called_once()
            self.assertFalse(state.local_save_failed)
            self.assertEqual(state.revision,core.load_catalog(p)[1])
    def test_tsv_protected_atomic_and_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'export.tsv'; p.write_bytes(b'old TSV')
            data=catalog([session()])
            with patch.object(core.os,'replace',side_effect=OSError('fail')):
                with self.assertRaises(OSError): core.export_tsv(p,data)
            self.assertEqual(p.read_bytes(),b'old TSV')
            core.export_tsv(p,data); rows=core.read_tsv(p.read_text(encoding='utf-8-sig'),1,True,True)
            self.assertEqual(rows[0]['id'],'a'); self.assertEqual(core.apply_plan(data,core.plan_merge(data,rows))['sessions'][0]['id'],'a')
            source=Path(d)/'source.json'; source.write_bytes(core.encode_catalog(data)); before=source.read_bytes()
            with self.assertRaises(core.ValidationError): core.export_tsv(source,data,[source])
            self.assertEqual(source.read_bytes(),before)
            for name,content in [('backup.tsv',before),('database.tsv',b'SQLite format 3\0synthetic')]:
                protected=Path(d)/name; protected.write_bytes(content)
                with self.assertRaises(core.ValidationError): core.export_tsv(protected,data)
                self.assertEqual(protected.read_bytes(),content)
            with self.assertRaises(core.ValidationError): core.export_tsv(p,data,[p])
    def test_tsv_changed_during_export_and_hardlinks(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'out.tsv'; p.write_bytes(b'old'); protected=Path(d)/'protected.tsv'
            try: protected.hardlink_to(p)
            except OSError: self.skipTest('hard links unavailable')
            with self.assertRaises(core.ValidationError): core.export_tsv(p,catalog([session()]),[protected])
            self.assertEqual(protected.read_bytes(),b'old')
            protected.unlink()
            real=core.os.fsync
            def race(fd): real(fd); p.write_bytes(b'new external content')
            with patch.object(core.os,'fsync',race):
                with self.assertRaises(core.ConflictError): core.export_tsv(p,catalog([session()]))
            self.assertEqual(p.read_bytes(),b'new external content')
    def test_formula_values_are_rejected_without_writing(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'out.tsv'; p.write_bytes(b'previous')
            for prefix in ('=','+','-','@'):
                for field in ('id','name','folder'):
                    obj=session(); obj[field]=prefix+'unsafe'
                    with self.assertRaises(core.ValidationError): core.export_tsv(p,catalog([obj]))
                    self.assertEqual(p.read_bytes(),b'previous')
    def test_tsv_extra_nonempty_columns_rejected(self):
        header='id\tfolder\tname\thost\tprotocol\tport\n'
        with self.assertRaisesRegex(core.ValidationError,'2행'):
            core.read_tsv(header+'a\tA\tR1\t192.0.2.1\tssh\t22\textra\n',1,True,True)
        self.assertEqual(len(core.read_tsv(header+'a\tA\tR1\t192.0.2.1\tssh\t22\t\t\n',1,True,True)),1)

if __name__=='__main__': unittest.main()
