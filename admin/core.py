"""SessionDock shared catalog operations. All public inputs are untrusted."""
import copy
import csv
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import uuid
import zipfile

MAX_BYTES = 20 * 1024 * 1024
MAX_SESSIONS = 5000
MAX_FOLDERS = 10000
MAX_ROWS = 10000
MAX_CELLS = 220000
MAX_XLSX_EXPANDED = 100 * 1024 * 1024
FIELDS = ('name', 'host', 'protocol', 'port', 'folder')
SAFE = set(FIELDS) | {'id', 'telnetEnter', 'localEcho', 'username', 'authType', 'favorite', 'tags', 'notes', 'terminalType', 'encoding', 'keymap', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontSize', 'scrollback', 'cursorStyle', 'cursorBlink', 'backspace', 'autoReconnect', 'reconnectDelay', 'reconnectAttempts', 'keepaliveInterval', 'handshakeTimeout', 'logEnabled', 'importWarnings', 'passwordReprompt', 'ctrlArrowMode'}
FIELD_LABELS = {'username':'사용자 이름', 'terminalType':'터미널 형식', 'encoding':'인코딩', 'fontFamily':'글꼴', 'fontWeight':'글꼴 굵기', 'cursorStyle':'커서 모양', 'backspace':'백스페이스 키', 'telnetEnter':'Telnet 엔터 키', 'passwordReprompt':'암호 재입력', 'notes':'메모', 'localEcho':'로컬 에코', 'favorite':'즐겨찾기', 'cursorBlink':'커서 깜빡임', 'autoReconnect':'자동 재접속', 'logEnabled':'로그 기록', 'fontSize':'글꼴 크기', 'scrollback':'스크롤백 줄 수', 'reconnectDelay':'재접속 간격', 'reconnectAttempts':'재접속 횟수', 'keepaliveInterval':'연결 유지 간격', 'handshakeTimeout':'연결 제한 시간', 'lineHeight':'줄 높이', 'letterSpacing':'글자 간격', 'tags':'태그', 'importWarnings':'가져오기 경고'}

class ValidationError(ValueError): pass
class ConflictError(ValidationError): pass

def sha(data): return hashlib.sha256(data).hexdigest()

def normalize_keymap(rows):
    if not isinstance(rows,list) or len(rows)>256: raise ValidationError('키맵이 올바르지 않습니다.')
    names={s.lower():s for s in ('ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Insert','Delete','Backspace','Enter','Escape','Tab','Space')}
    names.update({'up':'ArrowUp','down':'ArrowDown','left':'ArrowLeft','right':'ArrowRight','pgup':'PageUp','pgdn':'PageDown','del':'Delete','esc':'Escape','return':'Enter'})
    mods={'ctrl':'Ctrl','control':'Ctrl','alt':'Alt','shift':'Shift','meta':'Meta'}; seen=set(); out=[]; total=0
    for row in rows:
        if not isinstance(row,dict) or set(row)-{'key','text','enabled'} or not isinstance(row.get('key'),str) or not isinstance(row.get('text'),str) or type(row.get('enabled',True)) is not bool: raise ValidationError('키맵이 올바르지 않습니다.')
        key=row['key']; value=row['text']
        try: keylen=len(key.encode('utf-16-le'))//2; vallen=len(value.encode('utf-16-le'))//2
        except UnicodeError: raise ValidationError('키맵이 올바르지 않습니다.') from None
        if not 1<=keylen<=64 or vallen>4096: raise ValidationError('키맵이 올바르지 않습니다.')
        parts=[p.strip() for p in key.split('+')]
        if len(parts)>5 or not all(parts): raise ValidationError('키맵이 올바르지 않습니다.')
        base=parts.pop()
        if re.fullmatch('[A-Za-z]',base): base=base.upper()
        elif re.fullmatch('Key[A-Za-z]',base,re.I): base=base[-1].upper()
        elif re.fullmatch(r'F(?:[1-9]|1[0-9]|20)',base,re.I): base=base.upper()
        else: base=names.get(base.lower())
        selected=[]
        for part in parts:
            mod=mods.get(part.lower())
            if not mod or mod in selected: raise ValidationError('키맵이 올바르지 않습니다.')
            selected.append(mod)
        if not base: raise ValidationError('키맵이 올바르지 않습니다.')
        ctrl='Ctrl' in selected; alt='Alt' in selected; shift='Shift' in selected
        if base=='F3' or (alt and base=='F4') or (ctrl and base in ('N','K','Tab','F4')) or (ctrl and shift and base in ('C','F')) or (ctrl and not alt and base=='V') or (shift and base=='Insert') or (alt and base in ('Q','G','M','F','E','V','C','T','H')): raise ValidationError('키맵에 예약된 단축키가 있습니다.')
        key='+'.join([m for m in ('Ctrl','Alt','Shift','Meta') if m in selected]+[base])
        if key in seen: raise ValidationError('중복된 키맵 키가 있습니다.')
        seen.add(key); total+=vallen
        if total>65536: raise ValidationError('키맵 전체 크기가 허용 범위를 초과합니다.')
        i=0
        while i<len(value):
            if value[i]!='\\': i+=1; continue
            i+=1
            if i>=len(value): raise ValidationError('키맵 이스케이프가 올바르지 않습니다.')
            c=value[i]; i+=1
            if c in 'rneEtbfv\\': continue
            if c=='x':
                if not re.fullmatch('[0-9a-fA-F]{2}',value[i:i+2]): raise ValidationError('키맵 이스케이프가 올바르지 않습니다.')
                i+=2
            elif c in '01234567':
                octal=c
                while len(octal)<3 and i<len(value) and value[i] in '01234567': octal+=value[i]; i+=1
                if int(octal,8)>255: raise ValidationError('키맵 이스케이프가 올바르지 않습니다.')
            else: raise ValidationError('키맵 이스케이프가 올바르지 않습니다.')
        out.append({'key':key,'text':value,'enabled':row.get('enabled',True)})
    return out

def clean_text(value, label, maximum, empty=True, multiline=False):
    if not isinstance(value, str) or len(value.encode('utf-16-le')) // 2 > maximum:
        raise ValidationError(label + ' 값이 올바르지 않습니다.')
    if any((ord(c) < 32 and (not multiline or c not in '\t\n\r')) or ord(c) == 127 for c in value):
        raise ValidationError(label + ' 값에 제어 문자가 있습니다.')
    value = value if multiline else value.strip()
    if not empty and not value: raise ValidationError(label + ' 값을 입력하세요.')
    return value

def folder(value):
    value = clean_text(value, '폴더', 1024).replace('\\', '/')
    value = re.sub('/+', '/', value).strip('/')
    if any(p in ('.', '..') for p in value.split('/')): raise ValidationError('폴더 경로가 올바르지 않습니다.')
    return value

def profile(source):
    if not isinstance(source, dict): raise ValidationError('세션 형식이 올바르지 않습니다.')
    def present(value): return len(value)>0 if isinstance(value,list) else (True if isinstance(value,dict) else bool(value))
    warnings=[]
    if any(re.search(r'jump|proxy|forward|tunnel', k, re.I) and present(v) for k,v in source.items() if isinstance(k,str)):
        warnings.append('공유 세션은 점프·프록시·포워딩 경로를 지원하지 않아 제거했습니다. 직접 접속 경로를 확인해 주세요.')
    if source.get('authType') in ('key','agent') or any(present(source.get(k)) for k in ('privateKeyPath','keyPath','agentPath','agent')):
        warnings.append('기기별 개인키·에이전트 설정을 제거했습니다. 공유 SSH 세션은 비밀번호로 로그인합니다.')
    p = {k: copy.deepcopy(v) for k, v in source.items() if k in SAFE}
    # Absence inherits the consumer default; do not eagerly rewrite catalogs.
    if 'ctrlArrowMode' in p and p['ctrlArrowMode'] not in ('word', 'native'):
        raise ValidationError('Ctrl+방향키 설정이 올바르지 않습니다.')
    ident = p.get('id', '')
    clean_text(ident, 'ID', 128, False)
    if not re.fullmatch(r'[A-Za-z0-9_-]+', ident) or ident in ('__proto__', 'constructor', 'prototype'): raise ValidationError('ID가 올바르지 않습니다.')
    host = clean_text(p.get('host', ''), '주소', 253, False)
    if host.startswith('[') and host.endswith(']'): host = host[1:-1]
    try: ipaddress.ip_address(host)
    except ValueError:
        if not all(c.isalnum() or c in '_.-' for c in host): raise ValidationError('주소가 올바르지 않습니다.')
    proto = p.get('protocol', 'ssh')
    if proto not in ('ssh', 'telnet'): raise ValidationError('프로토콜이 올바르지 않습니다.')
    port = p.get('port', 23 if proto == 'telnet' else 22)
    if isinstance(port, str) and re.fullmatch(r'\d{1,10}', port): port = int(port)
    if type(port) is not int or not 1 <= port <= 65535: raise ValidationError('포트가 올바르지 않습니다.')
    p.update(id=ident, name=clean_text(p.get('name', host), '이름', 256, False), host=host, protocol=proto, port=port, folder=folder(p.get('folder', '')))
    p['authType'] = 'password' if p.get('authType', 'password') in ('password', 'key', 'agent') else p.get('authType')
    if p['authType'] != 'password': raise ValidationError('인증 설정이 올바르지 않습니다.')
    for k, limit in {'username':256, 'terminalType':64, 'encoding':64, 'fontFamily':128, 'fontWeight':16, 'cursorStyle':12, 'backspace':3, 'telnetEnter':4, 'passwordReprompt':32}.items():
        if k in p: p[k] = clean_text(p[k], FIELD_LABELS[k], limit)
    if 'encoding' in p:
        aliases={'utf8':'utf-8','cp949':'cp949','windows949':'cp949','ms949':'cp949','uhc':'cp949','euckr':'euc-kr','shiftjis':'shift_jis','sjis':'shift_jis','cp932':'shift_jis','windows31j':'shift_jis','gb18030':'gb18030','big5':'big5','bigfive':'big5'}
        normalized=aliases.get(p['encoding'].lower().replace('-','').replace('_',''))
        if not normalized: raise ValidationError('인코딩 설정이 올바르지 않습니다.')
        p['encoding']=normalized
    if 'notes' in p: p['notes'] = clean_text(p['notes'], FIELD_LABELS['notes'], 16384, multiline=True)
    for k in ('localEcho','favorite','cursorBlink','autoReconnect','logEnabled'):
        if k in p and type(p[k]) is not bool: raise ValidationError(FIELD_LABELS[k] + ' 설정이 올바르지 않습니다.')
    for k, (low, high) in {'fontSize':(0,48),'scrollback':(0,100000),'reconnectDelay':(1,300),'reconnectAttempts':(1,10),'keepaliveInterval':(0,86400),'handshakeTimeout':(5,300)}.items():
        if k in p:
            v=p[k]
            if isinstance(v,str) and re.fullmatch(r'\d{1,10}',v): v=int(v)
            if type(v) is not int or not low <= v <= high or (k=='fontSize' and 0<v<10) or (k=='scrollback' and 0<v<1000): raise ValidationError(FIELD_LABELS[k] + ' 설정이 올바르지 않습니다.')
            p[k]=v
    for k, allowed in {'fontWeight':('', 'normal','bold'),'cursorStyle':('bar','block','underline'),'backspace':('del','bs'),'telnetEnter':('cr','crlf'),'passwordReprompt':('fresh-connection','allow-inline')}.items():
        if k in p and p[k] not in allowed: raise ValidationError(FIELD_LABELS[k] + ' 설정이 올바르지 않습니다.')
    for k, lo, hi, inherit in [('lineHeight',1,2,0),('letterSpacing',0,5,-1)]:
        if k in p:
            v=p[k]
            if isinstance(v,str) and re.fullmatch(r'-?\d+(?:\.\d{1,2})?',v): v=float(v)
            if type(v) not in (int,float) or not (v==inherit or lo<=v<=hi): raise ValidationError(FIELD_LABELS[k] + ' 설정이 올바르지 않습니다.')
            p[k]=v
    if 'fontFamily' in p and re.search(r'["\\,;{}<>]',p['fontFamily']): raise ValidationError('글꼴이 올바르지 않습니다.')
    if 'terminalType' in p and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.+\-]*',p['terminalType']): raise ValidationError('터미널 형식이 올바르지 않습니다.')
    for k, count, size in [('tags',64,128),('importWarnings',64,2048)]:
        if k in p:
            if not isinstance(p[k],list) or len(p[k])>count: raise ValidationError(FIELD_LABELS[k] + ' 설정이 올바르지 않습니다.')
            p[k]=list(dict.fromkeys(clean_text(x,FIELD_LABELS[k],size,False) for x in p[k]))
    if warnings:
        p['importWarnings']=list(dict.fromkeys(warnings+p.get('importWarnings',[])))[:64]
    if 'keymap' in p and p['keymap'] is not None:
        p['keymap']=normalize_keymap(p['keymap'])
    return p

