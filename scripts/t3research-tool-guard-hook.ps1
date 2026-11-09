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
# Grok runs this hook from ~/.claude/settings.json but sends camelCase toolName/toolInput,
# while Core reads Claude's tool_name/tool_input. A payload that fails to parse goes to Core
# unchanged, and Core fails closed.
if ($env:GROK_HOOK_EVENT) {
  try {
    $grokRequest = $request | ConvertFrom-Json
    if ($null -eq $grokRequest.tool_name -and $null -ne $grokRequest.toolName) {
      $toolName = switch ($grokRequest.toolName) {
        "run_terminal_command" { "Bash" }
        "search_replace" { "Edit" }
        default { $grokRequest.toolName }
      }
      $toolInput = $grokRequest.toolInput
      if ($null -ne $toolInput -and $null -eq $toolInput.file_path -and $null -ne $toolInput.path) {
        $toolInput | Add-Member -NotePropertyName file_path -NotePropertyValue $toolInput.path
      }
      $grokRequest | Add-Member -NotePropertyName tool_name -NotePropertyValue $toolName
      $grokRequest | Add-Member -NotePropertyName tool_input -NotePropertyValue $toolInput
      $request = $grokRequest | ConvertTo-Json -Compress -Depth 20
    }
  } catch {}
}
$decision = $request | & $guardBinary hook `
  -policy-dir $policyDirectory `
  -mode $guardMode `
  -agent-id "d4research-local" `
  -audit-log (Join-Path $dataDirectory "decisions.jsonl") `
  -protect-self `
  -fail-closed-tools "bash,write,edit,notebookedit"
$guardExit = $LASTEXITCODE
# Codex accepts only "deny" from PreToolUse and runs an "ask" as allow, and T3 approves a
# Grok "ask" in full access, so there a review rule has to block. For Codex an allow is
# silence rather than a reported hook error.
if ($args -contains "--escalate-as-deny" -or $env:T3RESEARCH_TOOL_GUARD_ESCALATE -eq "deny") {
  $decision = ($decision -join "`n")
  if ($decision.Contains('"permissionDecision":"allow"')) { exit $guardExit }
  $decision = $decision.Replace('"permissionDecision":"ask"', '"permissionDecision":"deny"').Replace(
    '"permissionDecisionReason":"',
    '"permissionDecisionReason":"Tool Guard review required; ask the user to run it. '
  )
}
$decision
exit $guardExit
