from pathlib import Path
import builtins
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core


def catalog(name):
    return {'version': 1, 'sessions': [{'id': 'a', 'name': name, 'host': '192.0.2.1',
            'protocol': 'ssh', 'port': 22, 'folder': ''}], 'folders': [], 'snippets': []}


def lock_path(target):
    return target.parent / ('.sessiondock-publish-' + core.sha(target.name.lower().encode()) + '.lock')


class PublishFailureTests(unittest.TestCase):
    def test_faults_preserve_target_and_allow_retry(self):
        for fault in ('marker-open', 'marker-write', 'marker-fsync', 'backup-open',
                      'backup-fsync', 'atomic-fsync', 'replace'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                target = Path(tmp) / 'shared.json'
                revision = core.publish(target, catalog('old'), None)
                original = target.read_bytes()
                real_open, real_fsync = builtins.open, os.fsync
                calls = [0]

                def open_fault(path, *args, **kwargs):
                    if fault == 'marker-open' and Path(path).parent == lock_path(target):
                        raise OSError('marker open')
                    if fault == 'backup-open' and str(path).endswith('.bak.json'):
                        raise OSError('backup open')
                    return real_open(path, *args, **kwargs)

                def fsync_fault(fd):
                    calls[0] += 1
                    if calls[0] == {'marker-fsync': 1, 'backup-fsync': 2, 'atomic-fsync': 3}.get(fault):
                        raise OSError(fault)
                    return real_fsync(fd)

                def partial_write(value, file):
                    file.write('{')
                    raise OSError('marker write')

                with patch('builtins.open', side_effect=open_fault), patch.object(core.os, 'fsync', side_effect=fsync_fault):
                    with patch.object(core.json, 'dump', side_effect=partial_write if fault == 'marker-write' else core.json.dump):
                        with patch.object(core.os, 'replace', side_effect=OSError('replace') if fault == 'replace' else os.replace):
                            with self.assertRaises(OSError):
                                core.publish(target, catalog('new'), revision)
                self.assertEqual(target.read_bytes(), original)
                self.assertFalse(lock_path(target).exists())
                self.assertFalse(list(Path(tmp).glob('.sessiondock-*.tmp')))
                self.assertNotEqual(core.publish(target, catalog('new'), revision), revision)

    def test_replaced_marker_is_not_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'shared.json'
            revision = core.publish(target, catalog('old'), None)
            original = target.read_bytes()
            real_atomic = core._atomic
            def replace_marker(path, data, before_replace=None):
                lock = lock_path(target)
                marker = next(lock.iterdir())
                marker.unlink()
                marker.write_text('foreign', encoding='utf-8')
                return real_atomic(path, data, before_replace)
            with patch.object(core, '_atomic', side_effect=replace_marker):
                with self.assertRaises(core.ConflictError):
                    core.publish(target, catalog('new'), revision)
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(next(lock_path(target).iterdir()).read_text(), 'foreign')

    def test_marker_replaced_during_failed_write_is_not_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'shared.json'
            revision = core.publish(target, catalog('old'), None)
            original = target.read_bytes()
            def replace_and_fail(value, file):
                file.write('{')
                file.flush()
                marker = Path(file.name)
                file.close()
                marker.rename(marker.with_suffix('.displaced'))
                marker.write_text('foreign', encoding='utf-8')
                raise OSError('marker write')
            with patch.object(core.json, 'dump', side_effect=replace_and_fail):
                with self.assertRaises(OSError):
                    core.publish(target, catalog('new'), revision)
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(next(lock_path(target).glob('*.json')).read_text(), 'foreign')

    def test_replaced_lock_is_not_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'shared.json'
            revision = core.publish(target, catalog('old'), None)
            original = target.read_bytes()
            real_atomic = core._atomic
            def replace_lock(path, data, before_replace=None):
                lock = lock_path(target)
                lock.rename(Path(tmp) / 'displaced')
                lock.mkdir()
                (lock / 'foreign.json').write_text('foreign', encoding='utf-8')
                return real_atomic(path, data, before_replace)
            with patch.object(core, '_atomic', side_effect=replace_lock):
                with self.assertRaises((core.ConflictError, FileNotFoundError)):
                    core.publish(target, catalog('new'), revision)
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual((lock_path(target) / 'foreign.json').read_text(), 'foreign')


if __name__ == '__main__':
    unittest.main()