def validate_catalog(value):
    if not isinstance(value,dict) or type(value.get('version')) is not int or value.get('version') != 1 or not isinstance(value.get('sessions'),list) or not isinstance(value.get('folders',[]),list) or not isinstance(value.get('snippets',[]),list): raise ValidationError('올바른 SessionDock 공유 JSON 파일(버전 1)이 아닙니다.')
    if len(value['sessions'])>MAX_SESSIONS or len(value.get('folders',[]))>MAX_FOLDERS: raise ValidationError('세션은 최대 5,000개, 폴더는 최대 10,000개까지 지원합니다.')
    sessions=[profile(s) for s in value['sessions']]
    if len({s['id'] for s in sessions}) != len(sessions): raise ValidationError('중복 ID가 있습니다.')
    paths=set()
    for f in value.get('folders',[]) + [s['folder'] for s in sessions]:
        parts=folder(f).split('/')
        for i in range(1,len(parts)+1):
            path='/'.join(parts[:i])
            if path: paths.add(path)
            if len(paths)>MAX_FOLDERS: raise ValidationError('폴더는 최대 10,000개까지 지원합니다.')
    return {'version':1,'folders':sorted(paths),'sessions':sessions,'snippets':[]}

def read_bytes(path, optional=False):
    try:
        st=os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_size>MAX_BYTES: raise ValidationError('파일 크기가 20 MiB를 초과하거나 일반 파일이 아닙니다.')
        with open(path,'rb') as f:
            opened=os.fstat(f.fileno())
            if (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)!=(opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns): raise ConflictError('파일이 변경되었습니다.')
            data=f.read(MAX_BYTES+1); after=os.fstat(f.fileno())
            if len(data)>MAX_BYTES or (opened.st_size,opened.st_mtime_ns)!=(after.st_size,after.st_mtime_ns) or len(data)!=after.st_size: raise ConflictError('파일을 읽는 동안 변경되었습니다.')
        return data
    except FileNotFoundError:
        if optional: return None
        raise

