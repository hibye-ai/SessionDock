'use strict';

/*
 * 편집 가능한 단축키 카탈로그 (데이터 전용, 부작용/의존성 없음).
 *
 * sequence: 물리 키 코드 기준. 수정자 순서는 Ctrl+Alt+Shift, 두 단계 시퀀스는 ' then '로 구분.
 * contexts 비트마스크: APP=1(비터미널/비편집), EDITOR=2(일반 편집), TERMINAL=4(xterm, 대상이 textarea여도 터미널).
 * 모달/키 캡처 차단은 이 모듈 밖에서 처리하며, 실행 가능 여부와 확인은 기존 UI 로직을 재사용한다.
 * 여기에 정의된 것 외의 동작은 추가하지 않는다.
 */

const CONTEXTS = Object.freeze({ APP: 1, EDITOR: 2, TERMINAL: 4 });

const APP = CONTEXTS.APP;
const EDITOR = CONTEXTS.EDITOR;
const TERMINAL = CONTEXTS.TERMINAL;
const APP_TERMINAL = APP | TERMINAL; // 5
const APP_EDITOR_TERMINAL = APP | EDITOR | TERMINAL; // 7

const def = (sequence, contexts) => ({ sequence, contexts });

const ACTIONS = [
  // File
  { id: 'toolbar-new', label: '새 세션', group: '파일', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Alt+KeyN', APP_EDITOR_TERMINAL), def('Ctrl+KeyN', APP_EDITOR_TERMINAL)] },
  { id: 'new-folder', label: '새 폴더', group: '파일', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'quick-connect', label: '빠른 연결', group: '파일', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Alt+KeyD', APP_EDITOR_TERMINAL), def('Alt+KeyQ', APP_EDITOR_TERMINAL)] },
  { id: 'exit', label: '종료', group: '파일', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Ctrl+Shift+KeyQ', APP_EDITOR_TERMINAL)] },

  // Edit
  { id: 'edit-selected', label: '세션 속성', group: '편집', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'bulk-settings', label: '선택 세션 일괄 설정', group: '편집', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'copy-terminal', label: '터미널 복사', group: '편집', contexts: TERMINAL, repeat: false,
    defaults: [def('Ctrl+Shift+KeyC', TERMINAL), def('Ctrl+Insert', TERMINAL)] },
  { id: 'paste-terminal', label: '터미널 붙여넣기', group: '편집', contexts: TERMINAL, repeat: false,
    defaults: [def('Ctrl+KeyV', TERMINAL), def('Ctrl+Shift+KeyV', TERMINAL), def('Shift+Insert', TERMINAL)] },
  { id: 'terminal-search', label: '터미널 찾기', group: '편집', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Ctrl+Shift+KeyF', APP_EDITOR_TERMINAL), def('Ctrl+KeyF', APP)] },
  { id: 'select-all-terminal', label: '터미널 전체 선택', group: '편집', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'clear-terminal', label: '터미널 지우기', group: '편집', contexts: APP_TERMINAL, repeat: false, defaults: [] },

  // View
  { id: 'toggle-sidebar', label: '세션 관리자 표시 / 숨기기', group: '보기', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'nav-snippets', label: '버튼 바 표시 / 숨기기', group: '보기', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'toggle-command', label: '명령 창 표시 / 숨기기', group: '보기', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'split-columns', label: '세로 분할', group: '보기', contexts: APP_TERMINAL, repeat: false,
    defaults: [def('Alt+KeyW then Alt+KeyV', APP_TERMINAL)] },
  { id: 'split-rows', label: '가로 분할', group: '보기', contexts: APP_TERMINAL, repeat: false,
    defaults: [def('Alt+KeyW then Alt+KeyH', APP_TERMINAL)] },
  { id: 'split-off', label: '일반 탭 보기', group: '보기', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'toggle-files', label: 'SFTP 파일 탐색기', group: '보기', contexts: APP_TERMINAL, repeat: false, defaults: [] },

  // Connection
  { id: 'connect-selected', label: '선택한 세션 연결', group: '연결', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'disconnect-active', label: '현재 연결 종료', group: '연결', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'reconnect-active', label: '현재 세션 재접속', group: '연결', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'clone-active', label: '현재 세션 복제', group: '연결', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Ctrl+Shift+KeyD', APP_EDITOR_TERMINAL)] },
  { id: 'disconnect-all', label: '모든 연결 종료', group: '연결', contexts: APP_TERMINAL, repeat: false, defaults: [] },

  // Tools
  { id: 'open-settings', label: '전체 설정', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'credentials', label: '공통 계정 관리', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'keymap', label: '서버 전송 키 매핑', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'batch-run', label: '일괄 실행', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'automation', label: '자동화', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'python-script', label: 'Python 스크립트', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'cancel-automation', label: '자동화 취소', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'new-snippet', label: '버튼 바 명령 추가', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'toggle-log', label: '세션 로그 저장 / 중지', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'open-logs', label: '로그 폴더 열기', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'save-workspace', label: '현재 작업공간 저장', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'restore-workspace', label: '저장한 작업공간 열기', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'named-workspaces', label: '작업공간 관리', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'clear-command-history', label: '현재 탭 명령 이력 지우기', group: '도구', contexts: APP_TERMINAL, repeat: false, defaults: [] },

  // Help
  { id: 'shortcuts', label: '키보드 단축키', group: '도움말', contexts: APP_TERMINAL, repeat: false, defaults: [] },
  { id: 'about', label: '정보', group: '도움말', contexts: APP_TERMINAL, repeat: false, defaults: [] },

  // Shortcut-only (메뉴 항목 없음)
  { id: 'session-search', label: '세션 검색', group: '보기', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Ctrl+KeyK', APP_EDITOR_TERMINAL)] },
  { id: 'show-session-search', label: '세션 검색 표시', group: '보기', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Alt+KeyM', APP_EDITOR_TERMINAL)] },
  { id: 'command-focus', label: '명령 입력 포커스', group: '보기', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Alt+KeyG', APP_EDITOR_TERMINAL)] },
  { id: 'terminal-focus', label: '터미널 포커스', group: '보기', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Alt+Digit7', APP_EDITOR_TERMINAL)] },
  { id: 'previous-tab', label: '이전 탭', group: '보기', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Alt+BracketLeft', APP_TERMINAL), def('Ctrl+Shift+Tab', APP_EDITOR_TERMINAL)] },
  { id: 'next-tab', label: '다음 탭', group: '보기', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Alt+BracketRight', APP_TERMINAL), def('Ctrl+Tab', APP_EDITOR_TERMINAL)] },
  { id: 'close-tab', label: '탭 닫기', group: '보기', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Ctrl+Shift+KeyW', APP_EDITOR_TERMINAL), def('Ctrl+F4', APP_EDITOR_TERMINAL)] },
  { id: 'focus-mode', label: '집중 모드', group: '보기', contexts: APP_TERMINAL, repeat: false,
    defaults: [def('Alt+Enter', APP_TERMINAL)] },
  { id: 'zoom-in', label: '확대', group: '보기', contexts: TERMINAL, repeat: true,
    defaults: [def('Ctrl+Equal', TERMINAL), def('Ctrl+Shift+Equal', TERMINAL)] },
  { id: 'zoom-out', label: '축소', group: '보기', contexts: TERMINAL, repeat: true,
    defaults: [def('Ctrl+Minus', TERMINAL)] },
  { id: 'find-next', label: '다음 찾기', group: '편집', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('F3', APP_EDITOR_TERMINAL), def('Alt+F3', APP_EDITOR_TERMINAL)] },
  { id: 'find-previous', label: '이전 찾기', group: '편집', contexts: APP_EDITOR_TERMINAL, repeat: false,
    defaults: [def('Shift+F3', APP_EDITOR_TERMINAL), def('Alt+Shift+F3', APP_EDITOR_TERMINAL)] }
];

function assertCatalog(actions) {
  const maskOk = (mask) => Number.isInteger(mask) && mask > 0 && (mask & ~(APP | EDITOR | TERMINAL)) === 0;
  const seen = new Set();
  for (const action of actions) {
    if (typeof action.id !== 'string' || action.id.length === 0) {
      throw new Error('shortcut-catalog: action id must be a non-empty string');
    }
    if (seen.has(action.id)) {
      throw new Error('shortcut-catalog: duplicate action id: ' + action.id);
    }
    seen.add(action.id);
    if (!maskOk(action.contexts)) {
      throw new Error('shortcut-catalog: contexts out of bounds: ' + action.id);
    }
    if (typeof action.repeat !== 'boolean') {
      throw new Error('shortcut-catalog: repeat must be a boolean: ' + action.id);
    }
    if (!Array.isArray(action.defaults)) {
      throw new Error('shortcut-catalog: defaults must be an array: ' + action.id);
    }
    for (const entry of action.defaults) {
      if (typeof entry.sequence !== 'string' || entry.sequence.length === 0) {
        throw new Error('shortcut-catalog: invalid default sequence: ' + action.id);
      }
      if (!maskOk(entry.contexts)) {
        throw new Error('shortcut-catalog: default contexts out of bounds: ' + action.id);
      }
    }
  }
}

assertCatalog(ACTIONS);

for (const action of ACTIONS) {
  for (const entry of action.defaults) {
    Object.freeze(entry);
  }
  Object.freeze(action.defaults);
  Object.freeze(action);
}
Object.freeze(ACTIONS);

const ACTIONS_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

function getAction(id) {
  if (typeof id !== 'string') return null;
  return ACTIONS_BY_ID.has(id) ? ACTIONS_BY_ID.get(id) : null;
}

module.exports = { CONTEXTS, ACTIONS, getAction };