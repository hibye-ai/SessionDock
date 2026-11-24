# SessionDock Admin

Windows용 공유 세션 목록 편집기입니다. 관리자가 만든 JSON 파일은 팀원이 SessionDock에서 공유 목록으로 등록할 수 있습니다.

## 엑셀 / CSV / TSV 자동 인식

가져오기 → 엑셀 또는 CSV / TSV에서 폴더 열 기본값은 **자동**입니다. 본앱과 `assets/session-table-schema.json`을 공유하고 공식 헤더는 `폴더,이름,주소,프로토콜,포트`입니다. 폴더 경로/여러 폴더 열, 이름·주소 분리를 지원합니다. 본앱 전체 설정 → 가져오기·내보내기 → CSV 양식의 **예시 CSV 저장...**로 양식을 저장한 후 Admin에서 읽을 수 있습니다. Admin에 별도의 예시 저장 버튼이 있다는 뜻은 아닙니다.

모호한 헤더/열은 추측하지 않고 수동 설정 안내를 표시합니다. 수동 폴더 열 **0~16**, 첫 행 제목, ID 열 선택도 유지합니다. 수동 순서는 선택적 ID → 폴더 열 → 이름 → 주소 → 프로토콜 → 포트입니다. TEST-NET `192.0.2.10`과 `2001:db8::10`은 예시 전용 주소입니다.

파일 가져오기는 기존 목록과 병합하며 충돌은 미리보기에서 해결합니다. 입력에 없는 기존 세션은 유지합니다. 반면 **붙여넣기 → 목록 덮어쓰기**는 새 입력만 남기는 전체 교체로, 입력에 없는 폴더·세션이 제거됩니다. 확인 전에는 적용하지 않으며 전체 작업 실행 취소/다시 실행을 지원합니다.

## 저장과 공유

JSON 열기 → 편집 → 저장 / 게시 순서입니다. 공유 파일 변경 감지/CAS·잠금·원자 게시·백업을 유지합니다. 로컬 작업 충돌 시 최신 작업 다시 불러오기를 사용합니다. 자격 증명·개인키 경로 등 비공유 필드는 게시하지 않습니다. `ctrlArrowMode`는 word/native만 전달하며 누락 값은 그대로 둡니다.


## 개발과 빌드

Tk가 포함된 Python으로 이 디렉터리에서 실행합니다.

```powershell
python -m pip install -r requirements.txt
python main.py
python -m unittest discover -s tests -v
powershell.exe -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

빌드 결과는 `dist/SessionDock-Admin.exe`에 생성됩니다. [SessionDock 안내](../README.md)
