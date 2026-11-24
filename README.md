# SessionDock

SessionDock은 Windows용 SSH2·Telnet 터미널과 세션 관리자입니다. 폴더와 검색으로 접속 목록을 관리하고, 탭과 분할 화면에서 여러 장비를 다룰 수 있습니다. SSH 파일 전송(SFTP), 세션 로그, 명령 일괄 실행을 지원합니다. SecureCRT, PuTTY, WindTerm의 접속 목록을 가져올 수 있습니다.

## Windows에서 설치

Windows x64용 ZIP을 내려받아 새 폴더에 압축을 풀고 `SessionDock.exe`를 실행하세요. SessionDock 0.1.8부터 장비 비밀번호는 접속할 때 입력합니다. 이전 버전에서 저장한 장비 비밀번호는 0.1.8이 세션 저장 파일을 처음 열 때 제거됩니다. [공식 다운로드](https://sessiondock.norahc.com/SessionDock.zip)

팀의 공유 세션 목록을 만들고 배포하려면 별도 관리자 도구를 사용하세요. [SessionDock Admin](admin/README.md)

## 개발과 빌드

Windows x64와 Node.js 24 이상을 사용합니다. 프로젝트 루트에서 다음 명령을 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-windows.ps1
npm.cmd ci
npm.cmd run dev
```

준비 스크립트는 Python 공식 임베디드 런타임을 내려받아 고정 SHA-256을 검증합니다. 앱에 포함되는 Python, Electron/Chromium 및 npm 의존성의 라이선스는 각 배포물의 고지를 따릅니다.

```powershell
npm.cmd test
npm.cmd run test:integration
npm.cmd run dist -- --build-only
node node_modules/electron/install.js
node scripts/verify-package.cjs
```

Windows 빌드 결과는 `dist/SessionDock.zip`에 생성됩니다. 단위 시험과 통합 시험은 합성 데이터와 루프백 서버를 사용합니다. 이 버전의 기본 업데이트 채널은 공식 SessionDock 서버이며, 설정에서 로컬 폴더 업데이트를 선택할 수 있습니다.

## 기여

버그를 제보할 때는 SessionDock과 Windows 버전, SSH 또는 Telnet 여부, 재현 순서를 함께 알려 주세요. 장비 주소, 로그인 정보, 실제 접속 목록이 들어 있는 로그는 정리한 뒤 첨부해 주세요.

SessionDock 소스는 MIT 라이선스로 제공됩니다. [라이선스](LICENSE)