def load_catalog(path):
    data=read_bytes(path)
    try: value=json.loads(data.decode('utf-8-sig'))
    except (ValueError,UnicodeError): raise ValidationError('UTF-8 형식의 JSON 파일을 읽을 수 없습니다.') from None
    return validate_catalog(value), sha(data)

def encode_catalog(catalog):
    data=(json.dumps(validate_catalog(catalog),ensure_ascii=False,indent=2,allow_nan=False)+'\n').encode('utf-8')
    if len(data)>MAX_BYTES: raise ValidationError('게시 파일이 20 MiB를 초과합니다.')
    return data

def _atomic(path,data,before_replace=None):
    fd,tmp=tempfile.mkstemp(prefix='.sessiondock-',suffix='.tmp',dir=str(Path(path).parent))
    try:
        with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
        if before_replace: before_replace()
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def export_tsv(path, catalog, protected_paths=()):
    """Export only safe text; refuse formula-leading cells instead of altering data."""
    target=Path(path).absolute()
    if target.suffix.lower() != '.tsv': raise ValidationError('TSV 확장자를 사용하세요.')
    def verify_target():
        for protected in protected_paths:
            if not protected: continue
            other=Path(protected).absolute()
            if os.path.normcase(os.path.realpath(target)) == os.path.normcase(os.path.realpath(other)):
                raise ValidationError('사용 중인 파일에는 내보낼 수 없습니다.')
            try:
                if os.path.samefile(target,other): raise ValidationError('사용 중인 파일에는 내보낼 수 없습니다.')
            except FileNotFoundError: pass
        try: info=os.lstat(target)
        except FileNotFoundError: return None
        if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1: raise ValidationError('일반 TSV 파일을 선택하세요.')
        with open(target,'rb') as f:
            opened=os.fstat(f.fileno()); head=f.read(4096)
        identity=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)
        if identity(info)!=identity(opened): raise ConflictError('내보내기 대상이 변경되었습니다.')
        trimmed=head.removeprefix(b'\xef\xbb\xbf').lstrip()
        if head.startswith(b'SQLite format 3\x00') or trimmed.startswith((b'{',b'[')): raise ValidationError('JSON 또는 SQLite 파일에는 내보낼 수 없습니다.')
        return identity(info)
    initial=verify_target()
    output=io.StringIO(newline=''); writer=csv.writer(output,delimiter='\t',lineterminator='\n')
    writer.writerow(['ID','폴더','이름','주소','프로토콜','포트'])
    for index,s in enumerate(validate_catalog(catalog)['sessions'],1):
        values=[str(s[k]) for k in ('id','folder','name','host','protocol','port')]
        if any(value.lstrip().startswith(('=','+','-','@')) for value in values):
            raise ValidationError(f'{index}번 세션에 스프레드시트 수식으로 해석되는 값이 있습니다. 수정 후 내보내세요.')
        writer.writerow(values)
    data=output.getvalue().encode('utf-8-sig')
    if len(data)>MAX_BYTES: raise ValidationError('TSV 파일이 20 MiB를 초과합니다.')
    def before_replace():
        if verify_target()!=initial: raise ConflictError('내보내기 대상이 변경되었습니다.')
    _atomic(target,data,before_replace)

