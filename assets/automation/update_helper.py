"""Isolated, bounded SessionDock update discovery and archive inspection."""
import contextlib
import ctypes
import hashlib
import hmac
import json
import os
import re
import shutil
import stat
import struct
import sys
import zipfile
import subprocess
import time
import tempfile
import threading
from typing import NoReturn

NAME = re.compile(r'^SessionDock-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.zip$')
DEVICE = re.compile(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$', re.I)
# Product inventory from the 0.1.3 release; unknown existing files are protected.
BASELINE_FILES = frozenset(['SessionDock.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'locales/en-US.pak', 'locales/ko.pak', 'resources.pak', 'resources/app.asar', 'resources/app.asar.unpacked/node_modules/ssh2/LICENSE', 'resources/app.asar.unpacked/node_modules/ssh2/lib/Channel.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/agent.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/client.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/http-agents.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/index.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/keygen.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/Protocol.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/SFTP.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/constants.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/crypto.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/crypto/poly1305.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/handlers.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/handlers.misc.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/kex.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/keyParser.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/node-fs-compat.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/utils.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/zlib.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/server.js', 'resources/app.asar.unpacked/node_modules/ssh2/lib/utils.js', 'resources/app.asar.unpacked/node_modules/ssh2/package.json', 'resources/app.asar.unpacked/node_modules/ssh2/util/pagent.exe', 'resources/automation/python_bridge.py', 'resources/licenses/LICENSE.electron.txt', 'resources/licenses/LICENSES.chromium.html', 'resources/python-runtime/LICENSE.txt', 'resources/python-runtime/_asyncio.pyd', 'resources/python-runtime/_bz2.pyd', 'resources/python-runtime/_ctypes.pyd', 'resources/python-runtime/_decimal.pyd', 'resources/python-runtime/_elementtree.pyd', 'resources/python-runtime/_hashlib.pyd', 'resources/python-runtime/_lzma.pyd', 'resources/python-runtime/_multiprocessing.pyd', 'resources/python-runtime/_overlapped.pyd', 'resources/python-runtime/_queue.pyd', 'resources/python-runtime/_remote_debugging.pyd', 'resources/python-runtime/_socket.pyd', 'resources/python-runtime/_sqlite3.pyd', 'resources/python-runtime/_ssl.pyd', 'resources/python-runtime/_uuid.pyd', 'resources/python-runtime/_wmi.pyd', 'resources/python-runtime/_zoneinfo.pyd', 'resources/python-runtime/_zstd.pyd', 'resources/python-runtime/libcrypto-3.dll', 'resources/python-runtime/libffi-8.dll', 'resources/python-runtime/libssl-3.dll', 'resources/python-runtime/libtommath.dll', 'resources/python-runtime/pyexpat.pyd', 'resources/python-runtime/python.cat', 'resources/python-runtime/python.exe', 'resources/python-runtime/python3.dll', 'resources/python-runtime/python314._pth', 'resources/python-runtime/python314.dll', 'resources/python-runtime/python314.zip', 'resources/python-runtime/pythonw.exe', 'resources/python-runtime/select.pyd', 'resources/python-runtime/sqlite3.dll', 'resources/python-runtime/unicodedata.pyd', 'resources/python-runtime/vcruntime140.dll', 'resources/python-runtime/vcruntime140_1.dll', 'resources/python-runtime/winsound.pyd', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'])
MAX_ZIP = 2 * 1024 ** 3
MAX_TOTAL = 4 * 1024 ** 3
MAX_FILE = 1024 ** 3
MAX_FILES = 10000
MAX_SCAN_ASAR = 8 * 1024 * 1024
MAX_CENTRAL = 8 * 1024 * 1024
OWNERSHIP_FILE = '.sessiondock-update-inventory.json'
OWNERSHIP_KEY = '.sessiondock-update-inventory.key'
PENDING_FILE = '.sessiondock-update-pending.json'


def check_pending(install):
    if install is None: return
    reject_reparse(install, PENDING_FILE)
    if os.path.lexists(os.path.join(install, PENDING_FILE)):
        raise ValueError('미완료 업데이트가 있습니다. 앱을 종료한 뒤 update_helper.py recover로 명시 복구해 주세요. 기록: ' + os.path.join(install, PENDING_FILE))


def read_pending(install):
    reject_reparse(install, PENDING_FILE)
    path = os.path.join(install, PENDING_FILE)
    if not os.path.isfile(path) or os.path.getsize(path) > 8 * 1024 * 1024:
        raise ValueError('미완료 업데이트 기록이 손상되었습니다. 백업을 보존합니다.')
    with open(path, 'rb') as f: raw = f.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024: raise ValueError('미완료 업데이트 기록이 너무 큽니다.')
    record = strict_json(raw)
    if not isinstance(record, dict) or set(record) != {'format', 'plan', 'backupDir', 'mac'} or type(record['format']) is not int or record['format'] != 1:
        raise ValueError('미완료 업데이트 기록이 올바르지 않습니다.')
    plan = record['plan']
    if not isinstance(plan, dict) or plan.get('installDir') != install:
        raise ValueError('복구 설치 경로가 일치하지 않습니다.')
    validate_recovery_owner(plan)
    backup = record['backupDir']
    if (not isinstance(backup, str) or os.path.normpath(backup) != backup or
            os.path.dirname(backup) != plan['stageDir'] or
            not re.fullmatch(r'sessiondock-backup-[A-Za-z0-9_-]+', os.path.basename(backup))):
        raise ValueError('복구 백업 경로가 올바르지 않습니다.')
    key_name = '.' + os.path.basename(backup) + '.key'
    reject_reparse(plan['stageDir'], key_name)
    with open(os.path.join(plan['stageDir'], key_name), 'rb') as f: key = f.read(33)
    unsigned = {name: value for name, value in record.items() if name != 'mac'}
    if (len(key) != 32 or not isinstance(record['mac'], str) or
            not hmac.compare_digest(record['mac'], hmac.new(key, inventory_bytes(unsigned), hashlib.sha256).hexdigest())):
        raise ValueError('미완료 업데이트 인증에 실패했습니다. 백업을 보존합니다.')
    return record, raw


def validate_recovery_owner(plan):
    receipt = plan.get('restartReceipt')
    if not isinstance(receipt, dict) or set(receipt) != {'root', 'token'}:
        raise ValueError('복구 폴더 소유권을 확인하지 못했습니다.')
    root = validate_owned_root(receipt['root'], receipt['token'], plan['installDir'], plan['userDataDir'])
    if plan.get('stageDir') != os.path.join(root, 'stage'):
        raise ValueError('복구 준비 폴더가 일치하지 않습니다.')


def clear_pending(install, raw):
    _, current = read_pending(install)
    if current != raw: raise ValueError('미완료 업데이트 기록이 변경되었습니다. 백업을 보존합니다.')
    os.unlink(os.path.join(install, PENDING_FILE))


def recover(request):
    """Explicit CLI: never kill/restart an app, and never clean up evidence."""
    install = request.get('installDir')
    if not isinstance(install, str) or not os.path.isabs(install) or os.path.normpath(install) != install:
        raise ValueError('복구 설치 경로는 정규 절대 경로여야 합니다.')
    reject_reparse(install)
    k, parent, mutex = windows_context({'installDir': install}, require_parent=False)
    try:
        ensure_no_other_process(k, install)
        record, raw = read_pending(install)
        result = recover_interrupted(record['plan'], record['backupDir'])
        clear_pending(install, raw)
        return result
    finally:
        k.CloseHandle(mutex)

_digest_observer = None
_install_observer = None
_install_ready = False


def install_progress(phase, completed=None, total=None):
    try:
        if _install_observer is not None:
            now = time.monotonic()
            if (phase != _install_progress_last[0] or completed is None or completed == total or
                    now - _install_progress_last[1] >= 0.1):
                _install_progress_last[:] = [phase, now]
                _install_observer(phase, completed, total)
    except Exception as error:
        global _install_ui_error
        _install_ui_error = str(error)


_install_progress_last = [None, 0.0]
_install_ui_error = None


def version(name):
    match = NAME.fullmatch(name)
    return tuple(map(int, match.groups())) if match else None


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
            if _digest_observer is not None:
                _digest_observer(len(chunk))
    return h.hexdigest()


def universal(path):
    if os.name != 'nt' or path.startswith('\\\\'):
        return path
    import ctypes
    from ctypes import wintypes
    fn = ctypes.WinDLL('mpr', use_last_error=True).WNetGetUniversalNameW
    fn.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
    fn.restype = wintypes.DWORD
    size = wintypes.DWORD(0)
    if fn(path, 1, None, ctypes.byref(size)) != 234 or size.value > 65536:
        return path
    buf = ctypes.create_string_buffer(size.value)
    if fn(path, 1, buf, ctypes.byref(size)):
        return path
    return ctypes.cast(buf, ctypes.POINTER(ctypes.c_wchar_p)).contents.value


# A build identity is content-addressed from the single locked ZIP.
# Without a trusted expected hash this binds observations, not publisher identity.


@contextlib.contextmanager
def release_file(path):
    """Hold a read-only, non-delete/non-write shared Windows handle throughout use."""
    reject_reparse(os.path.dirname(path), os.path.basename(path))
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode): raise ValueError('Release must be a regular file.')
    if os.name != 'nt': raise ValueError('Release verification requires Windows file locking.')
    import msvcrt
    from ctypes import wintypes as w
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    k.CreateFileW.restype = w.HANDLE
    k.CloseHandle.argtypes = [w.HANDLE]
    handle = k.CreateFileW(path, 0x80000000, 1, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        k.CloseHandle(handle)
        raise
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        # Windows lstat/fstat expose different ctime semantics; stable file ID,
        # size and mtime plus the mandatory write/delete-denying handle bind use.
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
        if identity(before) != identity(opened): raise ValueError('Release changed before opening.')
        yield stream
        if identity(opened) != identity(os.lstat(path)): raise ValueError('Release changed during verification.')


def verify_archive(archive, archive_path, expected=None, build_id=None):
    size = os.fstat(archive.fileno()).st_size
    if not 1 <= size <= MAX_ZIP: raise ValueError('ZIP 크기가 올바르지 않습니다.')
    found, notes = archive_version(archive_path, with_notes=True)
    archive.seek(0)
    sha256 = hashlib.file_digest(archive, 'sha256').hexdigest()
    identity = 'sha256-' + sha256
    if (expected is not None and found != expected) or (build_id is not None and identity != build_id):
        raise ValueError('Release ZIP identity mismatch.')
    # Consume each member so CRC checks cover even non-ASAR corruption at scan.
    # archive_version already bounded paths, member counts/sizes and total bytes.
    archive.seek(0)
    with zipfile.ZipFile(archive) as zipped:
        for info in zipped.infolist():
            if info.is_dir(): continue
            with zipped.open(info) as stream:
                while stream.read(1024 * 1024): pass
    return {'version': found, 'buildID': identity, 'zip': {'size': size, 'sha256': sha256}, **({'notes': notes} if notes else {})}


def scan(request):
    check_pending(request.get('installDir'))
    folder = request['folder']
    current = version('SessionDock-' + request['currentVersion'] + '.zip')
    if not current or not os.path.isabs(folder):
        raise ValueError('업데이트 폴더 또는 버전이 올바르지 않습니다.')
    # Single ZIP only; original 0.1.5 layout remains compatible.
    source = os.path.join(folder, 'SessionDock.zip')
    folder_error = '업데이트 폴더에 접근할 수 없습니다. 경로와 연결 상태를 확인해 주세요.'
    try:
        # Distinguish a missing ZIP in an accessible folder from a failed lookup.
        os.lstat(source)
    except FileNotFoundError:
        try:
            if not stat.S_ISDIR(os.stat(folder).st_mode): raise ValueError(folder_error)
        except OSError as error:
            raise ValueError(folder_error) from error
        return {'folder': universal(folder), 'candidate': None}
    except OSError as error:
        raise ValueError(folder_error) from error
    with release_file(source) as archive:
        manifest = verify_archive(archive, source)
        found = manifest['version']
    candidate = None
    found_version = version('SessionDock-' + found + '.zip')
    if found_version is None: raise ValueError('Invalid release version.')
    if found_version > current:
        candidate = {'name': 'SessionDock.zip', 'version': found, 'buildID': manifest['buildID'], **({'notes': manifest['notes']} if manifest.get('notes') else {})}
    return {'folder': universal(folder), 'candidate': candidate}


def safe_name(name):
    if not name or len(name) > 1024 or '\\' in name or name.startswith('/') or '\x00' in name:
        raise ValueError('ZIP 경로가 올바르지 않습니다.')
    parts = name.rstrip('/').split('/')
    for part in parts:
        if not part or part in ('.', '..') or any(c in part for c in ':<>\"|?*') or part[-1] in '. ' or DEVICE.fullmatch(part) or any(ord(c) < 32 for c in part):
            raise ValueError('ZIP 경로가 안전하지 않습니다.')
    return '/'.join(parts)


def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError('JSON 키가 중복됩니다.')
            result[key] = value
        return result
    def invalid(value):
        raise ValueError('JSON 숫자가 올바르지 않습니다.')
    return json.loads(data, object_pairs_hook=unique, parse_constant=invalid)


def read_asar(f, length, expected=None, with_notes=False):
        raw = f.read(16)
        if len(raw) != 16:
            raise ValueError('ASAR 헤더가 잘렸습니다.')
        magic, header_size, pickle_size, json_size = struct.unpack('<IIII', raw)
        if magic != 4 or not 0 < json_size <= MAX_SCAN_ASAR - 16 or header_size < 8 or header_size > MAX_SCAN_ASAR - 8 or pickle_size != header_size - 4 or json_size > pickle_size - 4:
            raise ValueError('ASAR 헤더가 올바르지 않습니다.')
        header = strict_json(f.read(json_size))
        if not isinstance(header, dict): raise ValueError('ASAR 헤더가 올바르지 않습니다.')
        entries = header.get('files')
        if not isinstance(entries, dict): raise ValueError('ASAR 파일 목록이 올바르지 않습니다.')
        entry = entries.get('package.json')
        if not isinstance(entry, dict): raise ValueError('ASAR 패키지 정보가 올바르지 않습니다.')
        size, raw_offset = entry.get('size'), entry.get('offset')
        if type(size) is not int or not isinstance(raw_offset, str) or not re.fullmatch(r'0|[1-9][0-9]*', raw_offset) or entry.get('link') or entry.get('unpacked'):
            raise ValueError('ASAR 패키지 정보가 올바르지 않습니다.')
        offset = int(raw_offset)
        if size < 1 or size > 1024 * 1024 or 8 + header_size + offset + size > length or 8 + header_size + offset + size > MAX_SCAN_ASAR:
            raise ValueError('ASAR 패키지 정보가 올바르지 않습니다.')
        f.read(header_size - 8 - json_size + offset)
        package = strict_json(f.read(size))
        if not isinstance(package, dict): raise ValueError('ASAR 패키지 정보가 올바르지 않습니다.')
        found = package.get('version')
        if package.get('name') != 'sessiondock' or not isinstance(found, str) or not version('SessionDock-' + found + '.zip') or (expected is not None and found != expected):
            raise ValueError('ZIP의 제품 또는 버전이 일치하지 않습니다.')
        main = package.get('main')
        if not isinstance(main, str) or safe_name(main) != main:
            raise ValueError('ASAR 실행 항목이 올바르지 않습니다.')
        node = header
        for part in main.split('/'):
            if not isinstance(node, dict) or not isinstance(node.get('files'), dict): raise ValueError('ASAR 실행 경로가 올바르지 않습니다.')
            node = node['files'].get(part)
        if not isinstance(node, dict): raise ValueError('ASAR 실행 항목이 올바르지 않습니다.')
        entry_size, entry_offset = node.get('size'), node.get('offset')
        if (type(entry_size) is not int or entry_size < 1 or
                not isinstance(entry_offset, str) or not entry_offset.isdecimal() or
                node.get('link') or node.get('unpacked') or
                8 + header_size + int(entry_offset) + entry_size > length):
            raise ValueError('ASAR 실행 항목이 손상되었습니다.')
        return (found, optional_notes(package.get('sessionDockReleaseNotes'))) if with_notes else found


def optional_notes(value):
    if not isinstance(value, str): return None
    try:
        # JS measures UTF-16 code units; encoding also rejects lone surrogates.
        if len(value.encode('utf-16-le')) > 800: return None
    except UnicodeError:
        return None
    forbidden = lambda c: (ord(c) < 32 and c != '\n') or 0x7f <= ord(c) <= 0x9f or ord(c) in (0x2028, 0x2029) or 0x202a <= ord(c) <= 0x202e or 0x2066 <= ord(c) <= 0x2069
    lines = value.split('\n')
    return value if len(lines) <= 2 and all(line.strip() for line in lines) and not any(forbidden(c) for c in value) else None


def validate_asar(file, expected):
    with open(file, 'rb') as f:
        return read_asar(f, os.fstat(f.fileno()).st_size, expected)


class BoundedReader:
    def __init__(self, raw):
        self.raw, self.remaining = raw, 16 * 1024 * 1024
    def read(self, size=-1):
        if size < 0 or size > self.remaining: raise ValueError('ZIP 메타데이터 읽기 한도를 초과했습니다.')
        data = self.raw.read(size)
        self.remaining -= len(data)
        return data
    def __getattr__(self, name):
        return getattr(self.raw, name)


def archive_version(file, with_notes=False):
    before = os.stat(file, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode) or getattr(before, 'st_file_attributes', 0) & 0x400 or not 1 <= before.st_size <= MAX_ZIP:
        raise ValueError('ZIP 크기가 올바르지 않습니다.')
    with open(file, 'rb') as raw:
        opened = os.fstat(raw.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
            raise ValueError('ZIP 파일이 변경되었습니다.')
        raw.seek(max(0, before.st_size - 65557))
        tail = raw.read(65557)
        pos = tail.rfind(b'PK\x05\x06')
        if pos < 0 or pos + 22 > len(tail): raise ValueError('ZIP 끝 정보가 없습니다.')
        _, disk, cd_disk, disk_count, count, cd_size, cd_offset, comment = struct.unpack_from('<4s4H2LH', tail, pos)
        if disk or cd_disk or disk_count != count or count > MAX_FILES or cd_size > MAX_CENTRAL or cd_offset + cd_size > before.st_size or pos + 22 + comment != len(tail):
            raise ValueError('ZIP 디렉터리가 올바르지 않습니다.')
        with zipfile.ZipFile(BoundedReader(raw)) as archive:
            seen, total, asar_info = {}, 0, None
            for info in archive.infolist():
                if '\x00' in info.orig_filename or info.orig_filename.replace('\\', '/') != info.filename.replace('\\', '/'): raise ValueError('ZIP 경로가 올바르지 않습니다.')
                name = safe_name(info.filename.replace('\\', '/')); parts = name.split('/')
                for index in range(1, len(parts)):
                    prefix = '/'.join(parts[:index]); existing = seen.get(prefix.casefold())
                    if existing and (existing[0] != prefix or not existing[1]): raise ValueError('ZIP 경로가 충돌합니다.')
                    if not existing: seen[prefix.casefold()] = (prefix, True, True)
                key = name.casefold(); existing = seen.get(key)
                if existing and (existing[0] != name or not info.is_dir() or not existing[2]): raise ValueError('ZIP 경로가 중복됩니다.')
                seen[key] = (name, info.is_dir(), False)
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode) or (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or info.external_attr & 0x400: raise ValueError('ZIP 링크는 사용할 수 없습니다.')
                if info.flag_bits & 1 or info.file_size > MAX_FILE or (info.file_size > 1024 * 1024 and info.file_size > max(1, info.compress_size) * 1000): raise ValueError('ZIP 항목 크기가 올바르지 않습니다.')
                total += info.file_size
                if total > MAX_TOTAL: raise ValueError('ZIP 압축 해제 크기가 너무 큽니다.')
                if name == 'resources/app.asar' and not info.is_dir(): asar_info = info
            if asar_info is None: raise ValueError('ASAR가 없습니다.')
            with archive.open(asar_info) as stream:
                found = read_asar(stream, asar_info.file_size, with_notes=with_notes)
        after = os.stat(file, follow_symlinks=False)
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns): raise ValueError('ZIP 파일이 변경되었습니다.')
        return found


def stage(request, progress=lambda *args: None):
    check_pending(request.get('installDir'))
    if request.get('name') != 'SessionDock.zip': raise ValueError('Release requires SessionDock.zip.')
    with contextlib.ExitStack() as locks:
        archive = locks.enter_context(release_file(os.path.join(request['folder'], 'SessionDock.zip')))
        manifest = verify_archive(archive, os.path.join(request['folder'], 'SessionDock.zip'), request.get('expectedVersion'), request.get('expectedBuildID'))
        return _stage_verified(request, progress, manifest, locks)


def _stage_verified(request, progress, manifest, locks):
    check_pending(request.get('installDir'))
    folder, name, dest = request['folder'], request['name'], request['stageDir']
    named = version(name)
    expected = request.get('expectedVersion')
    v = version('SessionDock-' + expected + '.zip') if isinstance(expected, str) else named if expected is None else None
    if (name != 'SessionDock.zip' and not named) or (named and named != v):
        raise ValueError('업데이트 경로가 올바르지 않습니다.')
    if not v or not os.path.isabs(folder) or not os.path.isabs(dest):
        raise ValueError('업데이트 경로가 올바르지 않습니다.')
    source = os.path.join(folder, name)
    if not os.path.isfile(source) or os.path.islink(source) or getattr(os.stat(source, follow_symlinks=False), 'st_file_attributes', 0) & 0x400:
        raise ValueError('업데이트 파일을 찾을 수 없습니다.')
    before = os.stat(source, follow_symlinks=False)
    if before.st_size < 1 or before.st_size > MAX_ZIP:
        raise ValueError('ZIP 크기가 올바르지 않습니다.')
    os.mkdir(dest)
    copy = os.path.join(dest, 'archive.zip')
    progress('copy', 0, before.st_size, 'bytes', True)
    with open(source, 'rb') as src, open(copy, 'xb') as out:
        opened = os.fstat(src.fileno())
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns):
            raise ValueError('복사 전 업데이트 파일이 변경되었습니다.')
        copied_bytes = 0
        while chunk := src.read(1024 * 1024):
            out.write(chunk); copied_bytes += len(chunk)
            progress('copy', min(copied_bytes, before.st_size), before.st_size, 'bytes', copied_bytes == before.st_size)
        opened_after = os.fstat(src.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (opened_after.st_dev, opened_after.st_ino, opened_after.st_size, opened_after.st_mtime_ns):
            raise ValueError('복사 중 업데이트 파일이 변경되었습니다.')
    locked_copy = locks.enter_context(release_file(copy))
    if (os.fstat(locked_copy.fileno()).st_size != manifest['zip']['size'] or
            hashlib.file_digest(locked_copy, 'sha256').hexdigest() != manifest['zip']['sha256']):
        raise ValueError('Release ZIP copy size/SHA256 mismatch.')
    verified = 0
    progress('verify', 0, before.st_size * 2, 'bytes', True)
    def observe(count):
        nonlocal verified
        verified += count
        progress('verify', min(verified, before.st_size * 2), before.st_size * 2, 'bytes', False)
    global _digest_observer
    try:
        _digest_observer = observe
        copied = digest(copy)
        after = os.stat(source, follow_symlinks=False)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or digest(source) != copied:
            raise ValueError('복사 중 업데이트 파일이 변경되었습니다.')
        final = os.stat(source, follow_symlinks=False)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
            raise ValueError('검증 중 업데이트 파일이 변경되었습니다.')
    finally:
        _digest_observer = None
    progress('verify', before.st_size * 2, before.st_size * 2, 'bytes', True)
    payload = os.path.join(dest, 'payload')
    os.mkdir(payload)
    seen, files, total = {}, {}, 0
    with zipfile.ZipFile(copy) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_FILES:
            raise ValueError('ZIP 파일 수가 너무 많습니다.')
        extract_bytes = sum(info.file_size for info in infos if not info.is_dir())
        extracted = 0
        progress('extract', 0, extract_bytes, 'bytes', True)
        for info in infos:
            if '\x00' in info.orig_filename or info.orig_filename.replace('\\', '/') != info.filename.replace('\\', '/'):
                raise ValueError('ZIP 경로가 올바르지 않습니다.')
            name2 = safe_name(info.filename.replace('\\', '/'))
            key = name2.casefold()
            parts = name2.split('/')
            for index in range(1, len(parts)):
                prefix = '/'.join(parts[:index])
                existing = seen.get(prefix.casefold())
                if existing and (existing[0] != prefix or not existing[1]):
                    raise ValueError('ZIP 폴더 경로가 충돌합니다.')
                if not existing:
                    seen[prefix.casefold()] = (prefix, True, True)
            existing = seen.get(key)
            if existing and (existing[0] != name2 or not info.is_dir() or not existing[2]):
                raise ValueError('ZIP 파일 경로가 중복됩니다.')
            seen[key] = (name2, info.is_dir(), False)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode) or (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or info.external_attr & 0x400:
                raise ValueError('ZIP 링크는 사용할 수 없습니다.')
            if info.flag_bits & 1 or info.file_size > MAX_FILE or (info.file_size > 1024 * 1024 and info.file_size > max(1, info.compress_size) * 1000):
                raise ValueError('ZIP 항목 크기가 올바르지 않습니다.')
            total += info.file_size
            if total > MAX_TOTAL:
                raise ValueError('ZIP 압축 해제 크기가 너무 큽니다.')
            target = os.path.join(payload, *name2.split('/'))
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            h = hashlib.sha256()
            size = 0
            with archive.open(info) as src, open(target, 'xb') as out:
                while chunk := src.read(1024 * 1024):
                    size += len(chunk)
                    if size > info.file_size:
                        raise ValueError('ZIP 항목이 잘못되었습니다.')
                    h.update(chunk)
                    out.write(chunk)
                    extracted += len(chunk)
                    progress('extract', extracted, extract_bytes, 'bytes', False)
            if size != info.file_size:
                raise ValueError('ZIP 항목이 잘렸습니다.')
            files[name2] = {'size': size, 'sha256': h.hexdigest()}
        if extracted != extract_bytes:
            raise ValueError('ZIP 압축 해제 크기가 일치하지 않습니다.')
        progress('extract', extracted, extract_bytes, 'bytes', True)
    required = ('SessionDock.exe', 'resources/app.asar', 'resources/python-runtime/python.exe', 'resources/automation/python_bridge.py', 'resources.pak', 'icudtl.dat')
    if any(name not in files for name in required):
        raise ValueError('업데이트에 필수 프로그램 파일이 없습니다.')
    validate_asar(os.path.join(payload, 'resources', 'app.asar'), '.'.join(map(str, v)))
    return {'version': '.'.join(map(str, v)), 'archiveSha256': copied, 'files': files, 'stageDir': dest, 'buildID': manifest['buildID']}


def reject_reparse(root, relative=''):
    root = os.path.abspath(root)
    chain = []
    current = root
    while True:
        chain.append(current)
        parent = os.path.dirname(current)
        if parent == current: break
        current = parent
    for component in reversed(chain):
        if os.path.lexists(component):
            info = os.lstat(component)
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('링크 또는 연결된 폴더에는 설치할 수 없습니다.')
    current = root
    for part in ['', *relative.split('/')]:
        if part:
            current = os.path.join(current, part)
        if os.path.lexists(current):
            info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('링크 또는 연결된 폴더에는 설치할 수 없습니다.')


def require_local_fixed_drive(path, error):
    if os.name != 'nt': return
    import ctypes
    from ctypes import wintypes
    get_type = ctypes.WinDLL('kernel32', use_last_error=True).GetDriveTypeW
    get_type.argtypes = [wintypes.LPCWSTR]
    get_type.restype = wintypes.UINT
    drive = os.path.splitdrive(path)[0]
    if not drive or drive.startswith(chr(92)) or get_type(drive + chr(92)) != 3:
        raise ValueError(error)


def windows_context(plan, require_parent=True):
    if os.name != 'nt':
        raise ValueError('Windows에서만 설치할 수 있습니다.')
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = wintypes.HANDLE
    k.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    k.CreateMutexW.restype = wintypes.HANDLE
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.WaitForSingleObject.restype = wintypes.DWORD
    k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    install = os.path.abspath(plan['installDir'])
    require_local_fixed_drive(install, '로컬 설치 폴더에서만 업데이트할 수 있습니다.')
    parent = None
    if require_parent:
        parent = k.OpenProcess(0x100000 | 0x1000, False, plan['parentPid'])
        if not parent:
            raise ValueError('실행 중인 부모 앱을 확인하지 못했습니다.')
        buf, length = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
        if not k.QueryFullProcessImageNameW(parent, 0, buf, ctypes.byref(length)) or os.path.normcase(os.path.abspath(buf.value)) != os.path.normcase(os.path.join(install, 'SessionDock.exe')):
            k.CloseHandle(parent)
            raise ValueError('부모 앱의 실행 경로가 일치하지 않습니다.')
    lockname = 'Global' + chr(92) + 'SessionDockUpdate-' + hashlib.sha256(os.path.normcase(install).encode('utf-8')).hexdigest()
    mutex = k.CreateMutexW(None, True, lockname)
    if not mutex or ctypes.get_last_error() == 183:
        if mutex: k.CloseHandle(mutex)
        if parent: k.CloseHandle(parent)
        raise ValueError('같은 설치 폴더에서 업데이트가 진행 중입니다.')
    return k, parent, mutex


def ensure_no_other_process(k, install):
    import ctypes
    from ctypes import wintypes
    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                    ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD),
                    ('szExeFile', wintypes.WCHAR * 260)]
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    snap = k.CreateToolhelp32Snapshot(2, 0)
    if snap == ctypes.c_void_p(-1).value:
        raise ValueError('실행 중인 앱을 확인하지 못했습니다.')
    try:
        item = PROCESSENTRY32(); item.dwSize = ctypes.sizeof(item)
        if not k.Process32FirstW(snap, ctypes.byref(item)):
            raise ValueError('실행 중인 앱 목록을 읽지 못했습니다.')
        while True:
            if item.szExeFile.casefold() == 'sessiondock.exe':
                h = k.OpenProcess(0x1000, False, item.th32ProcessID)
                if not h:
                    raise ValueError('다른 SessionDock 프로세스를 확인할 수 없습니다.')
                try:
                    buf, length = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
                    if not k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(length)):
                        raise ValueError('다른 SessionDock 경로를 확인할 수 없습니다.')
                    if os.path.normcase(os.path.dirname(os.path.abspath(buf.value))) == os.path.normcase(install):
                        raise ValueError('같은 설치 폴더의 다른 앱을 먼저 종료해 주세요.')
                finally:
                    k.CloseHandle(h)
            if not k.Process32NextW(snap, ctypes.byref(item)): break
    finally:
        k.CloseHandle(snap)


