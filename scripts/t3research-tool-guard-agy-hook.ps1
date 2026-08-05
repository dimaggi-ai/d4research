$ErrorActionPreference = "Stop"

function Deny-FailedEvaluation {
  @{ decision = "deny"; reason = "Tool Guard could not evaluate this command and failed closed." } |
    ConvertTo-Json -Compress
  exit 0
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $command = $request.toolCall.args.CommandLine
  if ($null -eq $command) { $command = $request.toolCall.args.command }
  if ($null -eq $command) { $command = $request.toolCall.args.cmd }
  if ($command -is [array]) { $command = $command -join " " }
  if ([string]::IsNullOrWhiteSpace([string]$command)) {
    @{ decision = "allow" } | ConvertTo-Json -Compress
    exit 0
  }

  $normalized = @{ tool_name = "Bash"; tool_input = @{ command = [string]$command } } |
    ConvertTo-Json -Compress -Depth 4
  $hook = Join-Path $PSScriptRoot "t3research-tool-guard-hook.ps1"
  $guardResult = $normalized | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $hook
  if ($LASTEXITCODE -ne 0) { Deny-FailedEvaluation }
  $decision = $guardResult | ConvertFrom-Json
  $permission = $decision.hookSpecificOutput.permissionDecision
  if ($permission -notin @("allow", "ask", "deny")) { Deny-FailedEvaluation }
  $reason = $decision.hookSpecificOutput.permissionDecisionReason
  if ([string]::IsNullOrWhiteSpace([string]$reason)) { $reason = "Tool Guard policy decision" }
  @{ decision = $permission; reason = $reason } | ConvertTo-Json -Compress
} catch {
  Deny-FailedEvaluation
}