def publish(path, catalog, expected_revision):
    target=Path(path).absolute()
    if target.suffix.lower()!='.json': raise ValidationError('JSON(.json) 파일 경로를 지정하세요.')
    data=encode_catalog(catalog)
    lock=target.parent / ('.sessiondock-publish-'+sha(target.name.lower().encode('utf-8'))+'.lock')
    try: os.mkdir(lock)
    except FileExistsError: raise ConflictError('다른 게시 작업이 진행 중입니다.') from None
    marker=lock / (str(uuid.uuid4())+'.json'); lockstat=os.lstat(lock)
    markerstat=None
    def verify():
        a=os.lstat(lock); b=os.lstat(marker)
        if not stat.S_ISDIR(a.st_mode) or not stat.S_ISREG(b.st_mode) or (a.st_dev,a.st_ino)!=(lockstat.st_dev,lockstat.st_ino) or markerstat is None or (b.st_dev,b.st_ino)!=(markerstat.st_dev,markerstat.st_ino): raise ConflictError('게시 잠금이 변경되었습니다.')
    try:
        with open(marker,'x',encoding='utf-8') as f:
            markerstat=os.fstat(f.fileno())
            json.dump({'token':marker.stem,'pid':os.getpid()},f); f.flush(); os.fsync(f.fileno())
        current=read_bytes(target,True)
        if (sha(current) if current is not None else None)!=expected_revision: raise ConflictError('공유 파일이 변경되었습니다. 다시 열어 주세요.')
        if current is not None:
            try: validate_catalog(json.loads(current.decode('utf-8-sig')))
            except (ValueError,UnicodeError): raise ValidationError('기존 JSON을 검증할 수 없어 게시하지 않았습니다.') from None
            backup=target.parent / (target.name+'.'+str(uuid.uuid4())+'.bak.json')
            verify()
            with open(backup,'xb') as f: f.write(current); f.flush(); os.fsync(f.fileno())
            if read_bytes(backup)!=current: raise ValidationError('백업 검증에 실패했습니다.')
        def pre_replace():
            verify()
            again=read_bytes(target,True)
            if (sha(again) if again is not None else None)!=expected_revision: raise ConflictError('게시 중 파일이 변경되었습니다.')
            verify()
        _atomic(target,data,pre_replace)
        return sha(data)
    finally:
        try:
            if markerstat is not None:
                verify(); marker.unlink(); os.rmdir(lock)
            elif not marker.exists():
                info=os.lstat(lock)
                if stat.S_ISDIR(info.st_mode) and (info.st_dev,info.st_ino)==(lockstat.st_dev,lockstat.st_ino): os.rmdir(lock)
        except (OSError,ConflictError): pass

