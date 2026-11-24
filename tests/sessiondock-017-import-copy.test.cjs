'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const EXPECTED_BUTTONS = [
  {
    id: 'import-securecrt',
    icon: 'folder',
    strong: 'SecureCRT 폴더 가져오기',
    p: 'Config 또는 Sessions 폴더에서 세션을 불러옵니다.',
    route: 'securecrt',
  },
  {
    id: 'import-windterm',
    icon: 'import',
    strong: 'WindTerm 파일 가져오기',
    p: 'WindTerm 프로필의 세션 파일을 불러옵니다.',
    route: 'windterm',
  },
  {
    id: 'import-putty',
    icon: 'server',
    strong: 'PuTTY 레지스트리 가져오기 (이 PC)',
    p: '이 PC 레지스트리에 저장된 PuTTY 세션을 바로 불러옵니다.',
    route: 'putty',
  },
  {
    id: 'import-putty-file',
    icon: 'file',
    strong: 'PuTTY 파일 가져오기 (.reg)',
    p: '레지스트리에서 내보낸 PuTTY .reg 파일을 불러옵니다.',
    route: 'putty-file',
  },
  {
    id: 'import-file',
    icon: 'file',
    strong: 'SessionDock·SecureCRT 파일 가져오기',
    p: 'SessionDock(JSON)·SecureCRT(XML)에서 내보낸 파일을 불러옵니다.',
    route: 'file',
  },
];

const REMOVED_OLD_STRINGS = [
  'SecureCRT 설정 폴더',
  'Config 또는 Sessions 폴더에서 세션을 가져옵니다.',
  'WindTerm 세션 파일',
  'PuTTY · 이 PC',
  '이 PC의 PuTTY에 저장된 세션을 바로 불러옵니다.',
  'PuTTY 내보내기 파일 (.reg)',
  '내보낸 PuTTY 레지스트리 파일을 불러옵니다.',
  'SessionDock·SecureCRT 내보내기 파일',
  '내보낸 세션 파일(JSON·XML)을 불러옵니다.',
];

test('import buttons expose exact approved strong/p microcopy, order and DOM attributes', () => {
  const html = read('src/renderer/index.html');
  const sectionMatch = html.match(
    /<section data-settings-panel="sessions" class="hidden session-data-actions">([\s\S]*?)<\/section>/
  );
  assert.ok(sectionMatch, 'sessions settings panel missing');
  const section = sectionMatch[1];

  const importButtons = [...section.matchAll(
    /<button type="button" id="(import-[a-z-]+)" class="import-option"><span data-icon="([^"]+)"><\/span><div><strong>([^<]+)<\/strong><p>([^<]+)<\/p><\/div><span class="import-chevron" aria-hidden="true" data-icon="folderChevron"><\/span><\/button>/g
  )].map(m => ({ id: m[1], icon: m[2], strong: m[3], p: m[4] }));

  assert.deepEqual(
    importButtons,
    EXPECTED_BUTTONS.map(({ id, icon, strong, p }) => ({ id, icon, strong, p }))
  );

  for (const { id } of EXPECTED_BUTTONS) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `duplicate or missing id: ${id}`);
  }
  for (const oldText of REMOVED_OLD_STRINGS) {
    assert.equal(html.includes(oldText), false, `old import text remains: ${oldText}`);
  }
});

test('export, CSV controls, routes, preload/main IPC and 0.1.8 metadata remain intact', () => {
  const html = read('src/renderer/index.html');
  const app = read('src/renderer/app.js');
  const preload = read('src/preload.cjs');
  const main = read('src/main.cjs');
  const pkg = JSON.parse(read('package.json'));

  assert.ok(html.includes('<h3>세션 가져오기</h3>'));
  assert.ok(html.includes('<h3>CSV 양식</h3>'));
  assert.ok(html.includes('id="save-sample-csv"'));
  assert.ok(html.includes('id="import-csv"'));
  assert.ok(html.includes('<h3>세션 내보내기</h3>'));
  assert.ok(
    html.includes(
      '<button type="button" id="export-sessions" class="import-option"><span data-icon="export"></span><div><strong>SessionDock JSON으로 내보내기</strong><p>세션, 폴더, 버튼 바를 파일로 저장합니다.</p></div><span class="import-chevron" aria-hidden="true" data-icon="folderChevron"></span></button>'
    )
  );

  for (const { id, route } of EXPECTED_BUTTONS) {
    assert.ok(
      app.includes(`listen('${id}',()=>importSessions('${route}'))`),
      `missing renderer route for ${id} -> ${route}`
    );
  }
  assert.ok(app.includes("listen('export-sessions',exportSessions)"));
  assert.ok(preload.includes("importSessions: invoke('sessions:import')"));
  assert.ok(preload.includes("exportSessions: invoke('sessions:export')"));
  assert.ok(main.includes("handle('sessions:import'"));
  for (const route of ['securecrt', 'putty', 'putty-file', 'windterm', 'file']) {
    assert.ok(main.includes(`'${route}'`), `main missing import kind ${route}`);
  }
  assert.equal(pkg.version, '0.1.8');
  assert.equal(
    pkg.sessionDockReleaseNotes,
    '공식 웹 업데이트와 공유 세션 게시를 추가했습니다.\n장비 비밀번호는 저장하지 않고 연결할 때마다 입력합니다.'
  );
});
