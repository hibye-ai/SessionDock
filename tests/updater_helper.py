import importlib.util
import json
import os
import struct
import tempfile
import unittest
import zipfile
import atexit
import shutil
import subprocess
from pathlib import Path
from unittest import mock

# Isolated copy of the unsigned helper; no key generation or trust file.
_trust = tempfile.TemporaryDirectory(prefix='updater-test-trust-')
atexit.register(_trust.cleanup)
_helper_path = Path(_trust.name, 'update_helper.py')
shutil.copyfile(Path(__file__).resolve().parents[1] / 'assets/automation/update_helper.py', _helper_path)

# Unsigned fixture: no trust or key provisioning.
SPEC = importlib.util.spec_from_file_location('update_helper', _helper_path)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def make_asar(version):
    package = json.dumps({'name': 'sessiondock', 'version': version, 'main': 'main.js'}).encode()
    head = json.dumps({'files': {'package.json': {'size': len(package), 'offset': '0'}, 'main.js': {'size': 1, 'offset': str(len(package))}}}, separators=(',', ':')).encode()
    size = (4 + len(head) + 3) & ~3
    return struct.pack('<IIII', 4, size + 4, size, len(head)) + head + bytes(size - 4 - len(head)) + package + b'x'


def make_zip(file, version='0.1.4', extras=()):
    with zipfile.ZipFile(file, 'w') as z:
        for name, data in [('SessionDock.exe', b'executable'), ('resources/app.asar', make_asar(version)),
                           ('resources/python-runtime/python.exe', b'python'), ('resources/automation/python_bridge.py', b'bridge'),
                           ('resources.pak', b'pak'), ('icudtl.dat', b'icu'), *extras]:
            z.writestr(name, data)


def write_release_manifest(file, version='0.1.4'):
    if Path(file).name != 'SessionDock.zip': raise ValueError('Fixture must use canonical ZIP name')
    # Historical fixture hook: single-ZIP tests deliberately create no sidecar.
    assert Path(file).is_file()


def make_release_zip(file, version='0.1.4', extras=()):
    make_zip(file, version, extras)
    write_release_manifest(file, version)


class UpdateHelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name

    def test_scan_versions_and_names(self):
        for name in ('SessionDock-0.1.4.zip', 'SessionDock-0.1.40.zip', 'SessionDock-01.1.999.zip', 'SessionDock-0.1.999.zip.bak', 'SessionDock-Admin.zip'):
            open(os.path.join(self.root, name), 'wb').close()
        make_zip(os.path.join(self.root, 'SessionDock-0.1.4.zip'))
        make_zip(os.path.join(self.root, 'SessionDock-0.1.40.zip'), '0.1.40')
        self.assertIsNone(helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})['candidate'])
        make_release_zip(os.path.join(self.root, 'SessionDock.zip'), '0.1.40')
        result = helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})
        self.assertEqual(result['candidate']['version'], '0.1.40')

    def test_fixed_metadata_mixed_versions_and_stage_replacement(self):
        fixed = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(fixed, '0.1.4')
        make_zip(os.path.join(self.root, 'SessionDock-0.1.6.zip'), '0.1.5')
        make_zip(os.path.join(self.root, 'SessionDock-0.1.5.zip'), '0.1.5')
        result = helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})
        self.assertEqual(result['candidate'], {'name': 'SessionDock.zip', 'version': '0.1.4', 'buildID': 'sha256-' + helper.digest(fixed)})
        os.unlink(os.path.join(self.root, 'SessionDock-0.1.5.zip'))
        self.assertEqual(helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})['candidate']['version'], '0.1.4')
        self.assertIsNone(helper.scan({'folder': self.root, 'currentVersion': '0.1.4'})['candidate'])
        make_release_zip(fixed, '0.1.5')
        with self.assertRaises(ValueError):
            helper.stage({'folder': self.root, 'name': 'SessionDock.zip', 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'replaced')})

    def test_scan_rejects_bad_metadata_and_archive_paths(self):
        fixed = os.path.join(self.root, 'SessionDock.zip')
        for extras in [[('../bad', b'x')], [('resources/app.asar', make_asar('0.1.4'))]]:
            with self.subTest(extras=extras):
                make_release_zip(fixed, extras=extras)
                with self.assertRaisesRegex(ValueError, 'ZIP 경로'):
                    helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})
        bad = make_asar('0.1.4').replace(b'sessiondock', b'x' * len(b'sessiondock'))
        with zipfile.ZipFile(fixed, 'w') as z: z.writestr('resources/app.asar', bad)
        write_release_manifest(fixed)
        with self.assertRaisesRegex(ValueError, '제품 또는 버전'):
            helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})

    def test_scan_and_stage_reject_raw_nul_name_and_duplicate_json(self):
        fixed = os.path.join(self.root, 'SessionDock.zip')
        make_zip(fixed, extras=[('maliciousXXname', b'x')])
        with open(fixed, 'rb') as f: data = f.read()
        data = data.replace(b'maliciousXXname', b'malicious\x00Xname')
        with open(fixed, 'wb') as f: f.write(data)
        write_release_manifest(fixed)
        with self.assertRaisesRegex(ValueError, 'ZIP 경로'):
            helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})
        with self.assertRaisesRegex(ValueError, 'ZIP 경로'): helper.stage({'folder': self.root, 'name': 'SessionDock.zip', 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'nul-stage')})
        for content in (b'{"name":"sessiondock","name":"sessiondock","version":"0.1.4","main":"main.js"}', b'[]'):
            head = json.dumps({'files': {'package.json': {'size': len(content), 'offset': '0'}, 'main.js': {'size': 1, 'offset': str(len(content))}}}, separators=(',', ':')).encode()
            size = (4 + len(head) + 3) & ~3
            asar = struct.pack('<IIII', 4, size + 4, size, len(head)) + head + bytes(size - 4 - len(head)) + content + b'x'
            with zipfile.ZipFile(fixed, 'w') as z: z.writestr('resources/app.asar', asar)
            write_release_manifest(fixed)
            with self.assertRaisesRegex(ValueError, 'JSON|ASAR'):
                helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})

    def test_invalid_signed_asar_node_cannot_fall_back_to_unsigned_candidate(self):
        fixed = os.path.join(self.root, 'SessionDock.zip')
        head = b'{"files":[]}'
        size = (4 + len(head) + 3) & ~3
        asar = struct.pack('<IIII', 4, size + 4, size, len(head)) + head + bytes(size - 4 - len(head))
        with zipfile.ZipFile(fixed, 'w') as z: z.writestr('resources/app.asar', asar)
        write_release_manifest(fixed)
        make_zip(os.path.join(self.root, 'SessionDock-0.1.4.zip'))
        with self.assertRaisesRegex(ValueError, 'ASAR'):
            helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})
        make_release_zip(fixed)
        self.assertEqual(helper.scan({'folder': self.root, 'currentVersion': '0.1.3'})['candidate']['version'], '0.1.4')

    def test_stage_and_version_mismatch(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file)
        result = helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')})
        self.assertEqual(result['version'], '0.1.4')
        self.assertEqual(len(result['files']), 6)
        make_release_zip(file, version='0.1.5')
        with self.assertRaises(ValueError):
            helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'bad')})

    def test_windows_release_identity_ignores_ctime_but_binds_file_id_size_and_mtime(self):
        from types import SimpleNamespace
        import time
        file = Path(self.root, 'identity.bin')
        file.write_bytes(b'first')
        time.sleep(.02)
        file.write_bytes(b'stable release')
        before = os.lstat(file)
        with open(file, 'rb') as stream: opened = os.fstat(stream.fileno())
        # Windows lstat ctime is creation time; fstat ctime is change time.
        self.assertNotEqual(before.st_ctime_ns, opened.st_ctime_ns)
        with helper.release_file(str(file)) as stream:
            self.assertEqual(stream.read(), b'stable release')
        real_fstat = helper.os.fstat
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        for field in fields[:-1]:
            def changed(fd, field=field):
                current = real_fstat(fd)
                values = {key: getattr(current, key) for key in fields}
                values[field] += 1
                return SimpleNamespace(**values)
            with self.subTest(field=field), mock.patch.object(helper.os, 'fstat', side_effect=changed):
                with self.assertRaisesRegex(ValueError, 'Release changed before opening'):
                    with helper.release_file(str(file)): pass
        with __import__('contextlib').ExitStack() as stack:
            with self.assertRaisesRegex(ValueError, 'Release changed during verification'):
                with helper.release_file(str(file)):
                    values = {key: getattr(before, key) for key in fields}
                    values['st_ino'] += 1
                    stack.enter_context(mock.patch.object(helper.os, 'lstat', return_value=SimpleNamespace(**values)))

    def test_stage_reports_real_bytes_and_failed_validation_has_no_success(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file, extras=[('large.bin', os.urandom(2200000))])
        events = []
        helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'progress')}, lambda *e: events.append(e))
        for phase in ('copy', 'verify', 'extract'):
            phase_events = [e for e in events if e[0] == phase]
            self.assertEqual(phase_events[0][1], 0)
            self.assertEqual(phase_events[-1][1], phase_events[-1][2])
            self.assertTrue(all(e[3] == 'bytes' and 0 <= e[1] <= e[2] for e in phase_events))
        extracted = [e[1] for e in events if e[0] == 'extract']
        self.assertTrue(any(0 < n < extracted[-1] for n in extracted))
        events.clear()
        make_release_zip(file, version='0.1.5')
        with self.assertRaises(ValueError):
            helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'failed')}, lambda *e: events.append(e))
        self.assertNotIn('success', [e[0] for e in events])

    def test_display_exceptions_do_not_interrupt_install_progress(self):
        old = helper._install_observer
        self.addCleanup(setattr, helper, '_install_observer', old)
        def broken(*args): raise RuntimeError('display unavailable')
        helper._install_observer = broken
        helper.install_progress('rollback')

    @unittest.skipUnless(os.name == 'nt', 'Windows native window')
    def test_hidden_native_window_thread_accepts_progress_and_close(self):
        ui = helper.NativeProgress(hidden=True)
        self.assertTrue(ui.ready.wait(5))
        self.assertIsNotNone(ui.hwnd)
        ui.update('apply', 1, 3)
        ui.update('rollback')
        ui.close()
        ui.thread.join(5)
        self.assertFalse(ui.thread.is_alive())

    @unittest.skipUnless(os.name == 'nt', 'Windows native window')
    def test_multiple_hidden_windows_and_repeated_cleanup(self):
        for themes in [('light', 'dark'), ('invalid', 'light'), ('dark', 'light')]:
            windows = [helper.NativeProgress(hidden=True, theme=theme) for theme in themes]
            try:
                for ui, theme in zip(windows, themes):
                    self.assertTrue(ui.ready.wait(5))
                    self.assertIsNotNone(ui.hwnd, ui.error)
                    self.assertEqual(ui.theme, theme if theme in ('dark', 'light') else 'dark')
                    ui.update('failed', '한글 경로 ' * 100)
            finally:
                for ui in windows: ui.close()
                for ui in windows:
                    ui.thread.join(5)
                    self.assertFalse(ui.thread.is_alive())
                    self.assertIsNone(ui.hwnd)

    def test_owned_cleanup_rejects_unmarked_wrong_token_protected_and_reparse(self):
        root = tempfile.mkdtemp(prefix='sessiondock-update-', dir=tempfile.gettempdir())
        self.addCleanup(lambda: __import__('shutil').rmtree(root, ignore_errors=True))
        marker = os.path.join(root, '.sessiondock-update-owner.json')
        token = 'a' * 64
        install, user = os.path.join(tempfile.gettempdir(), 'unrelated-install'), os.path.join(tempfile.gettempdir(), 'unrelated-user')
        with self.assertRaises((OSError, ValueError)): helper.validate_owned_root(root, token, install, user)
        with open(marker, 'w', encoding='utf-8') as f: json.dump({'token': token}, f)
        with self.assertRaises(ValueError): helper.validate_owned_root(root, 'b' * 64, install, user)
        with self.assertRaises(ValueError): helper.validate_owned_root(root, token, root, user)
        os.mkdir(os.path.join(root, 'payload'))
        with mock.patch.object(helper, 'reject_reparse', side_effect=ValueError('reparse')):
            with self.assertRaises(ValueError): helper.cleanup_owned_root({'root': root, 'token': token, 'installDir': install, 'userDataDir': user, 'helperPid': 1})
        self.assertTrue(os.path.exists(root))
        with mock.patch.object(helper.os, 'name', 'posix'):
            helper.cleanup_owned_root({'root': root, 'token': token, 'installDir': install, 'userDataDir': user, 'helperPid': 1})
        self.assertFalse(os.path.exists(root))

    @unittest.skipUnless(os.name == 'nt', 'Windows cleanup worker')
    def test_installed_pythonw_cleanup_waits_and_removes_only_owned_root(self):
        import shutil, subprocess, sys, time
        root = tempfile.mkdtemp(prefix='sessiondock-update-', dir=tempfile.gettempdir())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        install, user = os.path.join(self.root, '설치 & 앱'), os.path.join(self.root, '사용자')
        automation = os.path.join(install, 'resources', 'automation')
        os.makedirs(automation); os.makedirs(user)
        script = os.path.join(automation, 'update_helper.py')
        shutil.copyfile(helper.__file__, script)
        token = 'a' * 64
        with open(os.path.join(root, '.sessiondock-update-owner.json'), 'w', encoding='utf-8') as f: json.dump({'token': token}, f)
        with open(os.path.join(root, 'payload'), 'w') as f: f.write('owned')
        owner = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(.5)'], creationflags=subprocess.CREATE_NO_WINDOW)
        request = {'root': root, 'token': token, 'installDir': install, 'userDataDir': user, 'helperPid': owner.pid}
        pending = os.path.join(user, 'update-cleanup-pending.json')
        with open(pending, 'w', encoding='utf-8') as f: json.dump(request, f)
        pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
        worker = subprocess.Popen([pythonw, '-I', '-S', script, 'cleanup'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        worker.stdin.write(json.dumps(request, ensure_ascii=False).encode('utf-8')); worker.stdin.close()
        time.sleep(.1); self.assertTrue(os.path.isdir(root))
        owner.wait(5); self.assertEqual(worker.wait(10), 0)
        self.assertFalse(os.path.exists(root)); self.assertFalse(os.path.exists(pending)); self.assertTrue(os.path.isdir(install))
        with open(pending, 'w', encoding='utf-8') as f: json.dump({**request, 'cleanupError':'prior failure'}, f)
        worker = subprocess.Popen([pythonw, '-I', '-S', script, 'cleanup'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        worker.stdin.write(json.dumps({**request, 'cleanupError':'prior failure'}, ensure_ascii=False).encode('utf-8')); worker.stdin.close()
        self.assertEqual(worker.wait(10), 0); self.assertFalse(os.path.exists(pending))

    def test_install_ui_is_ready_before_parent_exit_and_approval(self):
        from ctypes import wintypes
        class Kernel:
            def WaitForSingleObject(self, *args): return 0
            def GetExitCodeProcess(self, parent, code):
                code._obj.value = 0
                return 1
            def CloseHandle(self, handle): pass
        plan = {'version': '0.1.4', 'stageDir': os.path.join(self.root, 'stage'),
                'archiveSha256': 'a' * 64, 'files': {}, 'installDir': os.path.join(self.root, 'app'),
                'userDataDir': os.path.join(self.root, 'user'), 'parentPid': 123,
                'approvalToken': 'b' * 64, 'approvalPath': os.path.join(self.root, 'approval'),
                'resultPath': os.path.join(self.root, 'result'), 'profileArg': ''}
        file = os.path.join(self.root, 'SessionDock.zip'); make_release_zip(file)
        plan.update(helper.stage({'folder': self.root, 'name': 'SessionDock.zip', 'expectedVersion': '0.1.4', 'stageDir': plan['stageDir']}))
        calls = []
        class BrokenUI:
            def update(self, *args):
                calls.append(args[0])
                raise RuntimeError('display failed')
        def factory():
            calls.append('factory')
            return BrokenUI()
        patches = [mock.patch.object(helper, '_install_ready', False), mock.patch.object(helper, 'windows_context', return_value=(Kernel(), 1, 2)),
                   mock.patch.object(helper, 'ensure_no_other_process'),
                   mock.patch.object(helper, 'apply_files', return_value=(self.root, [])),
                   mock.patch.object(helper, 'write_result'), mock.patch.object(helper.subprocess, 'Popen')]
        for patcher in patches:
            patcher.start(); self.addCleanup(patcher.stop)
        with open(plan['approvalPath'], 'w', encoding='utf-8') as f:
            json.dump({'token': 'wrong', 'graceful': True}, f)
        with self.assertRaises(ValueError): helper.install(plan, factory)
        self.assertEqual(calls, ['factory', 'waiting', 'failed'])
        calls.clear()
        with open(plan['approvalPath'], 'w', encoding='utf-8') as f:
            json.dump({'token': plan['approvalToken'], 'graceful': True}, f)
        helper.install(plan, factory)
        self.assertEqual(calls, ['factory', 'waiting', 'validate', 'restart', 'success'])

    def test_install_reports_rollback_then_failure_without_success(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file)
        staged = helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')})
        install = os.path.join(self.root, 'installed'); os.mkdir(install)
        events = []
        old = helper._install_observer
        self.addCleanup(setattr, helper, '_install_observer', old)
        helper._install_observer = lambda *e: events.append(e)
        with mock.patch.object(helper, 'preflight'), mock.patch.object(helper, 'publish_file', side_effect=OSError('fault')):
            with self.assertRaises(RuntimeError): helper.apply_files({**staged, 'installDir': install})
        self.assertIn('rollback', [e[0] for e in events])
        self.assertNotIn('success', [e[0] for e in events])

    def test_restart_receipt_controls_success_cleanup_and_timeout_preserves_backup(self):
        class Kernel:
            def WaitForSingleObject(self, *args): return 0
            def GetExitCodeProcess(self, parent, code): code._obj.value = 0; return 1
            def CloseHandle(self, handle): pass
        root = self.root
        plan = {'version': '0.1.4', 'stageDir': os.path.join(root, 'stage'), 'archiveSha256': 'a'*64, 'files': {},
                'installDir': os.path.join(root, 'app'), 'userDataDir': os.path.join(root, 'user'), 'parentPid': 123,
                'approvalToken': 'b'*64, 'approvalPath': os.path.join(root, 'approval'), 'resultPath': os.path.join(root, 'result'),
                'profileArg': '', 'restartReceipt': {'root': root, 'token': 'c'*64}}
        file = os.path.join(root, 'SessionDock.zip'); make_release_zip(file)
        plan.update(helper.stage({'folder': root, 'name': 'SessionDock.zip', 'expectedVersion': '0.1.4', 'stageDir': plan['stageDir']}))
        with open(plan['approvalPath'], 'w', encoding='utf-8') as f: json.dump({'token': plan['approvalToken'], 'graceful': True}, f)
        child = mock.Mock(pid=456); child.poll.return_value = None
        def launch(*args, **kwargs):
            with open(os.path.join(root, 'restart-receipt.json'), 'w', encoding='utf-8') as f:
                json.dump({'token': 'c'*64, 'pid': 456, 'version': '0.1.4'}, f)
            return child
        patches = [mock.patch.object(helper, 'windows_context', return_value=(Kernel(), 1, 2)),
                   mock.patch.object(helper, 'ensure_no_other_process'), mock.patch.object(helper, 'validate_owned_root'),
                   mock.patch.object(helper, 'apply_files', return_value=(os.path.join(root, 'backup'), [('file', 'old')])),
                   mock.patch.object(helper, 'write_result'), mock.patch.object(helper, 'schedule_cleanup'),
                   mock.patch.object(helper, 'rollback'), mock.patch.object(helper.subprocess, 'Popen', side_effect=launch)]
        # apply_files is mocked, so model its durable pending transaction too.
        pending_patch = mock.patch.object(helper, 'read_pending', return_value=({'backupDir': os.path.join(root, 'backup')}, b'pending'))
        clear_patch = mock.patch.object(helper, 'clear_pending')
        pending_patch.start(); self.addCleanup(pending_patch.stop)
        clear_patch.start(); self.addCleanup(clear_patch.stop)
        with __import__('contextlib').ExitStack() as stack:
            mocks = [stack.enter_context(p) for p in patches]
            helper.install(plan, lambda: mock.Mock())
            mocks[5].assert_called_once()
            mocks[6].assert_not_called()
        os.unlink(os.path.join(root, 'restart-receipt.json'))
        with __import__('contextlib').ExitStack() as stack:
            mocks = [stack.enter_context(p) for p in patches]
            mocks[4].side_effect = OSError('result write fault')
            ui = mock.Mock()
            helper.install(plan, lambda: ui)
            mocks[5].assert_not_called()
            mocks[6].assert_not_called()
            self.assertTrue(any(call.args[0] == 'failed' and 'result write fault' in call.args[1]
                                for call in ui.update.call_args_list))
        os.unlink(os.path.join(root, 'restart-receipt.json'))
        with __import__('contextlib').ExitStack() as stack:
            mocks = [stack.enter_context(p) for p in patches]
            mocks[5].side_effect = OSError('cleanup fault')
            helper.install(plan, lambda: mock.Mock())
            self.assertTrue(mocks[4].call_args.args[1]['ok'])
            self.assertIn('cleanup fault', mocks[4].call_args.args[1]['cleanupError'])
        os.unlink(os.path.join(root, 'restart-receipt.json'))
        child.poll.return_value = 1
        patches[-1] = mock.patch.object(helper.subprocess, 'Popen', return_value=child)
        with __import__('contextlib').ExitStack() as stack:
            mocks = [stack.enter_context(p) for p in patches]
            with self.assertRaisesRegex(RuntimeError, '직후 종료'): helper.install(plan, lambda: mock.Mock())
            mocks[5].assert_not_called()
            mocks[6].assert_not_called()
            self.assertIn('backup', mocks[4].call_args.args[1]['backupDir'])
        for changed in ({'token':'d'*64}, {'pid':457}, {'version':'0.1.5'}):
            with self.subTest(changed=changed):
                def bad_launch(*args, **kwargs):
                    with open(os.path.join(root, 'restart-receipt.json'), 'w', encoding='utf-8') as f:
                        json.dump({**{'token':'c'*64, 'pid':456, 'version':'0.1.4'}, **changed}, f)
                    return child
                child.poll.return_value = None
                patches[-1] = mock.patch.object(helper.subprocess, 'Popen', side_effect=bad_launch)
                with __import__('contextlib').ExitStack() as stack:
                    mocks = [stack.enter_context(p) for p in patches]
                    stack.enter_context(mock.patch.object(helper.time, 'monotonic', side_effect=__import__('itertools').count(step=61)))
                    with self.assertRaisesRegex(RuntimeError, '확인 시간이 초과'): helper.install(plan, lambda: mock.Mock())
                    mocks[5].assert_not_called(); mocks[6].assert_not_called()
                os.unlink(os.path.join(root, 'restart-receipt.json'))
        patches[-1] = mock.patch.object(helper.subprocess, 'Popen', side_effect=OSError('launch fault'))
        with __import__('contextlib').ExitStack() as stack:
            mocks = [stack.enter_context(p) for p in patches]
            mocks[6].return_value = []
            with self.assertRaisesRegex(RuntimeError, '재시작 실패'): helper.install(plan, lambda: mock.Mock())
            mocks[6].assert_called_once()

    @unittest.skipUnless(os.name == 'nt', 'Windows hidden restart fixture')
    def test_hidden_pythonw_restart_receipts_and_exit(self):
        import subprocess, sys
        pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
        root = os.path.join(self.root, '한글 & 경로'); os.mkdir(root)
        receipt = {'root': root, 'token': 'a'*64}
        script = os.path.join(root, 'fixture.py')
        with open(script, 'w', encoding='utf-8') as f:
            f.write('import sys,os,json,time\np,t,v,mode=sys.argv[1:]\nif mode != "exit":\n with open(p,"w",encoding="utf-8") as out: json.dump({"token":t if mode != "token" else "b"*64,"pid":os.getpid() if mode != "pid" else 1,"version":v if mode != "version" else "0.1.5"},out)\ntime.sleep(2 if mode != "exit" else 0)\n')
        target = os.path.join(root, 'restart-receipt.json')
        for mode, expected in [('valid','confirmed'), ('token','timeout'), ('pid','timeout'), ('version','timeout'), ('exit','exited')]:
            with self.subTest(mode=mode):
                try: os.unlink(target)
                except FileNotFoundError: pass
                child = subprocess.Popen([pythonw, '-I', '-S', script, target, receipt['token'], '0.1.4', mode], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try: self.assertEqual(helper.wait_for_restart(child, receipt, '0.1.4', timeout=.6), expected)
                finally:
                    if child.poll() is None: child.terminate()
                    child.wait(5)

    def test_valid_restart_receipt_requires_living_child_before_and_after_read(self):
        receipt = {'root': self.root, 'token': 'a' * 64}
        with open(os.path.join(self.root, 'restart-receipt.json'), 'w', encoding='utf-8') as f:
            json.dump({'token': receipt['token'], 'pid': 456, 'version': '0.1.4'}, f)
        for statuses in ([1], [None, 1]):
            child = mock.Mock(pid=456); child.poll.side_effect = statuses
            self.assertEqual(helper.wait_for_restart(child, receipt, '0.1.4'), 'exited')

    def test_malicious_paths_and_collisions(self):
        for index, extra in enumerate([('../outside', b'x'), ('a/CON.txt', b'x'), ('a/x:stream', b'x'), ('A/file', b'x'), ('a/FILE', b'x')]):
            file = os.path.join(self.root, 'SessionDock.zip')
            extras = [('a/file', b'x'), extra] if index >= 3 else [extra]
            make_release_zip(file, extras=extras)
            with self.assertRaises((ValueError, FileExistsError)):
                helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'bad' + str(index))})
        self.assertFalse(os.path.exists(os.path.join(self.root, 'outside')))

    def test_prefix_collision_link_and_missing_main_rejected(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file, extras=[('Dir/a', b'a'), ('dir/b', b'b')])
        with self.assertRaises(ValueError):
            helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'prefix')})
        make_release_zip(file)
        with zipfile.ZipFile(file, 'a') as z:
            link = zipfile.ZipInfo('link'); link.create_system = 3; link.external_attr = (0o120777 << 16)
            z.writestr(link, 'elsewhere')
        write_release_manifest(file)
        with self.assertRaisesRegex(ValueError, '링크'):
            helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'link')})
        asar = os.path.join(self.root, 'missing.asar')
        data = make_asar('0.1.4')
        Path(asar).write_bytes(data.replace(b'main.js', b'lost.js', 1))
        with self.assertRaises((ValueError, KeyError)):
            helper.validate_asar(asar, '0.1.4')

    def test_partial_and_unrelated_archive(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        with open(file, 'wb') as out:
            out.write(b'incomplete')
        write_release_manifest(file)
        with self.assertRaises((zipfile.BadZipFile, ValueError)):
            helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'bad')})
        with zipfile.ZipFile(file, 'w') as z:
            z.writestr('unrelated.txt', b'data')
        write_release_manifest(file)
        with self.assertRaises(ValueError):
            helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'unrelated')})

    def test_apply_and_rollback_preserve_user_files(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file)
        staged = helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')})
        install = os.path.join(self.root, 'installed')
        os.mkdir(install)
        with open(os.path.join(install, 'SessionDock.exe'), 'wb') as f: f.write(b'old exe')
        with open(os.path.join(install, 'user-sessions.json'), 'wb') as f: f.write(b'private sessions')
        plan = {**staged, 'installDir': install}
        backup, journal = helper.apply_files(plan)
        self.assertEqual(Path(install, 'SessionDock.exe').read_bytes(), b'executable')
        self.assertEqual(Path(install, 'user-sessions.json').read_bytes(), b'private sessions')
        self.assertEqual(helper.rollback(journal), [])
        self.assertEqual(Path(install, 'SessionDock.exe').read_bytes(), b'old exe')
        self.assertEqual(Path(install, 'user-sessions.json').read_bytes(), b'private sessions')
        self.assertTrue(os.path.isfile(os.path.join(backup, 'SessionDock.exe')))
        self.assertEqual(json.loads(Path(backup, 'journal.jsonl').read_text(encoding='utf-8').splitlines()[-1])['state'], 'complete')

    def test_apply_progress_counts_metadata_after_product_files(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file)
        staged = helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')})
        install = os.path.join(self.root, 'installed'); os.mkdir(install)
        events = []
        original = helper.install_progress
        def observe(*args):
            events.append(args)
            return original(*args)
        with mock.patch.object(helper, 'install_progress', side_effect=observe):
            helper.apply_files({**staged, 'installDir': install})
        apply = [e for e in events if e[0] == 'apply']
        total = len(staged['files']) + 2
        self.assertEqual([e[1] for e in apply], list(range(total + 1)))
        self.assertTrue(all(e[2] == total for e in apply))
        self.assertEqual([e[0] for e in events if e[0] in ('backup', 'replace')], [])

    def test_apply_failure_does_not_report_completed_metadata(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file)
        staged = helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')})
        install = os.path.join(self.root, 'installed'); os.mkdir(install)
        events = []
        original = helper.publish_file
        def fail_inventory(source, target, expected):
            if target.endswith(helper.OWNERSHIP_FILE): raise OSError('metadata failure')
            return original(source, target, expected)
        with mock.patch.object(helper, 'install_progress', side_effect=lambda *e: events.append(e)), mock.patch.object(helper, 'publish_file', side_effect=fail_inventory):
            with self.assertRaises(RuntimeError): helper.apply_files({**staged, 'installDir': install})
        apply = [e for e in events if e[0] == 'apply']
        self.assertEqual(apply[-1][1], len(staged['files']) + 1)
        self.assertEqual(apply[-1][2], len(staged['files']) + 2)
        self.assertEqual(events[-1][0], 'rollback')

    def test_apply_failure_rolls_back_and_unknown_conflicts_fail(self):
        file = os.path.join(self.root, 'SessionDock.zip')
        make_release_zip(file, extras=[('user.txt', b'new')])
        staged = helper.stage({'folder': self.root, 'name': os.path.basename(file), 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')})
        install = os.path.join(self.root, 'installed'); os.mkdir(install)
        with open(os.path.join(install, 'SessionDock.exe'), 'wb') as f: f.write(b'old')
        with open(os.path.join(install, 'user.txt'), 'wb') as f: f.write(b'user')
        plan = {**staged, 'installDir': install}
        with self.assertRaisesRegex(ValueError, '사용자 파일'): helper.apply_files(plan)
        self.assertEqual(Path(install, 'SessionDock.exe').read_bytes(), b'old')
        os.unlink(os.path.join(install, 'user.txt'))
        original = helper.publish_file
        def fail_on_pak(source, target, expected):
            if target.endswith('resources.pak'): raise OSError('injected failure')
            return original(source, target, expected)
        with mock.patch.object(helper, 'publish_file', side_effect=fail_on_pak):
            with self.assertRaisesRegex(RuntimeError, 'injected'): helper.apply_files(plan)
        self.assertEqual(Path(install, 'SessionDock.exe').read_bytes(), b'old')
        self.assertFalse(os.path.exists(os.path.join(install, 'resources', 'app.asar')))

    def test_inventory_across_versions_protects_changes_and_rolls_back_record_failure(self):
        install = os.path.join(self.root, 'installed'); os.mkdir(install)
        def prepare(version, content, index):
            name = 'SessionDock.zip'
            make_release_zip(os.path.join(self.root, name), version, [('resources/automation/new-product-helper.py', content)])
            return {**helper.stage({'folder': self.root, 'name': name, 'expectedVersion': version, 'stageDir': os.path.join(self.root, 'stage' + str(index))}), 'installDir': install}
        first = prepare('0.1.4', b'first', 1)
        helper.apply_files(first)
        target = Path(install, 'resources/automation/new-product-helper.py')
        record = Path(install, helper.OWNERSHIP_FILE)
        key = Path(install, helper.OWNERSHIP_KEY)
        before_record, before_key = record.read_bytes(), key.read_bytes()
        second = prepare('0.1.5', b'second', 2)
        target.write_bytes(b'user changed')
        with self.assertRaisesRegex(ValueError, '변경'): helper.apply_files(second)
        self.assertEqual(target.read_bytes(), b'user changed')
        target.write_bytes(b'first')
        original = helper.os.replace
        def fail_record(source, dest):
            if dest == str(record): raise OSError('inventory write failure')
            return original(source, dest)
        with mock.patch.object(helper.os, 'replace', side_effect=fail_record):
            with self.assertRaisesRegex(RuntimeError, 'inventory write failure'): helper.apply_files(second)
        self.assertEqual(target.read_bytes(), b'first')
        self.assertEqual(Path(install, 'resources/app.asar').read_bytes(), make_asar('0.1.4'))
        self.assertEqual(record.read_bytes(), before_record)
        self.assertEqual(key.read_bytes(), before_key)
        helper.apply_files(second)
        self.assertEqual(target.read_bytes(), b'second')
        self.assertNotEqual(record.read_bytes(), before_record)

    def test_inventory_tampering_and_unknown_file_fail_closed(self):
        install = os.path.join(self.root, 'installed'); os.mkdir(install)
        name = 'SessionDock.zip'
        make_release_zip(os.path.join(self.root, name), extras=[('resources/automation/new-product-helper.py', b'product')])
        plan = {**helper.stage({'folder': self.root, 'name': name, 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')}), 'installDir': install}
        target = Path(install, 'resources/automation/new-product-helper.py')
        target.parent.mkdir(parents=True); target.write_bytes(b'user')
        with self.assertRaisesRegex(ValueError, '사용자 파일'): helper.apply_files(plan)
        self.assertEqual(target.read_bytes(), b'user')
        target.unlink(); helper.apply_files(plan)
        record = Path(install, helper.OWNERSHIP_FILE)
        data = json.loads(record.read_text(encoding='utf-8'))
        data['files']['resources/automation/new-product-helper.py'] = '0' * 64
        record.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '기록'): helper.apply_files(plan)
        self.assertEqual(target.read_bytes(), b'product')
        record.unlink()
        with self.assertRaisesRegex(ValueError, '기록'): helper.apply_files(plan)

    def test_new_inventory_write_failure_removes_record_and_restores_product(self):
        install = os.path.join(self.root, 'installed'); os.mkdir(install)
        Path(install, 'SessionDock.exe').write_bytes(b'old')
        name = 'SessionDock.zip'; make_release_zip(os.path.join(self.root, name))
        plan = {**helper.stage({'folder': self.root, 'name': name, 'expectedVersion': '0.1.4', 'stageDir': os.path.join(self.root, 'stage')}), 'installDir': install}
        original = helper.publish_file
        def fail_record(source, target, expected):
            if target == os.path.join(install, helper.OWNERSHIP_FILE): raise OSError('record failure')
            return original(source, target, expected)
        with mock.patch.object(helper, 'publish_file', side_effect=fail_record):
            with self.assertRaisesRegex(RuntimeError, 'record failure'): helper.apply_files(plan)
        self.assertEqual(Path(install, 'SessionDock.exe').read_bytes(), b'old')
        self.assertFalse(Path(install, helper.OWNERSHIP_FILE).exists())
        self.assertFalse(Path(install, helper.OWNERSHIP_KEY).exists())


if __name__ == '__main__':
    unittest.main()