def row_profile(row):
    r=dict(row); r['id']=r.get('id') or str(uuid.uuid4()); return profile(r)

def key(s): return tuple(str(s[k]).casefold() for k in FIELDS)
def endpoint(s):
    host=s['host']
    try:
        address=ipaddress.ip_address(host)
        if isinstance(address,ipaddress.IPv6Address): host=str(address)
        else: host=host.casefold()
    except ValueError: host=host.casefold()
    return (host,s['protocol'],s['port'])
def named(s): return (s['name'].casefold(),s['folder'].casefold())

def replace_catalog(catalog, rows):
    """Validate a complete replacement without modifying the current catalog."""
    validate_catalog(catalog)
    if not isinstance(rows, list) or not rows: raise ValidationError('적용할 데이터 행이 없습니다. 첫 행 제목 설정을 확인하세요.')
    if len(rows)>MAX_ROWS: raise ValidationError('입력 행은 최대 10,000행까지 지원합니다.')
    prepared=[]; explicit_ids=set()
    for index,row in enumerate(rows,1):
        i=row.get('_row_number',index) if isinstance(row,dict) else index
        try:
            if not isinstance(row,dict): raise ValidationError('행 형식이 올바르지 않습니다.')
            explicit=bool(row.get('id')); p=row_profile(row)
        except (ValidationError,TypeError,ValueError) as e: raise ValidationError(f'{i}행: {e}') from None
        if explicit:
            if p['id'] in explicit_ids: raise ValidationError(f'{i}행: ID {p["id"]}가 중복됩니다. 각 행에 서로 다른 ID를 입력하세요.')
            explicit_ids.add(p['id'])
        prepared.append((p,explicit))
    used=set(explicit_ids); sessions=[]
    for p,explicit in prepared:
        if not explicit:
            while p['id'] in used: p['id']=str(uuid.uuid4())
            used.add(p['id'])
        sessions.append(p)
    return validate_catalog({'version':1,'sessions':sessions,'folders':[],'snippets':[]})

def plan_merge(catalog, rows):
    base=validate_catalog(catalog); sessions=base['sessions']; byid={s['id']:s for s in sessions}
    exact={}; ends={}; names={}
    for s in sessions:
        for index,k in ((exact,key(s)),(ends,endpoint(s)),(names,named(s))): index.setdefault(k,[]).append(s['id'])
    prepared=[]; seen=set(); duplicate=0; new_ids={}
    if len(rows)>MAX_ROWS: raise ValidationError('입력 행은 최대 10,000행까지 지원합니다.')
    for i,row in enumerate(rows):
        row_number=row.get('_row_number',i+1) if isinstance(row,dict) else i+1
        try: p=row_profile(row); explicit=bool(row.get('id'))
        except (ValidationError,TypeError,ValueError) as e: raise ValidationError(f'{row_number}행: {e}') from None
        signature=(key(p),p['id'] if explicit else None)
        if explicit and p['id'] not in byid:
            if p['id'] in new_ids and new_ids[p['id']]!=signature:
                raise ValidationError(f'{row_number}행: ID {p["id"]}가 중복됩니다. 각 행에 서로 다른 ID를 입력하세요.')
            new_ids[p['id']]=signature
        if signature in seen: duplicate+=1; continue
        seen.add(signature); prepared.append({'row':row_number,'profile':p,'explicit':explicit})
    reserved=set()
    for item in prepared:
        p=item['profile']; matches=exact.get(key(p),[])
        if item['explicit'] and p['id'] in byid: reserved.add(p['id'])
        elif not item['explicit'] and len(matches)==1: reserved.add(matches[0])
    claimed=set(); result=[]
    for item in prepared:
        p=item['profile']; matches=exact.get(key(p),[]); candidates=[]; status='추가'; target=None
        if item['explicit']:
            if p['id'] in byid: target=p['id']; status='동일' if all(byid[target][k]==p[k] for k in FIELDS) else '변경'
        elif len(matches)==1: target=matches[0]; status='동일' if all(byid[target][k]==p[k] for k in FIELDS) else '변경'
        elif len(matches)>1: candidates=matches; status='확인필요'
        else:
            a=ends.get(endpoint(p),[]); b=names.get(named(p),[])
            possible=list(dict.fromkeys(a+b))
            available=[x for x in possible if x not in reserved]
            if len(available)==1 and len(possible)==1: target=available[0]; status='변경'
            elif available or (possible and not all(x in reserved for x in possible)): candidates=possible; status='확인필요'
        if target and target in claimed: candidates=[target]; target=None; status='확인필요'
        if target: claimed.add(target)
        result.append({'row':item['row'],'profile':p,'status':status,'target':target,'candidates':candidates,'explicit':item['explicit']})
    return {'items':result,'duplicates':duplicate,'base':sha(encode_catalog(base))}

