from pathlib import Path
import sys, tempfile, unittest, subprocess, json, shutil
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import core
ROOT=Path(__file__).resolve().parents[2]
class CtrlArrowRoundtrip(unittest.TestCase):
    def test_publish_load_js_consumer_preserves_word_native_absence_and_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'shared.json'
            for index,mode in enumerate(('native','word',None)):
                p={'id':'p','host':'192.0.2.1','name':'Synthetic','password':'synthetic-only','privateKeyPath':'synthetic-only'}
                if mode is not None:p['ctrlArrowMode']=mode
                cat={'version':1,'sessions':[p]}
                normalized=core.validate_catalog(cat)
                self.assertEqual(normalized['sessions'][0].get('ctrlArrowMode'),mode)
                if mode is None:self.assertNotIn('ctrlArrowMode',normalized['sessions'][0])
                rev=core.load_catalog(path)[1] if path.exists() else None
                core.publish(path,cat,rev)
                loaded,_=core.load_catalog(path)
                self.assertEqual(loaded['sessions'][0].get('ctrlArrowMode'),mode)
                self.assertNotIn('password',loaded['sessions'][0]);self.assertNotIn('privateKeyPath',loaded['sessions'][0])
                script="const path=require('path'),{SharedSessions}=require('./src/lib/shared-sessions.cjs');(async()=>{const shared=new SharedSessions({root:path.join(path.dirname(process.argv[1]),'consumer')});await shared.initialize();if(shared.listSources().length)await shared.refreshSource(shared.listSources()[0].id);else await shared.addSource({name:'synthetic',path:process.argv[1]});const s=shared.listSessions()[0];console.log(JSON.stringify({mode:s.ctrlArrowMode??null,explicit:Object.hasOwn(s,'ctrlArrowMode'),hasPassword:s.hasPassword}));})().catch(e=>{console.error(e.message);process.exitCode=1});"
                node=shutil.which('node'); assert node, 'Node executable required for Python/JS roundtrip'
                r=subprocess.run([node,'-e',script,str(path)],cwd=ROOT,capture_output=True,text=True,timeout=10,check=True)
                got=json.loads(r.stdout);self.assertEqual(got['mode'],mode);self.assertEqual(got['explicit'],mode is not None);self.assertFalse(got['hasPassword'])
                if rev is not None:
                    before=path.read_bytes()
                    with self.assertRaises(core.ConflictError):core.publish(path,cat,'stale')
                    self.assertTrue(path.read_bytes()==before)
    def test_invalid_enum_is_rejected_not_silently_defaulted(self):
        for mode in ('Native',' native','',False,None,1,[],{},'__proto__'):
            with self.subTest(mode=mode):
                with self.assertRaises(core.ValidationError):core.profile({'id':'p','host':'192.0.2.1','ctrlArrowMode':mode})
if __name__=='__main__':unittest.main()