def write_result(path, value):
    temp = path + '.tmp-' + os.urandom(8).hex()
    with open(temp, 'x', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False)
        f.flush(); os.fsync(f.fileno())
    os.replace(temp, path)


def validate_owned_root(root, token, install, user, allow_missing=False):
    if not isinstance(root, str) or not os.path.isabs(root) or os.path.normpath(root) != root:
        raise ValueError('정리 폴더 경로가 올바르지 않습니다.')
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{64}', token):
        raise ValueError('정리 확인 정보가 올바르지 않습니다.')
    if os.path.normcase(os.path.dirname(root)) != os.path.normcase(os.path.abspath(tempfile.gettempdir())) or not re.fullmatch(r'sessiondock-update-[A-Za-z0-9_-]+', os.path.basename(root)):
        raise ValueError('정리 폴더가 임시 폴더의 직계 자식이 아닙니다.')
    for protected in (install, user):
        if not isinstance(protected, str) or not os.path.isabs(protected): raise ValueError('보호 경로가 올바르지 않습니다.')
        try:
            common = os.path.normcase(os.path.commonpath([root, protected]))
            if common in (os.path.normcase(root), os.path.normcase(os.path.abspath(protected))):
                raise ValueError('정리 폴더가 보호 경로와 겹칩니다.')
        except ValueError as error:
            if '겹칩니다' in str(error): raise
    reject_reparse(root)
    if not os.path.lexists(root) and allow_missing: return root
    marker = os.path.join(root, '.sessiondock-update-owner.json')
    reject_reparse(root, '.sessiondock-update-owner.json')
    with open(marker, encoding='utf-8') as f:
        if json.load(f) != {'token': token}: raise ValueError('정리 폴더 소유권이 일치하지 않습니다.')
    return root


