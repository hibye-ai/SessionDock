"""Window-independent session list and import presentation logic."""

import ipaddress
import re

PAGE_SIZE = 200
ALL = None
UNFILED = ''


def import_columns(count, has_id):
    if count=='auto': return '자동: 헤더 또는 마지막 이름 → 주소 → 프로토콜 → 포트 인식. 앞 열은 폴더. 모호하면 수동 선택.'
    if not 0 <= count <= 16:
        raise ValueError('폴더 열 수는 0~16의 정수여야 합니다.')
    columns = (['ID'] if has_id else []) + [f'폴더 {i}' for i in range(1, count + 1)] + ['이름', '주소', '프로토콜', '포트']
    return f"열 순서 ({len(columns)}열): " + ' → '.join(columns)


def folder_paths(folders, sessions):
    paths = set()
    for path in list(folders) + [s['folder'] for s in sessions]:
        parts = path.split('/') if path else []
        paths.update('/'.join(parts[:i]) for i in range(1, len(parts) + 1))
    return sorted(paths, key=lambda p: (p.count('/'), p.casefold(), p))


def natural(value):
    return tuple((1, int(part), len(part)) if part.isdecimal() else (0, part.casefold()) for part in re.split(r'(\d+)', str(value)))


def host_key(value):
    try:
        address = ipaddress.ip_address(value.strip('[]'))
        return (0, address.version, int(address))
    except ValueError:
        return (1, natural(value))


def list_page(sessions, query='', folder=ALL, sort='name', descending=False, page=0, protocol='all'):
    q = query.strip().casefold()
    def matches(s):
        path = s['folder']
        within = folder is ALL or (not path if folder == UNFILED else path == folder or path.startswith(folder + '/'))
        return within and (protocol == 'all' or s.get('protocol', 'ssh') == protocol) and (not q or q in ' '.join(str(s.get(k, '')) for k in ('name', 'host', 'folder', 'id', 'protocol', 'port')).casefold())
    rows = [s for s in sessions if matches(s)]
    if sort not in ('name', 'host', 'protocol', 'port', 'folder', 'id'):
        raise ValueError('invalid sort column')
    def key(s):
        value = s.get(sort, '')
        return (int(value or 0) if sort == 'port' else host_key(value) if sort == 'host' else natural(value), str(s['id']).casefold())
    rows.sort(key=key, reverse=descending)
    pages = max(1, (len(rows) + PAGE_SIZE - 1) // PAGE_SIZE)
    page = max(0, min(page, pages - 1))
    start = page * PAGE_SIZE
    return {'rows': rows[start:start + PAGE_SIZE], 'total': len(rows), 'page': page, 'pages': pages, 'first': start + 1 if rows else 0, 'last': min(start + PAGE_SIZE, len(rows))}


def import_result(item, choices, lookup):
    """Describe the effective result of one planned row without mutating the catalog."""
    import core
    target = item['target']
    if item['status'] == '확인필요':
        choice = choices.get(item['row'])
        if choice is None:
            return {'status': '확인필요', 'before': None, 'after': None}
        try:
            choice = core.import_choice(choice)
            if choice['action'] == 'skip':
                return {'status': '건너뜀', 'before': None, 'after': None}
            if choice['action'] == 'new':
                target = None
            elif choice['id'] in item['candidates'] and choice['id'] in lookup:
                target = choice['id']
            else:
                return {'status': '확인필요', 'before': None, 'after': None}
        except (ValueError, TypeError):
            return {'status': '확인필요', 'before': None, 'after': None}
    before = lookup.get(target) if target else None
    after = item['profile']
    status = ('추가' if not target else '동일' if before and all(before[k] == after[k] for k in core.FIELDS) else '변경')
    return {'status': status, 'before': before, 'after': after}


def import_summary(plan, choices, catalog=None):
    counts = {name: 0 for name in ('추가', '변경', '동일', '건너뜀', '확인필요')}
    lookup = {s['id']: s for s in catalog['sessions']} if catalog is not None else {}
    for item in plan['items']:
        if catalog is None and item['status'] != '확인필요':
            status = item['status']
        elif catalog is None and item['status'] == '확인필요' and item['row'] in choices:
            import core
            try:
                choice = core.import_choice(choices[item['row']])
                status = {'skip': '건너뜀', 'new': '추가', 'existing': '변경'}[choice['action']]
            except (ValueError, TypeError):
                status = '확인필요'
        else:
            status = import_result(item, choices, lookup)['status']
        counts[status] += 1
    return counts, counts['확인필요']


def import_validation(catalog, plan, choices):
    # Imported lazily to keep simple list rendering independent of core.
    import core
    _, unresolved = import_summary(plan, choices, catalog)
    if unresolved:
        return unresolved, ''
    try:
        core.apply_plan(catalog, plan, choices)
    except (ValueError, TypeError) as exc:
        return 0, str(exc)
    return 0, ''
