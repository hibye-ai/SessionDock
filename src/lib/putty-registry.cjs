'use strict';

const { systemPowerShell: resolveSystemPowerShell } = require('./windows-system-tools.cjs');
const { execFile } = require('node:child_process');

// Kept in a separate module so putty-import.cjs can expose synchronous .reg
// parsing without starting PowerShell.  The import module re-exports these
// helpers for callers that inject a test runner.
const PUTTY_REGISTRY_KEY = 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions';
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

const READER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$keyPath = 'Software\SimonTatham\PuTTY\Sessions'
$stringNames = @('HostName', 'Protocol', 'UserName', 'TerminalType', 'LineCodePage')
$numberNames = @('PortNumber', 'SshProt', 'PingInterval', 'PingIntervalSecs', 'BackspaceIsDelete', 'TryAgent', 'AgentFwd', 'ProxyMethod', 'ProxyType', 'ProxySOCKSVersion', 'GroupCollapse')
$presenceNames = @('PublicKeyFile', 'DetachedCertificate', 'AuthPlugin', 'GSSCustom', 'Password', 'ProxyPassword', 'ProxyUsername', 'ProxyTelnetCommand', 'PortForwardings', 'RemoteCommand', 'SSHManualHostKeys')
$root = $null
$sub = $null
$json = $null

function Write-Reader-Error([string]$kind) {
    [Console]::Out.Write((@{ error = $kind } | ConvertTo-Json -Compress -Depth 3))
}

function Test-NonEmpty-RegistryValue($value) {
    if ($null -eq $value) { return $false }
    if ($value -is [string]) { return $value.Length -gt 0 }
    if ($value -is [System.Array]) {
        foreach ($item in $value) { if ((Test-NonEmpty-RegistryValue $item)) { return $true } }
        return $false
    }
    return $true
}

