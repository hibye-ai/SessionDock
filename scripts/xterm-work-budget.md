# xterm 6.0.0 수치 작업예산 패치

`patch-xterm-work-budget.cjs`는 입력·출력 SHA가 고정된 CJS/ESM/TypeScript/인터페이스만 수정한다. `postinstall` 및 `build:renderer`에서 재적용되며 알 수 없는 버전/바이트는 파일 쓰기 전 전체 검증에서 실패한다. 원본 변경부는 `tests/fixtures/xterm-work-budget-{original,reverse}.json`과 MIT 원문에 보존한다. reverse fixture 복원은 원본 전체 SHA를 검증한다.

## 등가 경계

- CHT/CBT: nextStop/prevStop은 화면 끝에서 멈춘다. 열 수 이상 호출해도 같은 위치. columns로 반복 상한을 잡으며 tab stop 설정/기본값0→1은 유지한다.
- IL/DL: 커서가 margin 밖이면 기존 no-op. 안이면 cursor row..scrollBottom의 모든 줄을 blank로 바꾼 후 추가 횟수는 같은 화면 효과. 해당 행 수로 포화한다. upstream erase attributes·cursor x=0·dirty row·marker splice 경로 유지.
- SU/SD: scrollTop..scrollBottom 포화. upstream SU의 erase attributes, SD의 DEFAULT_ATTR_DATA 차이 유지. 기존 SU가 scrollback으로 이동하지 않는 동작도 바꾸지 않는다.
- ECH: upstream BufferLine.replaceCells가 `start < end && start < this.length`로 이미 제한. 변경 불필요. ICH/DCH/SL/SR/DECIC/DECDC도 BufferLine.insert/deleteCells의 열수 분기. cursor arithmetic은 기존 restrictCursor로 포화. 숫자 parser cap 자체는 변경하지 않는다.
- REP: count를 버리지 않는다. 한 handler의 대규모 Uint32Array(text.length*count)를 **1024 codepoint scratch**로 바꾸고, 누적 REP codepoint 예산도1024마다 timer macrotask로 양보한다. parser가 원래 지원하는 Promise<boolean> 중단/재개를 사용하여 뒤따르는 제어문과 다음 write 및 ACK 순서 보존. grapheme cluster도 codepoint 경계로 나누며 count/남은offset 전량 처리한다. print의 wide-cell 시작/끝 정리는 전체 REP의 처음/마지막에만 실행한다. dispose된 InputHandler는 추가 작업을 중단한다.

이것은 총 REP count의 임의 축소가 아니다. 매우 큰 REP는 연결별 처리 시간이 길 수 있지만 각 turn/할당을 분할하며 기존 화면/scrollback 상한과 수신 backpressure를 사용한다. 진행 중 외부 resize/reset은 upstream async parser와 동일한 상호작용 경계이며, 모든 실장비/사용자 입력 조합 검증을 주장하지 않는다. 큰2147483647 실행/OOM 시험은 하지 않았다.

## 검증

`tests/xterm-work-budget.test.cjs`: bounded4096/8192만 사용, 원본 screen/cursor/속성/wrap/scrollback 차등, CHT/CBT/IL/DL/SU/SD/이미 bounded 경로, ASCII/한글/보충평면/combining·1200mark, wrap-off/insert/alt/margins,0/default,splitescape,adjacentREP,dispose,CJS/ESM,clean-input 재패치/멱등/unknown fail-before-write.

제품 bundle/ZIP은 phase2 최종 빌드까지 이전 그대로다. 개발 의존성의 패치와 재번들된 배포 산출물을 혼동하지 않는다.