def cleanup_owned_root(request):
    request = dict(request)
    request.pop('cleanupError', None)
    root = validate_owned_root(request['root'], request['token'], request['installDir'], request['userDataDir'], allow_missing=True)
    if not os.path.lexists(root): return
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]; k.OpenProcess.restype = wintypes.HANDLE
        k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]; k.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = k.OpenProcess(0x100000, False, request['helperPid'])
        if handle:
            try:
                if k.WaitForSingleObject(handle, 120000) != 0: raise ValueError('설치 도우미 종료를 확인하지 못했습니다.')
            finally: k.CloseHandle(handle)
        elif ctypes.get_last_error() != 87:
            raise ValueError('설치 도우미 종료를 확인하지 못했습니다.')
    # Never traverse reparse points, including ones introduced inside the tree.
    for directory, dirs, files in os.walk(root, topdown=True, followlinks=False):
        for name in dirs + files:
            reject_reparse(root, os.path.relpath(os.path.join(directory, name), root).replace(os.sep, '/'))
    validate_owned_root(root, request['token'], request['installDir'], request['userDataDir'])
    shutil.rmtree(root)


def schedule_cleanup(plan, receipt):
    request = {**receipt, 'installDir': plan['installDir'], 'userDataDir': plan['userDataDir'], 'helperPid': os.getpid()}
    args = [os.path.join(plan['installDir'], 'resources', 'python-runtime', 'pythonw.exe'), '-I', '-S',
            os.path.join(plan['installDir'], 'resources', 'automation', 'update_helper.py'), 'cleanup']
    write_result(os.path.join(plan['userDataDir'], 'update-cleanup-pending.json'), request)
    child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    child.stdin.write(json.dumps(request, ensure_ascii=False).encode('utf-8'))
    child.stdin.close()