def import_choice(choice):
    """Normalize an import resolution; legacy command strings remain supported."""
    if isinstance(choice, str):
        if choice in ('skip', 'new'): return {'action':choice}
        if choice: return {'action':'existing', 'id':choice}
    elif type(choice) is dict:
        action=choice.get('action')
        if action in ('skip', 'new') and set(choice)=={'action'}: return {'action':action}
        if action=='existing' and set(choice)=={'action','id'} and isinstance(choice['id'],str) and choice['id']:
            return {'action':'existing', 'id':choice['id']}
    raise ValidationError('행 처리 선택이 올바르지 않습니다.')

def apply_plan(catalog, plan, resolutions=None):
    base=validate_catalog(catalog)
    if plan.get('base')!=sha(encode_catalog(base)): raise ConflictError('미리보기 생성 후 목록이 변경되었습니다.')
    resolutions=resolutions or {}; sessions=copy.deepcopy(base['sessions']); byid={s['id']:i for i,s in enumerate(sessions)}; claimed=set()
    for item in plan['items']:
        target=item['target']; action=item['status']; choice=resolutions.get(item['row']); intentional_new=False
        if action=='확인필요':
            if choice is None: raise ValidationError('처리하지 않은 확인 필요 행이 있습니다.')
            choice=import_choice(choice)
            if choice['action']=='skip': continue
            if choice['action']=='new': target=None; intentional_new=True
            elif choice['id'] in item['candidates'] and choice['id'] in byid: target=choice['id']
            else: raise ValidationError('행 처리 선택이 올바르지 않습니다.')
        if target:
            if target in claimed: raise ValidationError('같은 기존 세션을 여러 행에 지정할 수 없습니다.')
            claimed.add(target); old=sessions[byid[target]]; old.update({k:item['profile'][k] for k in FIELDS})
        else:
            new=copy.deepcopy(item['profile'])
            if new['id'] in byid:
                if item.get('explicit') and not intentional_new: raise ValidationError(f'{item["row"]}행: ID {new["id"]}가 중복됩니다. 각 행에 서로 다른 ID를 입력하세요.')
                while new['id'] in byid: new['id']=str(uuid.uuid4())
            byid[new['id']]=len(sessions); sessions.append(new)
    return validate_catalog({'version':1,'sessions':sessions,'folders':base['folders'],'snippets':[]})

def table_schema():
    import sys
    root=Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent.parent))
    return json.loads((root/'assets/session-table-schema.json').read_text(encoding='utf-8'))

def auto_table(table, include_row_numbers=False):
    rows=[]
    for n,row in enumerate(table,1):
        values=[str(x).strip().lstrip('\ufeff') if x is not None else '' for x in row]
        while values and not values[-1]: values.pop()
        if len(values)>22: raise ValidationError('열이 너무 많습니다. 폴더 열 수를 수동으로 선택하세요.')
        if any(values): rows.append((n,values))
        if n>MAX_ROWS+1: raise ValidationError('입력 행은 최대 10,000행까지 지원합니다.')
    if not rows: return []
    aliases=table_schema()['aliases']; mapping={}; folders=[]; unknown=[]
    for i,value in enumerate(rows[0][1]):
        key=re.sub(r'[\s_-]+','',value.lower())
        field=next((f for f,names in aliases.items() if key in names),None)
        if re.fullmatch(r'(folder|폴더)[1-9][0-9]*',key): field='folder'
        if field=='folder': folders.append(i)
        elif field:
            if field in mapping: raise ValidationError('중복 헤더가 모호합니다. 폴더 열 수를 수동으로 선택하세요.')
            mapping[field]=i
        elif value: unknown.append(i)
    has_header=all(k in mapping for k in ('name','host','protocol','port'))
    if not has_header:
        # Only infer the final four explicit fields, never search for a plausible IP.
        widths={len(v) for _,v in rows}
        if len(widths)!=1 or not 4<=len(rows[0][1])<=20:
            raise ValidationError('열 수가 일관되지 않습니다. 폴더 열 수를 수동으로 선택하세요.')
        width=len(rows[0][1]); folders=list(range(width-4)); mapping=dict(zip(('name','host','protocol','port'),range(width-4,width)))
        unknown=[]
        if any(v[-2].lower() not in ('ssh','telnet') or not re.fullmatch(r'[0-9]{1,5}',v[-1]) for _,v in rows):
            raise ValidationError('마지막 이름·주소·프로토콜·포트를 확인하세요. 폴더 열 수를 수동으로 선택하세요.')
    if unknown or len(folders)>16: raise ValidationError('알 수 없는 헤더가 있습니다. 폴더 열 수를 수동으로 선택하세요.')
    if has_header and len({rows[0][1][i].lower() for i in folders})!=len(folders):
        raise ValidationError('중복 폴더 헤더가 모호합니다. 폴더 열 수를 수동으로 선택하세요.')
    result=[]; used=set(mapping.values())|set(folders)
    for n,values in (rows[1:] if has_header else rows):
        if any(v for i,v in enumerate(values) if i not in used): raise ValidationError(f'{n}행: 이름 없는 열에 데이터가 있습니다. 수동 설정을 확인하세요.')
        get=lambda i: values[i] if i<len(values) else ''
        item={k:get(i) for k,i in mapping.items()}; item['folder']='/'.join(get(i) for i in folders if get(i))
        item['protocol']=(item['protocol'] or 'ssh').lower(); item['port']=item['port'] or ('23' if item['protocol']=='telnet' else '22')
        if not item.get('id'): item.pop('id',None)
        if include_row_numbers: item['_row_number']=n
        try:
            validate_table_host(item['host'])
            row_profile(item)
        except ValidationError as e: raise ValidationError(f'{n}행: {e}') from None
        result.append(item)
    return result

