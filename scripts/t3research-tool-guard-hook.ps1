$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:T3RESEARCH_TOOL_GUARD_MODE)) {
  exit 0
}

$scriptDirectory = $PSScriptRoot
$integrationDirectory = Split-Path $scriptDirectory -Parent
$guardMode = if ($env:T3RESEARCH_TOOL_GUARD_MODE -eq "shadow") { "shadow" } else { "enforcement" }
$profileName = if ($guardMode -eq "shadow") { "local-coding-shadow" } else { "local-coding" }
$policyDirectory = if ($env:T3RESEARCH_TOOL_GUARD_POLICY_DIR) {
  $env:T3RESEARCH_TOOL_GUARD_POLICY_DIR
} else {
  Join-Path (Join-Path $integrationDirectory "profiles") $profileName
}
$dataDirectory = if ($env:T3RESEARCH_TOOL_GUARD_DATA_DIR) {
  $env:T3RESEARCH_TOOL_GUARD_DATA_DIR
} else {
  Join-Path $integrationDirectory "audit"
}
$guardBinary = if ($env:T3RESEARCH_TOOL_GUARD_BIN) {
  $env:T3RESEARCH_TOOL_GUARD_BIN
} else {
  Join-Path (Join-Path $integrationDirectory "bin") "tg.exe"
}

New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
$request = [Console]::In.ReadToEnd()
$request | & $guardBinary hook `
  -policy-dir $policyDirectory `
  -mode $guardMode `
  -agent-id "d2research-local" `
  -audit-log (Join-Path $dataDirectory "decisions.jsonl") `
  -protect-self `
  -fail-closed-tools "bash,write,edit,notebookedit"
exit $LASTEXITCODE