try {
    try { $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $false) }
    catch { Write-Reader-Error 'access'; exit 0 }
    if ($null -eq $root) {
        [Console]::Out.Write((@{ missing = $true; truncated = $false; records = @() } | ConvertTo-Json -Compress -Depth 4))
        exit 0
    }

    $records = [System.Collections.ArrayList]::new()
    $truncated = $false
    foreach ($name in @($root.GetSubKeyNames())) {
        if ($records.Count -ge 15000) { $truncated = $true; break }
        $sub = $null
        try { $sub = $root.OpenSubKey($name, $false) }
        catch { throw }
        if ($null -eq $sub) { throw [System.IO.IOException]::new('PuTTY session subkey unavailable') }

        try {
            $values = @{}
            $present = @($sub.GetValueNames())
            foreach ($valueName in $stringNames) {
                if ($present -contains $valueName) {
                    try {
                        $kind = $sub.GetValueKind($valueName)
                        $value = $sub.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::String -and $value -is [string] -and $value.Length -le 32768) {
                            $values[$valueName] = $value
                        } else {
                            $values[$valueName] = $null
                        }
                    } catch { throw }
                }
            }
            foreach ($valueName in $numberNames) {
                if ($present -contains $valueName) {
                    try {
                        $kind = $sub.GetValueKind($valueName)
                        $value = $sub.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) {
                            $values[$valueName] = ([long]$value -band 4294967295L)
                        } else {
                            $values[$valueName] = $null
                        }
                    } catch { throw }
                }
            }
            foreach ($valueName in $presenceNames) {
                if ($present -contains $valueName) {
                    try {
                        $value = $sub.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        $values[$valueName] = [bool](Test-NonEmpty-RegistryValue $value)
                    } catch { throw }
                }
            }
            [void]$records.Add([ordered]@{ name = [string]$name; values = $values })
        } finally {
            if ($null -ne $sub) { $sub.Dispose(); $sub = $null }
        }
    }
    $json = @{ missing = $false; truncated = $truncated; records = @($records) } | ConvertTo-Json -Compress -Depth 5
} catch {
    Write-Reader-Error 'read'
} finally {
    if ($null -ne $sub) { $sub.Dispose(); $sub = $null }
    if ($null -ne $root) { $root.Dispose(); $root = $null }
}
if ($null -ne $json) { [Console]::Out.Write($json) }
`;

const ENCODED_SCRIPT = Buffer.from(READER_SCRIPT, 'utf16le').toString('base64');
const READER_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT
]);
const READER_OPTIONS = Object.freeze({
  shell: false,
  windowsHide: true,
  timeout: 15000,
  maxBuffer: MAX_OUTPUT_BYTES,
  encoding: 'utf8'
});

function invalid(message, code = 'ERR_PUTTY_REGISTRY') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function systemPowerShell() {
  try { return resolveSystemPowerShell(process.env.SystemRoot); }
  catch { invalid('Windows 시스템 경로를 확인할 수 없어 PuTTY 레지스트리를 읽지 못했습니다.'); }
}

function defaultRunner(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      // Never pass through stderr or the original error: command/registry
      // diagnostics could contain machine or session information.
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}

function invokeRunner(runner, command, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    let returned;
    try {
      returned = runner(command, args, options, (error, value) => finish(error, value));
    } catch (error) {
      finish(error);
      return;
    }
    if (returned && typeof returned.then === 'function') {
      returned.then(value => finish(null, value), error => finish(error));
    } else if (returned !== undefined) {
      finish(null, returned);
    }
  });
}

function outputText(result) {
  if (typeof result === 'string') return result;
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) return Buffer.from(result).toString('utf8');
  if (result && typeof result === 'object' && 'stdout' in result) {
    const output = result.stdout;
    if (typeof output === 'string') return output;
    if (Buffer.isBuffer(output) || output instanceof Uint8Array) return Buffer.from(output).toString('utf8');
  }
  invalid('PuTTY 레지스트리를 읽었지만 올바른 결과를 받지 못했습니다.');
}

function parseReaderOutput(result) {
  const text = outputText(result);
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    invalid('PuTTY 레지스트리 출력이 크기 제한을 초과했습니다.', 'ERR_PUTTY_REGISTRY_LIMIT');
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { invalid('PuTTY 레지스트리 읽기 결과를 해석하지 못했습니다.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalid('PuTTY 레지스트리 읽기 결과의 형식이 올바르지 않습니다.');
  }
  if (parsed.error !== undefined) {
    invalid('PuTTY 레지스트리 키를 읽을 수 없습니다. 접근 권한을 확인해 주세요.');
  }
  if (parsed.missing === true) {
    return { records: [], warnings: ['현재 사용자 계정에 PuTTY 저장 세션 레지스트리 키가 없습니다.'], truncated: false };
  }
  if (parsed.missing !== false || !Array.isArray(parsed.records)) {
    invalid('PuTTY 레지스트리 읽기 결과의 형식이 올바르지 않습니다.');
  }
  if (parsed.records.length > 15000) {
    invalid('PuTTY 레지스트리 세션 수가 제한을 초과했습니다.', 'ERR_PUTTY_REGISTRY_LIMIT');
  }
  return { records: parsed.records, warnings: [], truncated: parsed.truncated === true };
}

// The renderer serializes its own import action, but IPC callers can still
// reach this module directly. Refuse a second production reader instead of
// allowing an unbounded process queue. Injected runners are intentionally not
// serialized because tests own their lifetime and may exercise concurrency.
let defaultReaderActive = false;

async function runDefaultReader() {
  if (defaultReaderActive) {
    invalid('PuTTY 레지스트리 읽기가 이미 실행 중입니다. 잠시 후 다시 시도해 주세요.', 'ERR_PUTTY_REGISTRY_BUSY');
  }
  defaultReaderActive = true;
  try {
    return await invokeRunner(defaultRunner, systemPowerShell(), [...READER_ARGS], { ...READER_OPTIONS });
  } finally {
    defaultReaderActive = false;
  }
}

async function readPuttyRegistryRaw(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    invalid('PuTTY 레지스트리 읽기 옵션이 올바르지 않습니다.');
  }
  const runner = options.runner;
  if (runner != null && typeof runner !== 'function') {
    invalid('PuTTY 레지스트리 읽기 실행기가 올바르지 않습니다.');
  }
  let result;
  try {
    result = runner != null
      ? await invokeRunner(runner, systemPowerShell(), [...READER_ARGS], { ...READER_OPTIONS })
      : await runDefaultReader();
  } catch (error) {
    if (error?.code === 'ERR_PUTTY_REGISTRY_BUSY') throw error;
    invalid('PuTTY 레지스트리 키를 읽지 못했습니다. 접근 권한을 확인한 뒤 다시 시도해 주세요.');
  }
  return parseReaderOutput(result);
}

module.exports = {
  PUTTY_REGISTRY_KEY,
  READER_ARGS,
  READER_OPTIONS,
  READER_SCRIPT,
  readPuttyRegistryRaw
};