def rows_from_table(table, folder_count='auto', header=True, has_id=False, include_row_numbers=False):
    if folder_count=='auto': return auto_table(table,include_row_numbers)
    if type(folder_count) is not int or not 0<=folder_count<=16: raise ValidationError('폴더 열 수는 자동 또는 0~16의 정수여야 합니다.')
    result=[]
    for n,row in enumerate(table):
        if header and n==0: continue
        values=[str(x).strip() if x is not None else '' for x in row]
        if not any(values): continue
        need=folder_count+4+(1 if has_id else 0)
        if any(values[need:]): raise ValidationError(f'{n+1}행: 설정한 열 수보다 데이터가 많습니다. 폴더 열 수를 확인하세요.')
        if len(values)<need: values += ['']*(need-len(values))
        offset=1 if has_id else 0
        name,host,proto,port=values[offset+folder_count:offset+folder_count+4]
        proto=(proto or 'ssh').lower(); port=port or ('23' if proto=='telnet' else '22')
        item={'name':name,'host':host,'protocol':proto,'port':port,'folder':'/'.join(v for v in values[offset:offset+folder_count] if v)}
        if has_id and values[0]: item['id']=values[0]
        if include_row_numbers: item['_row_number']=n+1
        try: row_profile(item)
        except ValidationError as e: raise ValidationError(f'{n+1}행: {e}') from None
        result.append(item)
        if len(result)>MAX_ROWS: raise ValidationError('입력 행은 최대 10,000행까지 지원합니다.')
    return result

def validate_table_host(host):
    host=host.removeprefix('[').removesuffix(']')
    try: ipaddress.ip_address(host); return
    except ValueError: pass
    if re.fullmatch(r'[0-9.]+',host) or len(host)>253 or not all(re.fullmatch(r'[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?',p) for p in host.rstrip('.').split('.')):
        raise ValidationError('주소가 올바르지 않습니다.')

def sample_csv():
    schema=table_schema(); out=io.StringIO(newline=''); writer=csv.writer(out,lineterminator='\r\n')
    writer.writerow(schema['headers']); writer.writerows(schema['sampleRows'])
    return out.getvalue().encode('utf-8-sig')

def read_csv(data, folder_count='auto', header=True, has_id=False, include_row_numbers=False):
    if len(data.encode('utf-8'))>MAX_BYTES: raise ValidationError('입력 텍스트가 20 MiB를 초과합니다.')
    try: return rows_from_table(csv.reader(io.StringIO(data.lstrip('\ufeff'),newline=''),strict=True),folder_count,header,has_id,include_row_numbers)
    except csv.Error: raise ValidationError('CSV 따옴표 형식이 올바르지 않습니다.') from None

def read_tsv(data, folder_count='auto', header=True, has_id=False, include_row_numbers=False):
    if len(data.encode('utf-8'))>MAX_BYTES: raise ValidationError('입력 텍스트가 20 MiB를 초과합니다.')
    try: return rows_from_table(csv.reader(io.StringIO(data.lstrip('\ufeff'),newline=''),delimiter='\t',strict=True),folder_count,header,has_id,include_row_numbers)
    except csv.Error: raise ValidationError('TSV 따옴표 형식이 올바르지 않습니다.') from None

def inspect_xlsx(path):
    if os.path.getsize(path)>MAX_BYTES: raise ValidationError('엑셀 파일이 20 MiB를 초과합니다.')
    with zipfile.ZipFile(path) as z:
        entries=z.infolist()
        if len(entries)>10000 or sum(x.file_size for x in entries)>MAX_XLSX_EXPANDED or any(x.file_size>MAX_XLSX_EXPANDED or (x.file_size>1024*1024 and x.file_size>max(1,x.compress_size)*200) for x in entries): raise ValidationError('엑셀 압축 파일이 허용 범위를 초과합니다. 파일 수와 압축 해제 크기를 확인하세요.')
    from openpyxl import load_workbook
    return load_workbook(path,read_only=True,data_only=False,keep_links=False)

