$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'build-inputs/python-runtime-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$runtime = Join-Path $root 'assets/python-runtime'
$analysis = Join-Path $root 'analysis'
$buildManifest = Join-Path $analysis 'python-runtime-manifest.json'

function Test-PinnedRuntime([string]$directory) {
    $entries = @(Get-ChildItem -LiteralPath $directory -Force)
    if ($entries.Count -ne $manifest.files.Count) {
        throw 'Python 런타임 파일 목록이 일치하지 않습니다.'
    }
    foreach ($file in $manifest.files) {
        $member = Get-Item -LiteralPath (Join-Path $directory $file.name) -Force
        if ($member.PSIsContainer -or ($member.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            (Get-FileHash -LiteralPath $member.FullName -Algorithm SHA256).Hash -ne $file.sha256) {
            throw "Python 런타임 검증 실패 ($($file.name))"
        }
    }
}

if (Test-Path -LiteralPath $runtime) {
    Test-PinnedRuntime $runtime
} else {
    $temp = New-Item -ItemType Directory -Path (Join-Path $root ('assets/.python-runtime-' + [Guid]::NewGuid()))
    try {
        $zip = Join-Path $temp.FullName 'runtime.zip'
        $unpacked = Join-Path $temp.FullName 'unpacked'
        Invoke-WebRequest -Uri $manifest.url -OutFile $zip -UseBasicParsing
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $manifest.archiveSha256) {
            throw 'Python 다운로드 SHA-256이 일치하지 않습니다.'
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
        Test-PinnedRuntime $unpacked
        [IO.Directory]::Move($unpacked, $runtime)
    } finally {
        Remove-Item -LiteralPath $temp.FullName -Recurse -Force
    }
}

if (-not (Test-Path -LiteralPath $analysis)) {
    New-Item -ItemType Directory -Path $analysis | Out-Null
}
if (-not (Test-Path -LiteralPath $buildManifest)) {
    [IO.File]::Copy($manifestPath, $buildManifest)
}
if ((Get-FileHash -LiteralPath $buildManifest).Hash -ne (Get-FileHash -LiteralPath $manifestPath).Hash) {
    throw '기존 빌드 검증 목록이 공개 빌드 입력과 다릅니다.'
}
Write-Output "Python $($manifest.version) 런타임 $($manifest.files.Count)개 검증 완료"
