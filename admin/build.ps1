param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & $Python -m PyInstaller --noconfirm --clean SessionDockAdmin.spec
    if ($LASTEXITCODE -ne 0) { throw '관리자 도구 빌드 실패' }
} finally { Pop-Location }