def read_xlsx(path, sheet, folder_count='auto', header=True, has_id=False):
    if folder_count!='auto' and (type(folder_count) is not int or not 0<=folder_count<=16): raise ValidationError('폴더 열 수는 0~16의 정수여야 합니다.')
    wb=inspect_xlsx(path)
    try:
        if sheet not in wb.sheetnames: raise ValidationError('시트를 찾을 수 없습니다.')
        # Stream sparse XML cells instead of expanding the worksheet dimension.
        # This also checks cells beyond the configured width, even with a false dimension.
        from openpyxl.xml.functions import iterparse
        from openpyxl.utils.cell import column_index_from_string
        from openpyxl.worksheet._reader import WorkSheetParser
        ws=wb[sheet]; width=22 if folder_count=='auto' else folder_count+4+(1 if has_id else 0)
        parser=WorkSheetParser(None,ws._shared_strings,epoch=wb.epoch,date_formats=wb._date_formats,timedelta_formats=wb._timedelta_formats)
        ns='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
        table=[]; row_number=0; current=0; column=0; count=0; values=None
        with wb._archive.open(ws._worksheet_path) as source:
            for event,element in iterparse(source,events=('start','end')):
                if event=='start' and element.tag==ns+'row':
                    current=int(element.get('r',row_number+1)); column=0
                    if current<=row_number or current>MAX_ROWS+int(header): raise ValidationError('엑셀 행 번호가 올바르지 않거나 행이 너무 많습니다.')
                    if current*width>MAX_CELLS: raise ValidationError('엑셀 셀은 최대 220,000개까지 지원합니다.')
                    values=[None]*width
                elif event=='end' and element.tag==ns+'c':
                    if values is None: raise ValidationError('엑셀 셀 위치가 올바르지 않습니다.')
                    count+=1
                    if count>MAX_CELLS: raise ValidationError('엑셀 셀은 최대 220,000개까지 지원합니다.')
                    coordinate=element.get('r')
                    if coordinate:
                        match=re.fullmatch(r'([A-Za-z]{1,3})([1-9][0-9]*)',coordinate)
                        if not match or int(match.group(2))!=current: raise ValidationError('엑셀 셀 위치가 올바르지 않습니다.')
                        col=column_index_from_string(match.group(1).upper())
                    else: col=column+1
                    if col<=column or col>16384: raise ValidationError('엑셀 셀 위치가 올바르지 않습니다.')
                    column=col; formula=element.find(ns+'f') is not None
                    if formula and (col<=width or not (header and current==1)): raise ValidationError(f'{current}행에 수식이 있습니다. 값으로 변환해 주세요.')
                    parser.row_counter=current; parser.col_counter=col-1
                    value=None if formula else parser.parse_cell(element)['value']
                    if col>width:
                        if not (header and current==1) and value is not None and str(value).strip(): raise ValidationError(f'{current}행: 설정한 열 수보다 데이터가 많습니다. 폴더 열 수를 확인하세요.')
                    else: values[col-1]=value
                    element.clear()
                elif event=='end' and element.tag==ns+'row':
                    table.extend([[] for _ in range(current-row_number-1)]); table.append(values)
                    row_number=current; values=None; element.clear()
        if folder_count=='auto':
            width=max((i+1 for row in table for i,v in enumerate(row) if v is not None and str(v).strip()),default=0)
            table=[row[:width] for row in table]
        return rows_from_table(table,folder_count,header,has_id)
    finally: wb.close()

class Project:
    def __init__(self,path):
        self.path=Path(path).absolute(); self.db=sqlite3.connect(self.path)
        self.db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), catalog TEXT NOT NULL, source TEXT, revision TEXT, dirty INTEGER NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS local_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)')
        self.db.execute('INSERT OR IGNORE INTO local_revision VALUES (1,0)'); self.db.commit()
        self.db.execute('BEGIN')
        try: self._snapshot=self._read_snapshot()
        finally: self.db.rollback()
    def _read_snapshot(self):
        return (self.db.execute('SELECT catalog,source,revision,dirty FROM state WHERE id=1').fetchone(),
                self.db.execute('SELECT revision FROM local_revision WHERE id=1').fetchone()[0])
    def save(self,catalog,source=None,revision=None,dirty=True):
        encoded=encode_catalog(catalog).decode('utf-8')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self._read_snapshot()!=self._snapshot: raise ConflictError('로컬 작업이 다른 창에서 변경되었습니다. 파일 메뉴의 최신 작업 다시 불러오기를 사용하세요.')
            self.db.execute('INSERT OR REPLACE INTO state VALUES (1,?,?,?,?)',(encoded,source,revision,int(dirty)))
            self.db.execute('UPDATE local_revision SET revision=revision+1 WHERE id=1')
            updated=self._read_snapshot(); self.db.commit(); self._snapshot=updated
        except Exception:
            self.db.rollback(); raise
    def load(self):
        r=self.db.execute('SELECT catalog,source,revision,dirty FROM state WHERE id=1').fetchone()
        return (validate_catalog(json.loads(r[0])),r[1],r[2],bool(r[3])) if r else None
    def reload(self):
        self.db.execute('BEGIN')
        try:
            snapshot=self._read_snapshot(); r=snapshot[0]
            result=(validate_catalog(json.loads(r[0])),r[1],r[2],bool(r[3])) if r else None
            self.db.commit()
        except Exception:
            self.db.rollback(); raise
        self._snapshot=snapshot
        return result
    def close(self): self.db.close()
