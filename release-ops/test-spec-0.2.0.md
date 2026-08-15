# d4research v0.2.0 — Test Specification and Coverage Review

**Companion to:** `plan-0.2.0.md` (what must be true) and `spec-0.2.0.md`
(what ships). Each requirement below carries an ID, the verifying evidence,
and a status. "Automated" cites a test file or gate that exists and runs
today. "Gap" means no automated verification exists; gaps block the tag only
where the plan marks them as gates.

Statuses: **automated** · **automated (opt-in)** · **manual** · **gap**.

## P0 — Distribution

| ID   | Requirement                                                                                                                         | Verification                                                                  | Status                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------- |
| P0-1 | The packed artifact installs on a machine that has never seen the workspace (no `catalog:`/`workspace:` leakage, native deps build) | `release-ops/docker/smoke.sh` image build (`npm install -g` on stock node:24) | automated              |
| P0-2 | First launch on an empty home becomes healthy and creates state                                                                     | `container-smoke.sh` step 1                                                   | automated              |
| P0-3 | Pairing CLI works against the live server                                                                                           | `container-smoke.sh` step 2                                                   | automated              |
| P0-4 | Restart preserves state                                                                                                             | `container-smoke.sh` step 3                                                   | automated              |
| P0-5 | Update-in-place over live state                                                                                                     | `container-smoke.sh` step 4                                                   | automated              |
| P0-6 | Uninstall leaves nothing behind on PATH                                                                                             | `container-smoke.sh` step 5                                                   | automated              |
| P0-7 | Checksums and provenance published with artifacts                                                                                   | release publication step (`spec-0.2.0.md` § Distribution)                     | manual                 |
| P0-8 | One unambiguous version across tag, manifests, docs                                                                                 | decision recorded in `spec-0.2.0.md` § Version                                | gap — decision pending |

## P1 — Turn, process, and connection lifecycle

| ID   | Requirement                                                                                     | Verification                                                                                                                                                                                                                                 | Status                               |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| P1-1 | Provider process exit, malformed output, auth failure, timeout end in explicit states           | `apps/server/src/provider/Layers/*Adapter*.test.ts` per provider; deadlines in `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`                                                                                         | automated                            |
| P1-2 | No turn remains indefinitely "running"/"starting" after its provider works or dies — codex path | pump hardening and handler isolation landed and test green, but a 2026-08-15 live handoff still went silent with zero adapter log lines and a hung t3-code MCP tool call; the dead link sits in the full server composition, not the runtime | **gap — REOPENED, release-blocking** |
| P1-3 | Same guarantee for the remaining providers' event pipelines                                     | Claude has `Stream.catchCause` in `ClaudeAdapter.ts`; Grok/Cursor/OpenCode/Agy pumps not audited for silent-death                                                                                                                            | gap — audit scheduled                |
| P1-4 | Cancellation during orchestration, delegation, checkpointing                                    | interrupt paths in `ProviderCommandReactor.test.ts`, `CheckpointReactor.test.ts`                                                                                                                                                             | automated                            |
| P1-5 | Server restart reconciliation terminates orphaned projected sessions                            | restart reconciliation cases in `ProviderCommandReactor.test.ts`; reaper in `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`                                                                                                  | automated                            |
| P1-6 | Provider child-process cleanup, no orphaned work                                                | adapter stop/`stopAll` tests per provider; reaper test above                                                                                                                                                                                 | automated                            |
| P1-7 | Reconnect, duplicate receipts, browser refresh during a turn                                    | `ProviderRuntimeIngestion*.test.ts` (receipts), relay tests in `packages/contracts/src/relay.test.ts`; browser-refresh journey                                                                                                               | automated (unit) / manual (journey)  |
| P1-8 | Stale pipeline banners, stuck composer, misleading activity labels                              | `apps/web/src/composer-logic.test.ts`, `apps/web/src/components/chat/MessagesTimeline*.test.*`, `apps/mobile/src/lib/threadActivity.test.ts`                                                                                                 | automated                            |
| P1-9 | Budget exhaustion and partial delegate failure                                                  | `apps/server/src/mcp/toolkits/research/research.test.ts`, `inlineDelegation.test.ts`                                                                                                                                                         | automated                            |

## P2 — Provider readiness

