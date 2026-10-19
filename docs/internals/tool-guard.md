# Tool Guard internals

> For maintainers. Using d4research? See [docs/user/tool-guard.md](../user/tool-guard.md).

Tool Guard is an optional, environment-local policy layer over provider tool calls. The engine
(`tg`) lives in the separate [tool-guard-core](https://github.com/dimaggi-ai/tool-guard-core)
repository; this repo contains the policy profiles (`ops/tool-guard/profiles/`), the hook wrappers
(`scripts/t3research-tool-guard-hook{,.ps1}` and `scripts/t3research-tool-guard-agy-hook{,.ps1}`),
and the managed lifecycle that installs them.

## How interception works

Providers call the guard through their native pre-tool-use hook mechanisms. The lifecycle writes a
`PreToolUse` hook entry (matcher:
`Bash|Edit|Write|NotebookEdit|run_command|write_to_file|replace_file_content|multi_replace_file_content`)
into the provider hook configs enumerated by `externalToolGuardHookPaths` in
[`toolGuardLifecycle.ts`][lifecycle]: `~/.claude/settings.json` plus the Gemini/Agy configs
(`~/.gemini/settings.json`, with hooks under `~/.gemini/config/hooks.json`). On Windows the hook
command wraps the `.ps1` adapter in
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "..."`.

The wrapper script exits immediately (allowing the tool) unless `T3RESEARCH_TOOL_GUARD_MODE` is
set. The Claude, Codex, and Agy adapters set that variable per provider process through
`toolGuardEnvironment` ([`toolGuardRuntime.ts`][runtime]), but only while the managed integration
is enabled. This creates a double gate: a hook entry alone does nothing outside a session launched
by an enabled d4research environment.

When active, the wrapper execs `tg hook` with `-policy-dir`, `-mode`, an audit log at
`<data-dir>/decisions.jsonl`, `-protect-self`, and `-fail-closed-tools bash,write,edit,notebookedit`
(those tools deny when the engine itself fails). `T3RESEARCH_TOOL_GUARD_BIN`,
`T3RESEARCH_TOOL_GUARD_DATA_DIR`, and `T3RESEARCH_TOOL_GUARD_POLICY_DIR` override binary, audit
directory, and policy directory.

## Mode mapping

The per-thread access selector (`RuntimeMode`) maps to two guard modes:

| Runtime mode                                     | Guard mode    | Meaning                                             |
| ------------------------------------------------ | ------------- | --------------------------------------------------- |
| `approval-required`, `auto-accept-edits`, `auto` | `enforcement` | Policy decisions block or escalate the tool call    |
| `full-access`                                    | `shadow`      | Every rule evaluates and is audited, nothing blocks |

Full access therefore stays audited without pretending to be restricted. The shadow profile
(`ops/tool-guard/profiles/local-coding-shadow/`) mirrors the enforcement profile with
`mode: shadow`; the server regenerates it from the enforcement policy on every policy write
([`toolGuardPolicy.ts`][policy], `writeToolGuardPolicy`).

## Policy format

`ops/tool-guard/profiles/local-coding/policy.yaml` is the bundled profile. Its shape mirrors the
`ToolGuardPolicy` interface in
[`packages/contracts/src/toolGuardPolicy.ts`](../../packages/contracts/src/toolGuardPolicy.ts):

- header: `policy_id`, `name`, `version`, `status`, `mode` (`enforcement` | `shadow`)
- `scope`: `tool_names` (`bash`, `shell`, `run_command`) and `tool_groups`
- `rules[]`: `rule_id`, `rule_type: regex`, `conditions` (a `field`/`operator`/`value` matcher or
  `and`/`or` combinations, matching mostly on `parameters.command`), `effect`
  (`deny` | `escalate` | `allow`), and a `citation.excerpt` explaining the rule.

The bundled rules deny recursive deletion of system/home paths and secret exfiltration over the
network. They escalate (require human review) recursive/forced deletes, git history rewrites
and pushes, GitHub publishing actions, npm publishes, and privileged Docker use.

## Managed lifecycle

[`toolGuardLifecycle.ts`][lifecycle] implements the actions `install`, `replace-external`,
`enable`, `disable`, and `uninstall`, exposed over `POST` on the HTTP surface in
[`http.ts`](../../apps/server/src/http.ts) next to `GET /api/tool-guard/status` and the
`GET`/`PUT` pair on `/api/tool-guard/policy`.

- **install** copies the detected Core binary, the platform hook wrappers, and the profiles into
  the environment's d4research data directory (a versioned manifest records `enabled` and
  `installedAt`), then writes the managed hook entries into the provider configs. Install refuses
  to run while an external (non-managed) Tool Guard hook is present.
- **replace-external** removes only hook entries identified as Tool Guard from the provider
  configs, preserves unrelated hooks, then installs the managed integration. Removed external
  entries are not restored by a later uninstall.
- **enable** / **disable** toggle the manifest flag, add or remove the managed hook entries, and
  flip `setToolGuardRuntimeEnabled` so provider processes stop receiving the guard variables.
- **uninstall** removes the managed installation and hook entries entirely.

[`toolGuardStatus.ts`][status] classifies the environment (`classifyToolGuardIntegration`) into
`managed`, `disabled`, `external`, or unavailable states by combining the manifest, the detected
binary, and hook scans of the provider configs (managed hooks are recognized by the
`t3research-tool-guard-hook` marker). The status payload drives the Settings UI, including
`canReplaceExternal` and the list of `externalHookConfigPaths`.

## Policy visibility and editing

`readToolGuardPolicy` ([apps/server/src/toolGuardPolicy.ts][policy]) resolves the active
`local-coding` policy from the managed profiles first and falls back to the bundled profiles
(`D4RESEARCH_TOOL_GUARD_RESOURCES`/profiles, the packaged `tool-guard/profiles` beside the build,
or `ops/tool-guard/profiles` in a checkout). The response carries
`ToolGuardPolicySource = "managed" | "bundled"`.

The web page **Settings → Tool Guard** (`/settings/tool-guard`,
`apps/web/src/components/settings/ToolGuardSettingsPanel.tsx`) displays each rule as a card
showing its effect, citation, and condition summary. You can create, edit, or delete rules via
`RuleEditDialog` (persisted through `PUT /api/tool-guard/policy`) only when the managed
integration is installed and the policy source is `managed`. If the source is `bundled`, the rules
are read-only, allowing users to inspect the policy before installing.

## Audit

Decisions append to `decisions.jsonl` under the managed data directory, which defaults to
`$T3CODE_HOME/userdata/tool-guard`, or the `audit/` directory beside an installed profile tree.
No in-app audit viewer exists yet; the log is a local file.

[lifecycle]: ../../apps/server/src/toolGuardLifecycle.ts
[status]: ../../apps/server/src/toolGuardStatus.ts
[policy]: ../../apps/server/src/toolGuardPolicy.ts
[runtime]: ../../apps/server/src/provider/toolGuardRuntime.ts