def wait_for_restart(child, receipt, expected_version, timeout=60):
    receipt_path = os.path.join(receipt['root'], 'restart-receipt.json')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.poll() is not None: return 'exited'
        try:
            reject_reparse(receipt['root'], 'restart-receipt.json')
            with open(receipt_path, encoding='utf-8') as f: value = json.load(f)
            if child.poll() is not None: return 'exited'
            if value == {'token': receipt['token'], 'pid': child.pid, 'version': expected_version}: return 'confirmed'
        except (OSError, ValueError): pass
        if child.poll() is not None: return 'exited'
        time.sleep(0.1)
    return 'exited' if child.poll() is not None else 'timeout'


def inventory_bytes(files):
    return json.dumps(files, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def read_inventory(install):
    record = os.path.join(install, OWNERSHIP_FILE)
    keyfile = os.path.join(install, OWNERSHIP_KEY)
    for name in (OWNERSHIP_FILE, OWNERSHIP_KEY): reject_reparse(install, name)
    if not os.path.lexists(record) and not os.path.lexists(keyfile):
        return {}, os.urandom(32), False
    try:
        if not os.path.isfile(record) or not os.path.isfile(keyfile) or os.path.getsize(record) > 4 * 1024 * 1024:
            raise ValueError('invalid inventory')
        with open(keyfile, 'rb') as f: key = f.read(33)
        if len(key) != 32: raise ValueError('invalid key')
        def unique(pairs):
            result = {}
            for name, value in pairs:
                if name in result: raise ValueError('duplicate inventory key')
                result[name] = value
            return result
        with open(record, encoding='utf-8') as f: data = json.load(f, object_pairs_hook=unique)
        if not isinstance(data, dict) or set(data) != {'files', 'mac'} or not isinstance(data['files'], dict) or len(data['files']) > MAX_FILES:
            raise ValueError('invalid inventory')
        seen = set()
        for name, value in data['files'].items():
            if safe_name(name) != name or name.casefold() in seen or name.casefold() in (OWNERSHIP_FILE.casefold(), OWNERSHIP_KEY.casefold()) or not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
                raise ValueError('invalid inventory file')
            seen.add(name.casefold())
        expected = hmac.new(key, inventory_bytes(data['files']), hashlib.sha256).hexdigest()
        if not isinstance(data['mac'], str) or not hmac.compare_digest(expected, data['mac']): raise ValueError('invalid inventory mac')
        return data['files'], key, True
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        raise ValueError('업데이트 파일 기록이 손상되었습니다.') from error


def target_state(install, name):
    reject_reparse(install, name)
    target = os.path.join(install, *name.split('/'))
    if not os.path.lexists(target): return None
    if not os.path.isfile(target): raise ValueError('기존 사용자 파일과 업데이트 파일이 충돌합니다.')
    return (os.path.getsize(target), digest(target))


def verify_target(install, name, expected):
    if target_state(install, name) != expected:
        raise ValueError('업데이트 대상 파일이 변경되었습니다: ' + name)


def publish_file(temp, target, expected):
    if expected is None:
        # Windows rename fails if target exists; hard-link creation provides the
        # same atomic no-overwrite guarantee on other platforms used by tests.
        if os.name == 'nt': os.rename(temp, target)
        else: os.link(temp, target); os.unlink(temp)
    else:
        os.replace(temp, target)


class LockWaitBudget:
    def __init__(self):
        self.remaining = 3.0
        self.files = {}

    def wait(self, deadline, name=None):
        file_remaining = 2.0 - self.files.get(name, 0.0)
        delay = min(0.1, self.remaining, file_remaining, deadline - time.monotonic())
        if delay <= 0: return False
        start = time.monotonic()
        time.sleep(delay)
        elapsed = time.monotonic() - start
        self.remaining = max(0.0, self.remaining - elapsed)
        self.files[name] = self.files.get(name, 0.0) + elapsed
        return time.monotonic() < deadline and self.remaining > 0 and self.files[name] < 2.0


def lock_error(phase, name, code, readonly=False):
    cause = '읽기 전용' if readonly else '접근 거부 또는 다른 앱에서 사용 중'
    return ValueError(f'{phase}: {name} ({cause}, WinError {code})')


def readonly_file(path):
    return bool(getattr(os.stat(path, follow_symlinks=False), 'st_file_attributes', 0) & 1)


def read_open_error(path):
    if os.name != 'nt': return None
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(path, 0x80000000, 7, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        return ctypes.get_last_error()
    kernel.CloseHandle(handle)
    return None


def initial_target_state(install, name, budget):
    deadline = time.monotonic() + 2.0
    while True:
        try:
            return target_state(install, name)
        except OSError as error:
            code = getattr(error, 'winerror', None)
            target = os.path.join(install, *name.split('/'))
            if code is None: code = read_open_error(target)
            if code not in (5, 32, 33): raise
            reject_reparse(install, name)
            is_readonly = os.path.exists(target) and readonly_file(target)
            if is_readonly or not budget.wait(deadline, name):
                raise lock_error('대상 확인', name, code, is_readonly) from error


def publish_with_retry(temp, target, expected, install, name, payload, source, content_state, budget):
    deadline = time.monotonic() + 2.0
    first = True
    while True:
        try:
            if not first:
                reject_reparse(payload)
                reject_reparse(install, name)
                temp_name = os.path.relpath(temp, install).replace(os.sep, '/')
                reject_reparse(install, temp_name)
                if source is not None:
                    reject_reparse(payload, name)
                    if not os.path.isfile(source) or (os.path.getsize(source), digest(source)) != content_state:
                        raise ValueError('준비된 파일이 변경되었습니다: ' + name)
                if not os.path.isfile(temp) or (os.path.getsize(temp), digest(temp)) != content_state:
                    raise ValueError('설치 복사본이 변경되었습니다: ' + name)
                verify_target(install, name, expected)
            publish_file(temp, target, expected)
            return
        except OSError as error:
            code = getattr(error, 'winerror', None)
            if code not in (5, 32, 33):
                if code is not None: raise lock_error('파일 교체', name, code) from error
                raise
            is_readonly = os.path.exists(target) and readonly_file(target)
            if is_readonly or not budget.wait(deadline, name):
                raise lock_error('파일 교체', name, code, is_readonly) from error
            first = False


def apply_files(plan):
    if not isinstance(plan.get('buildID'), str) or not isinstance(plan.get('version'), str):
        raise ValueError('Release install identity is missing.')
    check_pending(plan.get('installDir'))
    staged = os.path.abspath(plan['stageDir'])
    with release_file(os.path.join(staged, 'archive.zip')) as archive:
        manifest = verify_archive(archive, os.path.join(staged, 'archive.zip'), plan.get('version'), plan.get('buildID'))
        if plan.get('archiveSha256') != manifest['zip']['sha256']:
            raise ValueError('Release install plan SHA256 mismatch.')
        if archive_version(os.path.join(staged, 'archive.zip')) != manifest['version']:
            raise ValueError('Release install version mismatch.')
        return _apply_files_verified(plan)


def _apply_files_verified(plan):
    install_progress('validate')
    install, staged = os.path.abspath(plan['installDir']), os.path.abspath(plan['stageDir'])
    check_pending(install)
    payload = os.path.join(staged, 'payload')
    if digest(os.path.join(staged, 'archive.zip')) != plan['archiveSha256']:
        raise ValueError('준비된 ZIP이 변경되었습니다.')
    files = plan['files']
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
        raise ValueError('설치 파일 목록이 올바르지 않습니다.')
    reject_reparse(install); reject_reparse(staged); reject_reparse(payload)
    seen = set()
    with zipfile.ZipFile(os.path.join(staged, 'archive.zip')) as archive:
        archive_files = {}
        for item in archive.infolist():
            name = safe_name(item.filename)
            key = name.casefold()
            if key in seen: raise ValueError('ZIP 경로가 중복됩니다.')
            seen.add(key)
            if item.is_dir(): continue
            if name not in files or item.file_size != files[name].get('size'):
                raise ValueError('ZIP과 설치 목록이 일치하지 않습니다.')
            h = hashlib.sha256()
            with archive.open(item) as source:
                while chunk := source.read(1024 * 1024): h.update(chunk)
            if h.hexdigest() != files[name].get('sha256'):
                raise ValueError('ZIP과 설치 파일이 일치하지 않습니다.')
            archive_files[name] = True
        if set(archive_files) != set(files): raise ValueError('ZIP과 설치 목록이 일치하지 않습니다.')
    validate_asar(os.path.join(payload, 'resources', 'app.asar'), plan['version'])
    budget = LockWaitBudget()
    states = {name: initial_target_state(install, name, budget) for name in (OWNERSHIP_FILE, OWNERSHIP_KEY)}
    inventory, inventory_key, _ = read_inventory(install)
    for name in (OWNERSHIP_FILE, OWNERSHIP_KEY): verify_target(install, name, states[name])
    known = {p.casefold() for p in BASELINE_FILES} | {'resources/automation/update_helper.py'}
    owned = {name.casefold(): value for name, value in inventory.items()}
    reserved = {OWNERSHIP_FILE.casefold(), OWNERSHIP_KEY.casefold(), PENDING_FILE.casefold()}
    needed = 0
    for name, meta in files.items():
        if safe_name(name) != name or name.casefold() in reserved or not isinstance(meta, dict): raise ValueError('설치 경로가 올바르지 않습니다.')
        reject_reparse(payload, name); reject_reparse(install, name)
        source, target = os.path.join(payload, *name.split('/')), os.path.join(install, *name.split('/'))
        if not os.path.isfile(source) or os.path.getsize(source) != meta.get('size') or digest(source) != meta.get('sha256'):
            raise ValueError('준비된 파일이 변경되었습니다.')
        state = initial_target_state(install, name, budget)
        states[name] = state
        if state is not None:
            if name.casefold() not in known and name.casefold() not in owned:
                raise ValueError('기존 사용자 파일과 업데이트 파일이 충돌합니다.')
            if name.casefold() in owned and state[1] != owned[name.casefold()]:
                raise ValueError('이전에 설치한 파일이 변경되어 업데이트할 수 없습니다.')
        needed += meta['size'] + (state[0] if state is not None else 0)
        install_progress('validate', len(states) - 2, len(files))
    if shutil.disk_usage(install).free < needed * 2 + 16 * 1024 * 1024:
        raise ValueError('업데이트에 필요한 디스크 공간이 부족합니다.')
    preflight(install, {**files, OWNERSHIP_FILE: {}, OWNERSHIP_KEY: {}}, budget)
    replaced = {name.casefold() for name in files}
    new_inventory = {name: value for name, value in inventory.items() if name.casefold() not in replaced}
    new_inventory.update({name: meta['sha256'] for name, meta in files.items()})
    if len(new_inventory) > MAX_FILES: raise ValueError('업데이트 파일 기록이 너무 큽니다.')
    record = json.dumps({'files': new_inventory, 'mac': hmac.new(inventory_key, inventory_bytes(new_inventory), hashlib.sha256).hexdigest()}, sort_keys=True, ensure_ascii=True).encode('ascii')
    metadata = ((OWNERSHIP_KEY, inventory_key), (OWNERSHIP_FILE, record))
    new_states = {name: [meta['size'], meta['sha256']] for name, meta in files.items()}
    new_states.update({name: [len(content), hashlib.sha256(content).hexdigest()] for name, content in metadata})
    backup = tempfile.mkdtemp(prefix='sessiondock-backup-', dir=staged)
    # A per-transaction key outside the backup binds its journal to this stage.
    # This detects corruption/tampering, not a hostile process with our user rights.
    journal_key = os.urandom(32)
    key_path = os.path.join(staged, '.' + os.path.basename(backup) + '.key')
    with open(key_path, 'xb') as f:
        f.write(journal_key); f.flush(); os.fsync(f.fileno())
    os.chmod(key_path, 0o600)
    journal_path = os.path.join(backup, 'journal.jsonl')
    journal = []
    previous_mac = ''
    def record_journal(entry):
        nonlocal previous_mac
        mac = hmac.new(journal_key, previous_mac.encode('ascii') + inventory_bytes(entry), hashlib.sha256).hexdigest()
        with open(journal_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps({**entry, 'mac': mac}, ensure_ascii=False) + chr(10))
            f.flush(); os.fsync(f.fileno())
        previous_mac = mac
    try:
        record_journal({'state': 'start', 'format': 2, 'installDir': install, 'stageDir': staged,
                        'backupDir': backup, 'version': plan['version'], 'archiveSha256': plan['archiveSha256'],
                        'filesSha256': hashlib.sha256(inventory_bytes(files)).hexdigest(),
                        'oldStates': states, 'newStates': new_states, 'owned': inventory})
        if 'restartReceipt' in plan:
            validate_recovery_owner(plan)
            recovery_plan = {name: plan[name] for name in ('version', 'installDir', 'stageDir', 'archiveSha256', 'files', 'userDataDir', 'restartReceipt')}
            pending = {'format': 1, 'plan': recovery_plan, 'backupDir': backup}
            pending['mac'] = hmac.new(journal_key, inventory_bytes(pending), hashlib.sha256).hexdigest()
            # Exclusive creation prevents replacement of a previous transaction.
            with open(os.path.join(install, PENDING_FILE), 'x', encoding='utf-8') as f:
                json.dump(pending, f, ensure_ascii=True)
                f.flush(); os.fsync(f.fileno())
        install_progress('apply', 0, len(files) + 2)
        for index, name in enumerate(files):
            reject_reparse(install, name)
            source, target = os.path.join(payload, *name.split('/')), os.path.join(install, *name.split('/'))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            reject_reparse(install, name)
            verify_target(install, name, states[name])
            previous = None
            if states[name] is not None:
                previous = os.path.join(backup, *name.split('/'))
                os.makedirs(os.path.dirname(previous), exist_ok=True)
                with open(target, 'rb') as old, open(previous, 'xb') as saved:
                    shutil.copyfileobj(old, saved, 1024 * 1024)
                    saved.flush(); os.fsync(saved.fileno())
                if (os.path.getsize(previous), digest(previous)) != states[name]: raise ValueError('업데이트 백업이 변경되었습니다: ' + name)
                verify_target(install, name, states[name])
            record_journal({'state': 'pending', 'name': name, 'backup': previous})
            temp = target + '.sessiondock-' + os.urandom(8).hex() + '.tmp'
            try:
                shutil.copy2(source, temp)
                if digest(temp) != files[name]['sha256']: raise ValueError('설치 복사본이 변경되었습니다.')
                verify_target(install, name, states[name])
                publish_with_retry(temp, target, states[name], install, name, payload, source,
                                   (files[name]['size'], files[name]['sha256']), budget)
            finally:
                if os.path.exists(temp): os.unlink(temp)
            journal.append((target, previous))
            record_journal({'state': 'replaced', 'name': name})
            install_progress('apply', index + 1, len(files) + 2)
        for index, (name, content) in enumerate(metadata):
            target = os.path.join(install, name)
            reject_reparse(install, name)
            verify_target(install, name, states[name])
            previous = None
            if states[name] is not None:
                previous = os.path.join(backup, name)
                with open(target, 'rb') as old, open(previous, 'xb') as saved:
                    shutil.copyfileobj(old, saved); saved.flush(); os.fsync(saved.fileno())
                if (os.path.getsize(previous), digest(previous)) != states[name]: raise ValueError('업데이트 백업이 변경되었습니다: ' + name)
                verify_target(install, name, states[name])
            record_journal({'state': 'pending', 'name': name, 'backup': previous})
            temp = target + '.sessiondock-' + os.urandom(8).hex() + '.tmp'
            try:
                with open(temp, 'xb') as out: out.write(content); out.flush(); os.fsync(out.fileno())
                verify_target(install, name, states[name])
                publish_with_retry(temp, target, states[name], install, name, payload, None,
                                   (len(content), hashlib.sha256(content).hexdigest()), budget)
            finally:
                if os.path.exists(temp): os.unlink(temp)
            journal.append((target, previous))
            record_journal({'state': 'replaced', 'name': name})
            install_progress('apply', len(files) + index + 1, len(files) + 2)
        record_journal({'state': 'complete'})
        return backup, journal
    except Exception as error:
        install_progress('rollback')
        failures = rollback(journal)
        try: record_journal({'state': 'rollback', 'failed': len(failures)})
        except OSError: pass
        if failures: raise RuntimeError('복구 실패: 백업 보존 ' + backup) from error
        raise RuntimeError(str(error) + ' (백업 및 저널: ' + backup + ')') from error


def recover_interrupted(plan, backup):
    """Explicit offline recovery; validate everything before changing any target.

    Keep the backup, authentication key and journal even on success. Each target
    may already have its old state, making a killed recovery safe to repeat.
    Callers must hold the installation lock and ensure the app is not running.
    Legacy journals lack authenticated old hashes and are deliberately refused.
    """
    def invalid() -> NoReturn:
        raise ValueError('중단 복구 기록 또는 파일이 손상되거나 변경되었습니다. 백업을 보존합니다.')

    def canonical(path):
        if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path:
            invalid()
        return path

    def bounded_read(path, maximum):
        if not os.path.isfile(path) or os.path.getsize(path) > maximum: invalid()
        with open(path, 'rb') as f: data = f.read(maximum + 1)
        if len(data) > maximum: invalid()
        return data

    def state(value, missing=False):
        if value is None and missing: return None
        if (not isinstance(value, list) or len(value) != 2 or type(value[0]) is not int or
                not 0 <= value[0] <= MAX_FILE or not isinstance(value[1], str) or
                not re.fullmatch(r'[0-9a-f]{64}', value[1])): invalid()
        return tuple(value)

    install = canonical(plan.get('installDir'))
    staged = canonical(plan.get('stageDir'))
    backup = canonical(backup)
    if (os.path.dirname(backup) != staged or
            not re.fullmatch(r'sessiondock-backup-[A-Za-z0-9_-]+', os.path.basename(backup))): invalid()
    try:
        if os.path.normcase(os.path.commonpath([install, staged])) in (os.path.normcase(install), os.path.normcase(staged)): invalid()
    except ValueError:
        invalid()
    for root in (install, staged, backup): reject_reparse(root)
    key_name = '.' + os.path.basename(backup) + '.key'
    reject_reparse(staged, key_name)
    reject_reparse(backup, 'journal.jsonl')
    key = bounded_read(os.path.join(staged, key_name), 32)
    if len(key) != 32: invalid()
    raw = bounded_read(os.path.join(backup, 'journal.jsonl'), 16 * 1024 * 1024)
    if not raw or not raw.endswith(b'\n'): invalid()
    lines = raw.splitlines()
    if len(lines) > 2 * (MAX_FILES + 2) + 3: invalid()
    entries, previous_mac = [], ''
    for line in lines:
        entry = strict_json(line)
        if not isinstance(entry, dict): invalid()
        mac = entry.pop('mac', None)
        expected = hmac.new(key, previous_mac.encode('ascii') + inventory_bytes(entry), hashlib.sha256).hexdigest()
        if not isinstance(mac, str) or not hmac.compare_digest(expected, mac): invalid()
        entries.append(entry)
        previous_mac = mac
    start = entries[0]
    if (set(start) != {'state', 'format', 'installDir', 'stageDir', 'backupDir', 'version',
                       'archiveSha256', 'filesSha256', 'oldStates', 'newStates', 'owned'} or
            start['state'] != 'start' or type(start['format']) is not int or start['format'] != 2 or
            start['installDir'] != install or start['stageDir'] != staged or start['backupDir'] != backup or
            start['version'] != plan.get('version') or not isinstance(start['version'], str) or
            not version('SessionDock-' + start['version'] + '.zip') or
            start['archiveSha256'] != plan.get('archiveSha256') or
            not isinstance(start['archiveSha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', start['archiveSha256'])): invalid()
    files = plan.get('files')
    if not isinstance(files, dict) or not 1 <= len(files) <= MAX_FILES: invalid()
    if start['filesSha256'] != hashlib.sha256(inventory_bytes(files)).hexdigest(): invalid()
    names = [*files, OWNERSHIP_KEY, OWNERSHIP_FILE]
    seen = {}
    for name in names:
        if not isinstance(name, str) or safe_name(name) != name or name.casefold() in seen: invalid()
        seen[name.casefold()] = name
    for name in names:
        parts = name.split('/')
        if any('/'.join(parts[:i]).casefold() in seen for i in range(1, len(parts))): invalid()
    old, new, owned = start['oldStates'], start['newStates'], start['owned']
    if (not isinstance(old, dict) or not isinstance(new, dict) or set(old) != set(names) or
            set(new) != set(names) or not isinstance(owned, dict) or len(owned) > MAX_FILES): invalid()
    old = {name: state(value, True) for name, value in old.items()}
    new = {name: state(value) for name, value in new.items()}
    ownership = {}
    for name, value in owned.items():
        if (safe_name(name) != name or name.casefold() in ownership or
                name.casefold() in (OWNERSHIP_KEY.casefold(), OWNERSHIP_FILE.casefold()) or
                not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)): invalid()
        ownership[name.casefold()] = value
    if (old[OWNERSHIP_KEY] is None) != (old[OWNERSHIP_FILE] is None): invalid()
    if ownership and old[OWNERSHIP_KEY] is None: invalid()
    known = {name.casefold() for name in BASELINE_FILES} | {'resources/automation/update_helper.py'}
    for name, meta in files.items():
        if (not isinstance(meta, dict) or set(meta) != {'size', 'sha256'} or
                state([meta['size'], meta['sha256']]) != new[name]): invalid()
        if old[name] is not None:
            if name.casefold() not in known and name.casefold() not in ownership: invalid()
            if name.casefold() in ownership and old[name][1] != ownership[name.casefold()]: invalid()
    # Strict write-ahead state machine: at most one unmatched pending record.
    pending, completed, terminal = [], set(), False
    for entry in entries[1:]:
        if terminal: invalid()
        kind = entry.get('state')
        if kind == 'pending':
            if (set(entry) != {'state', 'name', 'backup'} or len(pending) != len(completed) or
                    len(pending) >= len(names) or entry['name'] != names[len(pending)]): invalid()
            name = entry['name']
            previous = os.path.join(backup, *name.split('/')) if old[name] is not None else None
            if entry['backup'] != previous: invalid()
            pending.append(name)
        elif kind == 'replaced':
            if (set(entry) != {'state', 'name'} or len(pending) != len(completed) + 1 or
                    entry['name'] != pending[-1]): invalid()
            completed.add(entry['name'])
        elif kind == 'complete':
            if set(entry) != {'state'} or len(completed) != len(names): invalid()
            terminal = True
        elif kind == 'rollback':
            if set(entry) != {'state', 'failed'} or type(entry['failed']) is not int or not 0 <= entry['failed'] <= len(pending): invalid()
            terminal = True
        else:
            invalid()
    # Check ALL targets first, including ones not yet touched. This also detects
    # a valid journal prefix truncated before a subsequent replacement.
    snapshots = {}
    for name in names:
        current = target_state(install, name)
        if current != old[name] and (name not in pending or current != new[name]): invalid()
        snapshots[name] = current
    for name in pending:
        if old[name] is not None and target_state(backup, name) != old[name]: invalid()
    for name in reversed(pending):
        current = snapshots[name]
        verify_target(install, name, current)
        if current == old[name]: continue
        target = os.path.join(install, *name.split('/'))
        if old[name] is None:
            os.unlink(target)
        else:
            previous = os.path.join(backup, *name.split('/'))
            verify_target(backup, name, old[name])
            temp = target + '.restore-' + os.urandom(8).hex()
            try:
                with open(previous, 'rb') as source, open(temp, 'xb') as out:
                    shutil.copyfileobj(source, out, 1024 * 1024)
                    out.flush(); os.fsync(out.fileno())
                reject_reparse(install, os.path.relpath(temp, install).replace(os.sep, '/'))
                if (os.path.getsize(temp), digest(temp)) != old[name]: invalid()
                verify_target(install, name, current)
                verify_target(backup, name, old[name])
                os.replace(temp, target)
            finally:
                if os.path.exists(temp): os.unlink(temp)
        verify_target(install, name, old[name])
    return {'ok': True, 'backupDir': backup}


def preflight(install, files, budget=None):
    if os.name != 'nt': raise ValueError('Windows에서만 설치할 수 있습니다.')
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    k.CreateFileW.restype = wintypes.HANDLE
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    if budget is None: budget = LockWaitBudget()
    directories = set()
    for name in files:
        target = os.path.join(install, *name.split('/'))
        directory = os.path.dirname(target)
        while not os.path.exists(directory): directory = os.path.dirname(directory)
        directories.add(directory)
        if os.path.exists(target):
            deadline = time.monotonic() + 2.0
            while True:
                reject_reparse(install, name)
                if readonly_file(target): raise lock_error('사전 검사', name, 5, True)
                handle = k.CreateFileW(target, 0xC0000000, 0, None, 3, 0x80, None)
                if handle != ctypes.c_void_p(-1).value:
                    k.CloseHandle(handle)
                    break
                code = ctypes.get_last_error()
                if code not in (5, 32, 33) or not budget.wait(deadline, name):
                    raise lock_error('사전 검사', name, code)
    for directory in directories:
        name = os.path.join(directory, '.sessiondock-check-' + os.urandom(8).hex())
        try:
            with open(name, 'xb'): pass
        except OSError as error:
            relative = os.path.relpath(directory, install).replace(os.sep, '/')
            raise ValueError(f'폴더 사전 검사: {relative} (WinError {getattr(error, "winerror", None)})') from error
        finally:
            if os.path.exists(name): os.unlink(name)


def rollback(journal):
    failures = []
    for target, previous in reversed(journal):
        try:
            if previous:
                temp = target + '.restore-' + os.urandom(8).hex()
                shutil.copy2(previous, temp); os.replace(temp, target)
            else:
                os.unlink(target)
        except OSError:
            failures.append(target)
    return failures


class NativeProgress:
    """Best-effort native display; closing it does not cancel installation."""
    labels = {'waiting': '종료 대기', 'validate': '설치 파일 확인', 'apply': '파일 교체', 'restart': '앱 다시 시작', 'rollback': '업데이트 실패 / 복구 중', 'failed': '업데이트 실패', 'success': '업데이트 완료'}
    palettes = {
        'dark': {'panel': '#212224', 'header': '#262729', 'text': '#e4e5e7', 'muted': '#aeb2b8', 'line': '#323437', 'accent': '#4fc1bf', 'success': '#7ccf98', 'danger': '#f08c8c'},
        'light': {'panel': '#f2f5f8', 'header': '#e8edf3', 'text': '#17212e', 'muted': '#344358', 'line': '#aeb9c7', 'accent': '#075e64', 'success': '#28704e', 'danger': '#b73d48'},
    }

    def __init__(self, hidden=False, theme='dark'):
        self.theme = theme if theme in ('dark', 'light') else 'dark'
        self.pending = None
        self.lock = threading.Lock()
        self.hidden = hidden
        self.ready = threading.Event()
        self.hwnd = None
        self.error = None
        self.phase, self.completed, self.total = 'waiting', None, None
        self.tick = 0
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def update(self, phase, completed=None, total=None):
        with self.lock:
            self.pending = (phase, completed, total)

    def _run(self):
        try:
            self._window()
        except Exception as error:
            self.error = str(error)
        finally:
            self.ready.set()

    def close(self):
        if self.hwnd:
            try:
                import ctypes
                from ctypes import wintypes as w
                post = ctypes.WinDLL('user32', use_last_error=True).PostMessageW
                post.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]; post.restype = w.BOOL
                post(self.hwnd, 0x10, 0, 0)
            except Exception as error:
                global _install_ui_error
                _install_ui_error = str(error)

    def paint(self, hdc):
        """Render the actual client surface to a window or offscreen HDC."""
        import ctypes
        from ctypes import wintypes as w
        u, g = self._user32, self._gdi32
        rect = w.RECT()
        u.GetClientRect(self.hwnd, ctypes.byref(rect))
        def px(n): return int(n * self._scale + .5)
        def fill(x, y, right, bottom, brush):
            if right > x and bottom > y:
                r = w.RECT(x, y, right, bottom); u.FillRect(hdc, ctypes.byref(r), brush)
        def text(value, x, y, right, bottom, color, font):
            old = g.SelectObject(hdc, font)
            g.SetTextColor(hdc, color); g.SetBkMode(hdc, 1)
            r = w.RECT(x, y, right, bottom)
            u.DrawTextW(hdc, value, -1, ctypes.byref(r), 0x820)
            g.SelectObject(hdc, old)
        width, height = rect.right, rect.bottom
        fill(0, 0, width, height, self._brushes['panel'])
        fill(0, 0, width, px(54), self._brushes['header'])
        fill(0, px(53), width, px(54), self._brushes['line'])
        text('업데이트', px(20), px(15), width-px(20), px(42), self._colors['text'], self._fonts['title'])
        key = 'danger' if self.phase in ('failed', 'rollback') else 'success' if self.phase == 'success' else 'text'
        text(self.labels.get(self.phase, str(self.phase)), px(20), px(76), width-px(20), px(102), self._colors[key], self._fonts['title'])
        if self.phase == 'failed': return
        pct = None
        if isinstance(self.completed, (int, float)) and isinstance(self.total, (int, float)) and self.total > 0:
            pct = min(100, max(0, int(self.completed * 100 / self.total)))
        detail = str(pct) + '%' if pct is not None else ('완료' if self.phase == 'success' else '진행 중…')
        text(detail, px(20), px(112), width-px(20), px(138), self._colors['muted'], self._fonts['body'])
        left, right, top = px(20), width-px(20), px(151)
        fill(left, top, right, top+max(2, px(4)), self._brushes['line'])
        span = max(0, right-left)
        if pct is None and self.phase != 'success':
            block = max(px(20), span//4)
            offset = (self.tick * px(5)) % max(1, span + block) - block
            fill(max(left, left+offset), top, min(right, left+offset+block), top+max(2, px(4)), self._brushes['accent'])
        else:
            fill(left, top, left + span * (100 if self.phase == 'success' else pct) // 100, top+max(2, px(4)), self._brushes['success' if self.phase == 'success' else 'accent'])

    def _window(self):
        import ctypes
        from ctypes import wintypes as w
        u = ctypes.WinDLL('user32', use_last_error=True)
        g = ctypes.WinDLL('gdi32', use_last_error=True)
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        self._user32, self._gdi32 = u, g
        LRESULT = ctypes.c_ssize_t
        WNDPROC = ctypes.WINFUNCTYPE(LRESULT, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
        class WNDCLASS(ctypes.Structure):
            _fields_ = [('style', w.UINT), ('lpfnWndProc', WNDPROC), ('cbClsExtra', ctypes.c_int), ('cbWndExtra', ctypes.c_int), ('hInstance', w.HINSTANCE), ('hIcon', w.HICON), ('hCursor', w.HANDLE), ('hbrBackground', w.HBRUSH), ('lpszMenuName', w.LPCWSTR), ('lpszClassName', w.LPCWSTR)]
        class PAINTSTRUCT(ctypes.Structure):
            _fields_ = [('hdc', w.HDC), ('fErase', w.BOOL), ('rcPaint', w.RECT), ('fRestore', w.BOOL), ('fIncUpdate', w.BOOL), ('rgbReserved', ctypes.c_byte * 32)]
        class HIGHCONTRAST(ctypes.Structure):
            _fields_ = [('cbSize', w.UINT), ('dwFlags', w.DWORD), ('lpszDefaultScheme', w.LPWSTR)]
        def api(lib, name, args, result):
            fn = getattr(lib, name); fn.argtypes = args; fn.restype = result; return fn
        api(k, 'GetModuleHandleW', [w.LPCWSTR], w.HMODULE)
        api(u, 'RegisterClassW', [ctypes.POINTER(WNDCLASS)], w.ATOM)
        api(u, 'UnregisterClassW', [w.LPCWSTR, w.HINSTANCE], w.BOOL)
        api(u, 'CreateWindowExW', [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.HWND, w.HMENU, w.HINSTANCE, ctypes.c_void_p], w.HWND)
        api(u, 'DefWindowProcW', [w.HWND, w.UINT, w.WPARAM, w.LPARAM], LRESULT)
        api(u, 'DestroyWindow', [w.HWND], w.BOOL)
        api(u, 'PostQuitMessage', [ctypes.c_int], None)
        api(u, 'SetTimer', [w.HWND, ctypes.c_size_t, w.UINT, ctypes.c_void_p], ctypes.c_size_t)
        api(u, 'SetWindowTextW', [w.HWND, w.LPCWSTR], w.BOOL)
        api(u, 'SendMessageW', [w.HWND, w.UINT, w.WPARAM, w.LPARAM], LRESULT)
        api(u, 'ShowWindow', [w.HWND, ctypes.c_int], w.BOOL)
        api(u, 'GetMessageW', [ctypes.POINTER(w.MSG), w.HWND, w.UINT, w.UINT], ctypes.c_int)
        api(u, 'TranslateMessage', [ctypes.POINTER(w.MSG)], w.BOOL)
        api(u, 'DispatchMessageW', [ctypes.POINTER(w.MSG)], LRESULT)
        api(u, 'IsDialogMessageW', [w.HWND, ctypes.POINTER(w.MSG)], w.BOOL)
        api(u, 'BeginPaint', [w.HWND, ctypes.POINTER(PAINTSTRUCT)], w.HDC)
        api(u, 'EndPaint', [w.HWND, ctypes.POINTER(PAINTSTRUCT)], w.BOOL)
        api(u, 'GetClientRect', [w.HWND, ctypes.POINTER(w.RECT)], w.BOOL)
        api(u, 'InvalidateRect', [w.HWND, ctypes.POINTER(w.RECT), w.BOOL], w.BOOL)
        api(u, 'FillRect', [w.HDC, ctypes.POINTER(w.RECT), w.HBRUSH], ctypes.c_int)
        api(u, 'DrawTextW', [w.HDC, w.LPCWSTR, ctypes.c_int, ctypes.POINTER(w.RECT), w.UINT], ctypes.c_int)
        api(u, 'SystemParametersInfoW', [w.UINT, w.UINT, ctypes.c_void_p, w.UINT], w.BOOL)
        api(u, 'GetSysColor', [ctypes.c_int], w.DWORD)
        api(u, 'AdjustWindowRectEx', [ctypes.POINTER(w.RECT), w.DWORD, w.BOOL, w.DWORD], w.BOOL)
        api(u, 'SetWindowPos', [w.HWND, w.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.UINT], w.BOOL)
        api(u, 'MoveWindow', [w.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.BOOL], w.BOOL)
        api(g, 'CreateSolidBrush', [w.DWORD], w.HBRUSH)
        api(g, 'DeleteObject', [w.HANDLE], w.BOOL)
        api(g, 'SelectObject', [w.HDC, w.HANDLE], w.HANDLE)
        api(g, 'SetTextColor', [w.HDC, w.DWORD], w.DWORD)
        api(g, 'SetBkColor', [w.HDC, w.DWORD], w.DWORD)
        api(g, 'SetBkMode', [w.HDC, ctypes.c_int], ctypes.c_int)
        api(g, 'CreateFontW', [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.LPCWSTR], w.HANDLE)
        try:
            api(u, 'SetThreadDpiAwarenessContext', [ctypes.c_void_p], ctypes.c_void_p)(ctypes.c_void_p(-4))
        except (AttributeError, OSError): pass
        try: dpi = api(u, 'GetDpiForSystem', [], w.UINT)() or 96
        except (AttributeError, OSError): dpi = 96
        self._scale = dpi / 96.0
        def px(n): return int(n * self._scale + .5)
        def color(value):
            value = value.lstrip('#'); return int(value[0:2], 16) | int(value[2:4], 16) << 8 | int(value[4:6], 16) << 16
        self._colors = {name: color(value) for name, value in self.palettes[self.theme].items()}
        hc = HIGHCONTRAST(ctypes.sizeof(HIGHCONTRAST), 0, None)
        high_contrast = u.SystemParametersInfoW(0x42, hc.cbSize, ctypes.byref(hc), 0) and hc.dwFlags & 1
        if high_contrast:
            self._colors = {'panel': u.GetSysColor(5), 'header': u.GetSysColor(5), 'text': u.GetSysColor(8), 'muted': u.GetSysColor(8), 'line': u.GetSysColor(8), 'accent': u.GetSysColor(8), 'success': u.GetSysColor(8), 'danger': u.GetSysColor(8)}
        self._brushes, self._fonts = {}, {}
        instance = k.GetModuleHandleW(None)
        name = 'SessionDockUpdateProgress_' + str(id(self))
        registered = False
        hwnd = None
        controls = {}
        terminal_at = None
        def create_fonts(scale):
            created = {}
            try:
                for key, weight, size in [('body', 400, 12), ('title', 600, 13)]:
                    font = g.CreateFontW(-int(size * scale + .5), 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0, 'Malgun Gothic')
                    if not font: raise ctypes.WinError(ctypes.get_last_error())
                    created[key] = font
                return created
            except Exception:
                for font in created.values(): g.DeleteObject(font)
                raise
        def layout_error(window):
            if not controls.get('error'): return
            rect = w.RECT(); u.GetClientRect(window, ctypes.byref(rect))
            u.MoveWindow(controls['error'], px(20), px(110), max(1, rect.right-px(40)), max(1, rect.bottom-px(125)), True)
        @WNDPROC
        def proc(window, msg, wp, lp):
            nonlocal terminal_at
            try:
                if msg == 0x10: u.DestroyWindow(window); return 0
                if msg == 0x02: u.PostQuitMessage(0); return 0
                if msg == 0x14: return 1
                if msg == 0x0f:
                    ps = PAINTSTRUCT(); dc = u.BeginPaint(window, ctypes.byref(ps))
                    try: self.paint(dc)
                    finally: u.EndPaint(window, ctypes.byref(ps))
                    return 0
                if msg == 0x318: self.paint(w.HDC(wp)); return 0
                if msg == 0x02e0 and self.hwnd:
                    scale = (wp & 0xffff) / 96.0
                    fonts = create_fonts(scale)
                    previous = self._fonts
                    self._scale = scale
                    self._fonts = fonts
                    if controls.get('error'): u.SendMessageW(controls['error'], 0x30, fonts['body'], 1)
                    for font in previous.values(): g.DeleteObject(font)
                    suggested = ctypes.cast(lp, ctypes.POINTER(w.RECT)).contents
                    u.SetWindowPos(window, None, suggested.left, suggested.top, suggested.right-suggested.left, suggested.bottom-suggested.top, 0x14)
                    layout_error(window)
                    u.InvalidateRect(window, None, False)
                    return 0
                if msg == 0x05: layout_error(window)
                if msg in (0x133, 0x138):
                    g.SetTextColor(w.HDC(wp), self._colors['text']); g.SetBkColor(w.HDC(wp), self._colors['panel'])
                    return self._brushes['panel']
                if msg == 0x113:
                    with self.lock: item, self.pending = self.pending, None
                    if item:
                        self.phase, self.completed, self.total = item
                        if self.phase == 'failed':
                            message = str(self.completed or '업데이트하지 못했습니다.').replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\r\n')
                            u.SetWindowTextW(controls['error'], message)
                            u.ShowWindow(controls['error'], 5)
                        else: u.ShowWindow(controls['error'], 0)
                        terminal_at = time.monotonic() if self.phase == 'success' else None
                    self.tick += 1
                    u.InvalidateRect(window, None, False)
                    if terminal_at is not None and time.monotonic() - terminal_at >= 1.5: u.DestroyWindow(window)
                    return 0
            except Exception as error:
                global _install_ui_error
                _install_ui_error = str(error)
            return u.DefWindowProcW(window, msg, wp, lp)
        try:
            for key, value in self._colors.items():
                brush = g.CreateSolidBrush(value)
                if not brush: raise ctypes.WinError(ctypes.get_last_error())
                self._brushes[key] = brush
            self._fonts = create_fonts(self._scale)
            wc = WNDCLASS(0, proc, 0, 0, instance, None, None, None, None, name)
            if not u.RegisterClassW(ctypes.byref(wc)): raise ctypes.WinError(ctypes.get_last_error())
            registered = True
            style = 0x00CA0000
            bounds = w.RECT(0, 0, px(440), px(220))
            u.AdjustWindowRectEx(ctypes.byref(bounds), style, False, 0)
            width, height = bounds.right-bounds.left, bounds.bottom-bounds.top
            work = w.RECT()
            if not u.SystemParametersInfoW(0x30, 0, ctypes.byref(work), 0): work = w.RECT(0, 0, px(1024), px(768))
            width, height = min(width, work.right-work.left), min(height, work.bottom-work.top)
            x = work.left + max(0, (work.right-work.left-width)//2)
            y = work.top + max(0, (work.bottom-work.top-height)//2)
            hwnd = u.CreateWindowExW(0, name, 'SessionDock', style, x, y, width, height, None, None, instance, None)
            if not hwnd: raise ctypes.WinError(ctypes.get_last_error())
            self.hwnd = hwnd
            if not high_contrast:
                try:
                    dwm = ctypes.WinDLL('dwmapi')
                    api(dwm, 'DwmSetWindowAttribute', [w.HWND, w.DWORD, ctypes.c_void_p, w.DWORD], ctypes.c_long)
                    for attribute, value in [(20, 1 if self.theme == 'dark' else 0), (35, self._colors['header']), (36, self._colors['text'])]:
                        v = w.DWORD(value); dwm.DwmSetWindowAttribute(hwnd, attribute, ctypes.byref(v), ctypes.sizeof(v))
                except (AttributeError, OSError): pass
            controls['error'] = u.CreateWindowExW(0, 'EDIT', '', 0x50A11844, px(20), px(110), max(1, width-px(56)), px(85), hwnd, None, instance, None)
            if not controls['error']: raise ctypes.WinError(ctypes.get_last_error())
            layout_error(hwnd)
            u.SendMessageW(controls['error'], 0x30, self._fonts['body'], 1)
            u.ShowWindow(controls['error'], 0)
            if not u.SetTimer(hwnd, 1, 100, None): raise ctypes.WinError(ctypes.get_last_error())
            u.ShowWindow(hwnd, 0 if self.hidden else 5)
            if not self.hidden: u.ShowWindow(hwnd, 5)
            self.ready.set()
            msg = w.MSG()
            while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                if msg.message == 0x100 and msg.wParam == 0x1b:
                    u.DestroyWindow(hwnd); continue
                if not u.IsDialogMessageW(hwnd, ctypes.byref(msg)):
                    u.TranslateMessage(ctypes.byref(msg)); u.DispatchMessageW(ctypes.byref(msg))
        finally:
            if hwnd: u.DestroyWindow(hwnd)
            self.hwnd = None
            if registered: u.UnregisterClassW(name, instance)
            for value in self._fonts.values(): g.DeleteObject(value)
            for value in self._brushes.values(): g.DeleteObject(value)


def install(plan, ui_factory=None):
    from ctypes import wintypes, byref
    required = ('version', 'buildID', 'stageDir', 'archiveSha256', 'files', 'installDir', 'userDataDir', 'parentPid', 'approvalToken', 'approvalPath', 'resultPath', 'profileArg')
    if (any(key not in plan for key in required) or not isinstance(plan.get('buildID'), str) or
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', plan['buildID']) or
            not version('SessionDock-' + str(plan['version']) + '.zip')):
        raise ValueError('설치 계획이 올바르지 않습니다.')
    if not re.fullmatch(r'[0-9a-f]{64}', plan['approvalToken']) or not re.fullmatch(r'[0-9a-f]{64}', plan['archiveSha256']):
        raise ValueError('설치 승인 정보가 올바르지 않습니다.')
    for key in ('installDir', 'stageDir', 'userDataDir', 'approvalPath', 'resultPath'):
        if not os.path.isabs(plan[key]): raise ValueError('설치 경로가 올바르지 않습니다.')
    install_dir = os.path.abspath(plan['installDir'])
    user_dir = os.path.abspath(plan['userDataDir'])
    try: userdata_inside_install = os.path.normcase(os.path.commonpath([install_dir, user_dir])) == os.path.normcase(install_dir)
    except ValueError: userdata_inside_install = False
    if userdata_inside_install:
        raise ValueError('프로그램 폴더 안의 사용자 데이터는 자동 업데이트할 수 없습니다.')
    if plan['profileArg'] not in ('', '--user-data-dir=' + user_dir):
        raise ValueError('프로필 인자가 올바르지 않습니다.')
    # Fail before ready/parent shutdown, then independently reverify at apply.
    with release_file(os.path.join(plan['stageDir'], 'archive.zip')) as archive:
        identity = verify_archive(archive, os.path.join(plan['stageDir'], 'archive.zip'), plan['version'], plan.get('buildID'))
        if plan.get('buildID') != identity['buildID'] or plan['archiveSha256'] != identity['zip']['sha256']:
            raise ValueError('Release install plan identity mismatch.')
    k, parent, mutex = windows_context(plan)
    ui = None
    ui_error = None
    backup = None
    failed = False
    global _install_observer, _install_ready, _install_ui_error
    _install_ready = False
    _install_ui_error = None
    try:
        check_pending(install_dir)
        try:
            ui = ui_factory() if ui_factory else NativeProgress(theme=plan.get('theme', 'dark'))
            if isinstance(ui, NativeProgress):
                if not ui.ready.wait(5) or not ui.hwnd: ui_error = ui.error or '진행 창 준비 실패'
            _install_observer = ui.update
            _install_progress_last[:] = [None, 0.0]
            install_progress('waiting')
        except Exception as error:
            ui_error = str(error)
            _install_observer = None
        print(json.dumps({'ready': True}), flush=True)
        _install_ready = True
        if k.WaitForSingleObject(parent, 120000) != 0:
            raise ValueError('부모 앱 종료를 확인하지 못했습니다.')
        code = wintypes.DWORD()
        if not k.GetExitCodeProcess(parent, byref(code)) or code.value != 0:
            raise ValueError('부모 앱이 정상 종료되지 않았습니다.')
        with open(plan['approvalPath'], encoding='utf-8') as f:
            approval = json.load(f)
        if approval != {'token': plan['approvalToken'], 'graceful': True}:
            raise ValueError('종료 승인이 없습니다.')
        install_progress('validate')
        ensure_no_other_process(k, install_dir)
        check_pending(install_dir)
        backup, journal = apply_files(plan)
        try:
            install_progress('restart')
            args = [os.path.join(install_dir, 'SessionDock.exe')]
            if plan['profileArg']: args.append(plan['profileArg'])
            receipt = plan.get('restartReceipt')
            if receipt is not None:
                validate_owned_root(receipt['root'], receipt['token'], install_dir, user_dir)
                if os.path.normcase(os.path.dirname(os.path.abspath(plan['stageDir']))) != os.path.normcase(receipt['root']): raise ValueError('설치 준비 폴더가 일치하지 않습니다.')
                reject_reparse(receipt['root'], 'restart-receipt.json')
                if os.path.lexists(os.path.join(receipt['root'], 'restart-receipt.json')): raise ValueError('재시작 확인 파일이 이미 존재합니다.')
                args.extend(['--sessiondock-update-root=' + receipt['root'], '--sessiondock-update-token=' + receipt['token']])
            child = subprocess.Popen(args, cwd=install_dir, close_fds=True)
        except Exception as error:
            install_progress('rollback')
            failures = rollback(journal)
            if failures: raise RuntimeError('재시작 복구 실패: 백업 보존 ' + backup) from error
            raise RuntimeError('재시작 실패, 복구 완료. 백업 및 저널: ' + backup) from error
        if receipt is not None:
            status = wait_for_restart(child, receipt, plan['version'])
            if status != 'confirmed':
                if status == 'exited': raise RuntimeError('앱이 다시 시작 직후 종료되었습니다. 백업 및 저널: ' + backup)
                raise RuntimeError('앱 실행 중 시작 확인 시간이 초과되었습니다. 백업 및 저널: ' + backup)
        result = {'ok': True, 'version': plan['version'], 'backupDir': backup, 'journalPath': os.path.join(backup, 'journal.jsonl')}
        if receipt is not None: result['receiptToken'] = receipt['token']
        if ui_error or _install_ui_error: result['uiError'] = ui_error or _install_ui_error
        try:
            write_result(plan['resultPath'], result)
        except Exception as error:
            # The new application is already running; preserve its backup and
            # leave the diagnostic visible instead of rolling it back.
            failed = True
            install_progress('failed', '앱은 시작했지만 결과 기록에 실패했습니다: ' + str(error) + '\n백업: ' + backup)
        else:
            if receipt is not None:
                try:
                    record, raw = read_pending(install_dir)
                    if record['backupDir'] != backup: raise ValueError('미완료 업데이트 기록이 변경되었습니다.')
                    clear_pending(install_dir, raw)
                    schedule_cleanup(plan, receipt)
                except Exception as error:
                    result['cleanupError'] = str(error)
                    try: write_result(plan['resultPath'], result)
                    except Exception as write_error:
                        failed = True
                        install_progress('failed', '정리 오류 기록 실패: ' + str(write_error) + '\n백업: ' + backup)
            if not failed: install_progress('success')
    except Exception as error:
        failed = True
        install_progress('failed', str(error))
        result = {'ok': False, 'error': str(error)}
        if isinstance(plan.get('restartReceipt'), dict): result['receiptToken'] = plan['restartReceipt'].get('token')
        if backup: result['backupDir'] = backup
        if ui_error or _install_ui_error: result['uiError'] = ui_error or _install_ui_error
        try: write_result(plan['resultPath'], result)
        except Exception: pass
        raise
    finally:
        _install_observer = None
        k.CloseHandle(parent); k.CloseHandle(mutex)
        try:
            if isinstance(ui, NativeProgress):
                if failed and ui.hwnd and ui.thread.is_alive(): ui.thread.join()
                else:
                    ui.thread.join(timeout=3)
                    if ui.thread.is_alive(): ui.close()
        except Exception:
            pass


def main():
    command = sys.argv[1] if len(sys.argv) == 2 else ''
    request = json.load(sys.stdin)
    if command == 'scan':
        result = scan(request)
    elif command == 'metadata':
        result = {'version': archive_version(request['path'])}
    elif command == 'normalize':
        if not os.path.isabs(request['folder']): raise ValueError('업데이트 폴더가 올바르지 않습니다.')
        result = {'folder': universal(request['folder'])}
    elif command == 'stage':
        last = [None, 0.0]
        def progress(phase, completed, total, unit, force):
            now = time.monotonic()
            if force or phase != last[0] or now - last[1] >= 0.1:
                print(json.dumps({'type': 'stage-progress', 'phase': phase, 'completed': completed, 'total': total, 'unit': unit}), flush=True)
                last[:] = [phase, now]
        result = stage(request, progress)
    elif command == 'install':
        install(request)
        return
    elif command == 'recover':
        result = recover(request)
    elif command == 'pending':
        check_pending(request['installDir'])
        if 'localTempDir' in request:
            temp = request['localTempDir']
            error = '업데이트 파일을 다운로드하지 못했습니다. 다시 시도해 주세요.'
            if not isinstance(temp, str) or not os.path.isabs(temp) or os.path.normpath(temp) != temp:
                raise ValueError(error)
            require_local_fixed_drive(temp, error)
            reject_reparse(temp)
        result = {'pending': False}
    elif command == 'cleanup':
        request_validated = False
        try:
            validate_owned_root(request['root'], request['token'], request['installDir'], request['userDataDir'], allow_missing=True)
            expected_install = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
            if os.path.normcase(expected_install) != os.path.normcase(os.path.abspath(request['installDir'])):
                raise ValueError('정리 도우미 설치 경로가 일치하지 않습니다.')
            request_validated = True
            cleanup_owned_root(request)
            pending = os.path.join(request['userDataDir'], 'update-cleanup-pending.json')
            try:
                with open(pending, encoding='utf-8') as f: current = json.load(f)
                current.pop('cleanupError', None)
                expected = dict(request); expected.pop('cleanupError', None)
                if current == expected: os.unlink(pending)
            except (OSError, ValueError): pass
        except Exception as error:
            try:
                if not request_validated: return
                pending = os.path.join(request['userDataDir'], 'update-cleanup-pending.json')
                with open(pending, encoding='utf-8') as f: current = json.load(f)
                current.pop('cleanupError', None)
                expected = dict(request); expected.pop('cleanupError', None)
                if current == expected:
                    write_result(pending, {**expected, 'cleanupError': str(error)})
                    result_path = os.path.join(request['userDataDir'], 'update-result.json')
                    try:
                        with open(result_path, encoding='utf-8') as f: result = json.load(f)
                        if result.get('ok') is True and result.get('receiptToken') == request['token']:
                            result['cleanupError'] = str(error); write_result(result_path, result)
                    except (OSError, ValueError): pass
            except Exception: pass
        return
    else:
        raise ValueError('지원하지 않는 업데이트 작업입니다.')
    print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))


if __name__ == '__main__':
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if stream is not None: stream.reconfigure(encoding='utf-8', errors='strict')
    try:
        main()
    except Exception as error:
        if len(sys.argv) != 2 or sys.argv[1] != 'install' or not _install_ready:
            print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