| ID   | Requirement                                                                        | Verification                                                                                                            | Status             |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ |
| P2-1 | Installed / authenticated / reachable / model-ready are distinct observable states | provider snapshot tests per adapter (`*Provider.test.ts`), `ClaudeCapabilitiesProbe.test.ts`                            | automated          |
| P2-2 | Opt-in real CLI probes                                                             | `qa:provider:junie` script (`T3_JUNIE_ACP_PROBE=1`); codex real-CLI probe exercised ad hoc                              | automated (opt-in) |
| P2-3 | Permissive fixtures cannot hide CLI shape drift                                    | captured-wire assertions: `CodexCollabWire.test.ts` against `codexMultiAgentWire.json`; `ClaudeAdapterFixtures.test.ts` | automated          |
| P2-4 | Corrective setup guidance next to the failing provider                             | web provider-readiness rendering tests                                                                                  | automated          |

## P3 — Large-context and Memo

| ID   | Requirement                                                               | Verification                                                                                            | Status                           |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------- |
| P3-1 | Oversized document survives Memo persistence as a provider-safe reference | 132,277-char attachment case in `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` | automated                        |
| P3-2 | Failed persistence never requires a reload to restore Send                | `apps/web/src/memoAttachments.test.ts`                                                                  | automated                        |
| P3-3 | Relevant-chunk retrieval during the active turn                           | research/memo connector tests (`apps/server/src/mcp/toolkits/memory/`)                                  | automated                        |
| P3-4 | Reload, handoff, cancellation, missing-Memo recovery for attachments      | handoff prompt in `packages/shared/src/providerHandoffPrompt.test.ts`; missing-Memo recovery journey    | automated (unit) / gap (journey) |

## P4 — Starter scenario

| ID   | Requirement                                                     | Verification                                                                           | Status                              |
| ---- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| P4-1 | Bounded budget, stopping condition, no recursive delegation     | `research.test.ts`, `inlineDelegation.test.ts`                                         | automated                           |
| P4-2 | Delegates that ran/failed/skipped are visible and never implied | run-manifest assertions in `research.test.ts`; `apps/web/src/researchPipeline.test.ts` | automated                           |
| P4-3 | Deterministic sample corpus onboarding                          | checked-in starter corpus exercised by research handler tests                          | automated                           |
| P4-4 | Markdown export with provenance                                 | export path covered in web research pipeline tests; end-to-end export journey          | automated (unit) / manual (journey) |

## P5 — Docs and public description

| ID   | Requirement                                                              | Verification                                                                   | Status |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------ |
| P5-1 | Install/first-run, concepts, troubleshooting docs match shipped behavior | `docs/user/*` review at release; docker smoke doubles as the install-doc check | manual |
| P5-2 | No unsupported performance/safety/distribution claims                    | release-owner review against `spec-0.2.0.md` § Platforms                       | manual |

## Code-contract coverage (`packages/contracts`)

19 of the contract modules carry dedicated tests (background, environment,
filesystem, git, ipc, keybindings, model, provider, pullRequest, relay,
server, settings, t3ProjectFile, terminal, threadTurnUsage, and friends).
The remainder are pure `Schema` declarations exercised transitively by the
server, web, and mobile suites that encode/decode them on every run.

Review verdict: acceptable for v0.2.0 with two watch items — `usage.ts` and
`toolGuardPolicy.ts` carry derivation-adjacent shapes and should gain
dedicated round-trip tests when next touched (not tag-blocking; both are
exercised transitively by `apps/server` usage and Tool Guard suites).

## Product-contract coverage (the six standing contracts)

| Contract                                              | Evidence                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible thread stays authoritative across handoffs    | `packages/shared/src/providerHandoffPrompt.test.ts`, `userMessageTransport.test.ts`, handoff docs tests; server handoff integration in orchestration suites |
| Research delegation bounded, never implied            | P4-1/P4-2 rows above                                                                                                                                        |
| Memo, voice, operations, Tool Guard stay local-first  | memory connector tests pin the local backend; Tool Guard assets verified in the composed artifact (build gate)                                              |
| Provider-native permissions remain the default        | adapter runtime-mode tests per provider; Tool Guard opt-in covered by its own suite                                                                         |
| Multi-surface honesty (web/desktop/mobile/remote)     | per-surface suites (271 web, 105 mobile, 57 desktop test files); disabled-state rendering tests                                                             |
| Isolated release line (no upstream updater crossover) | version policy in `spec-0.2.0.md` § Version; P0-8 decision closes it                                                                                        |

## Gaps that block the tag

1. **P0-8** — version-story decision (spec § Version).
2. **Full-suite green** — `vp run -r test` must pass (recorded per run).
3. Everything else marked "gap" above is scheduled work, explicitly not a
   tag gate unless the plan's quality-gate list says otherwise; P1-3 (other
   providers' silent-death audit) is the first candidate for the next
   stabilization checkpoint.
