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
$decision = $request | & $guardBinary hook `
  -policy-dir $policyDirectory `
  -mode $guardMode `
  -agent-id "d4research-local" `
  -audit-log (Join-Path $dataDirectory "decisions.jsonl") `
  -protect-self `
  -fail-closed-tools "bash,write,edit,notebookedit"
$guardExit = $LASTEXITCODE
# Codex accepts only "deny" from PreToolUse and runs an "ask" as allow, so for Codex a
# review rule has to block, and an allow is silence rather than a reported hook error.
if ($args -contains "--escalate-as-deny") {
  $decision = ($decision -join "`n")
  if ($decision.Contains('"permissionDecision":"allow"')) { exit $guardExit }
  $decision = $decision.Replace('"permissionDecision":"ask"', '"permissionDecision":"deny"').Replace(
    '"permissionDecisionReason":"',
    '"permissionDecisionReason":"Tool Guard review required; ask the user to run it. '
  )
}
$decision
exit $guardExit
