# d4research v0.2.0 — Dependable First Run

**Status:** In progress — post-upstream stabilization tranche closed and committed; codex event-pipeline fix landed; release approval pending

**Planning input:** CEO product-readiness review, 2026-08-10

**Release theme:** Stability, quality, and productization

## Dogfood checkpoint — 2026-08-11

The source/Caddy dogfood candidate now includes the complete product feature tranche:

- the composer's unified **Workflows** menu owns Chat/Plan, named Dev pipelines, named Research
  scenarios, agent access, and one Research/Dev target policy;
- target substitution is literal and auditable: **Exact targets only** fails closed, while
  **Use labeled fallback** accepts only an authored `FALLBACK directive`; requested and actual
  provider/model identifiers are recorded separately;
- normal provider startup and sends, connected unary RPCs, and checkpoint work have deadlines;
  blocked startup can be stopped, restart reconciliation terminates orphaned projected sessions,
  failed interrupts become session errors, and Cursor/Grok/Junie unexpected ACP exits remove the
  stale session with the real exit code;
- provider snapshots expose installation, authentication, reachability, model state, freshness,
  `canStart`, and remediation, with shared web/mobile/server enforcement;
- oversized documents support source-constrained relevant-chunk search, visible Memo lifecycle,
  same-page retry, attachment-only draft retention, and missing/incomplete document results;
- a generic bounded `starter` research scenario, checked-in kitten-fluffiness corpus,
  controller-owned run manifest, and web/desktop Markdown export are present;
- source-only first run, concepts, troubleshooting, background deployment, remote source commands,
  and release applicability are documented without borrowing the upstream `npx t3` distribution.

Focused validation recorded for this checkpoint: 462 affected unit/integration tests, five affected
package typechecks, and 19/19 isolated Playwright product specs. Native mobile UI and signed desktop
artifact verification are not available on this Linux host.

This checkpoint authorizes the local Caddy dogfood deployment requested by the CEO. It does not
authorize a public `v0.2.0` tag or artifact publication. P0 distribution identity, checksums,
provenance, clean native install/update/uninstall smoke, the real-provider cross-handoff acceptance
journey, and public website promotion remain explicit release-approval gates.

## Implementation checkpoint — 2026-08-11

The post-upstream regression tranche is closed in the working tree:

- historical d4 migration slots 37/38 are preserved, displaced upstream changes
  run idempotently at 43/44, and incompatible manifests fail before schema
  mutation;
- web Agents, pull-request detail, Tasks/Plan, System Monitor, auto-open Tasks,
  and background-work controls are reachable again;
- mobile scoped skills, named development pipelines, and structured user-message
  context rendering are reachable again, with fail-closed provider capability
  checks and project-scoped skill isolation;
- an exact 132,277-character attachment survives real local Memo persistence as
  a provider-safe reference, and a forced persistence failure no longer requires
  a page reload before retry;
- the composed server artifact is cleaned once and rejected when required
  server, client, or Tool Guard files are absent or empty.

Focused unit tests, affected-package typechecks, isolated browser checks, and a
multi-seat CTO panel pass this tranche. Native mobile runtime verification is
not recorded because no simulator or emulator is available on the current Linux
host.

This checkpoint does **not** close the release. P0 distribution smoke tests, the
full P1/P2 lifecycle and provider-readiness matrices, the cross-provider P3
handoff journey, the P4 starter scenario/export, P5 documentation, clean-machine
packaging, and explicit tag/publish/deploy approval remain open gates.

## Dogfood stabilization checkpoint — 2026-08-14

Dogfooding surfaced a P1-gate violation: every codex turn since the 2026-08-11
deployment hung indefinitely in "starting" while the Codex CLI ran the turn to
completion unheard. Three pipeline links could die silently and totally when a
single event misbehaved. All three are fixed and regression-covered:

- the app-server client isolates notification handlers, so one failing or
  throwing handler no longer starves the handlers registered after it
  (including the event pump); a client test drives the poison-handler case
  against the mock peer;
- the session runtime's notification pump and the adapter's event fiber now
  skip-and-log poison events and log pump death loudly instead of vanishing;
- the adapter's `streamEvents` is one stable stream rather than a fresh
  destructive queue consumer per property access.

This closes the "no known turn can remain indefinitely running after its
provider exits" quality gate for the codex path specifically; the P1 matrix
across the other providers remains open. Focused validation for this
checkpoint: 321 unit/integration tests across the 13 touched test files, 53
codex-path tests, and clean typechecks for the server, web, shared, and
effect-codex-app-server packages. The served artifact is rebuilt from this
tree and verified complete.

## Full-suite gate checkpoint — 2026-08-14 (late)

Running the complete repository suite for the first time since the upstream
sync surfaced 12 failures in three groups; all are fixed:

- migrate-dev-db slot-collision reporting: the server migration runner's
  new die-loudly slot guard fired before the script's typed pre-check; the
  snapshot is now verified before it is migrated, restoring the
  MigrateDevDbSlotCollisionError contract.
- 10 orchestration-engine integration tests and the server transfer-budget
  test: the fail-closed provider-readiness gate (a deliberate deliverable of
  the dogfood candidate) correctly refuses turns whose provider is missing
  from the registry, and the integration harness registered no providers,
  so every turn silently failed into a 40-second receipt timeout. The
  harness now registers ready claudeAgent and codex snapshots. Bisected
  root-cause: green at the upstream merge, red at the dogfood-candidate
  commit, pinned to the readiness gate in ProviderCommandReactor combined
  with an empty registry mock.

Lesson recorded for the test spec: integration waits observe success
receipts only; a fail-closed rejection is indistinguishable from a hang
until the timeout. Failure events deserve assertions of their own.

## Executive decision

`v0.2.0` will make the existing research product dependable before expanding
its research surface.

The release succeeds when a technically capable new user can install
d4research, connect an available provider, run one bounded research scenario,
recover from ordinary failures, and export an understandable result without
knowing the repository architecture.

This replaces the earlier proposal to make bounded scaffold-improvement
infrastructure the center of `v0.2.0`. That research direction remains valid,
but it moves behind a stable product floor. Recursive improvement is not a
`v0.2.0` deliverable.

## Product promise for this release

> One authoritative investigation across the AI coding agents you already use,
> with local context, bounded delegation, visible failures, and a recoverable
> path from question to evidence-bearing result.

The release must preserve these existing product contracts:

- the visible thread is authoritative across provider handoffs;
- research delegation is bounded and never implied when it did not run;
- Memo, voice, operations, and Tool Guard integrations remain local-first;
- provider-native permissions remain the default;
- web, desktop, mobile, and remote connection paths remain honest about their
  supported behavior.

## Priority scope

### P0 — Release integrity and distribution recovery

Resolve the mismatch between the `v0.1.0` release story and its distributable
artifacts before promoting another version.

Deliverables:

- declare `v0.1.0` source-only where no verified binary exists;
- define the minimum supported `v0.2.0` artifact matrix;
- generate checksums and provenance for published artifacts;
- run clean install, first launch, update, and uninstall smoke tests;
- make version and update-channel behavior unambiguous for the d4research fork;
- document supported platforms without borrowing unsupported upstream claims.

Exit gate: the release page, documentation, updater behavior, and downloadable
artifacts tell the same story.

### P1 — Turn, process, and connection stability

Make every normal lifecycle transition terminate in an explicit, recoverable
state.

Cover at minimum:

- provider process exits, malformed output, authentication failure, and timeout;
- user cancellation during orchestration, delegation, and checkpointing;
- server restart, websocket reconnect, remote latency, and duplicate receipts;
- browser refresh or device reconnect during an active turn;
- stale pipeline banners, stuck composer state, and misleading activity labels;
- provider child-process cleanup and prevention of orphaned work;
- budget exhaustion and partial delegate failure.

Exit gate: focused tests prove that each path becomes completed, failed,
cancelled, or recoverable; none remains indefinitely "running."

### P2 — Provider readiness and actionable diagnostics

Turn provider setup from implicit trial-and-error into an observable readiness
contract.

Deliverables:

- distinguish installed, authenticated, reachable, and model-ready states;
- add opt-in real CLI probes for supported providers;
- record exact requested and resolved targets where providers expose them;
- prevent permissive fixtures from hiding provider CLI shape drift;
- surface corrective setup guidance next to the failing provider;
- preserve adapter boundaries and do not add a new provider in this release.

Exit gate: a user can tell before starting research whether the selected
provider is usable and what to fix when it is not.

### P3 — Large-context and Memo reliability

Productize the recent oversized-attachment fallback as a complete lifecycle,
not only a send-time workaround.

Deliverables:

- store an oversized document in local Memo without silently truncating it;
- send a compact, provider-safe reference instead of overflowing the request;
- retrieve only relevant chunks during the active turn;
- make attachment storage, indexing, failure, retry, and removal visible;
- keep the composer usable after any size-limit or indexing error;
- test reload, provider handoff, cancellation, and missing-Memo recovery;
- document privacy and storage location in user language.

Exit gate: the canonical large-document test completes across a handoff, and a
failed attachment never requires a page reload to restore the Send action.

### P4 — First-run scenario and evidence-bearing result

Ship one generic, public starter scenario that demonstrates the product without
publishing DIMAGGI's proprietary research pipelines.

The starter scenario must:

- have an explicit question, bounded research budget, and stopping condition;
- show which delegates ran, failed, or were skipped;
- distinguish findings, source evidence, uncertainty, and unresolved questions;
- export a stable Markdown artifact with run provenance;
- work against a small checked-in sample corpus for deterministic onboarding;
- remain editable and explain which parts are safe to customize.

The repository contains the generic orchestration engine and starter scenario,
not DIMAGGI's production article or research pipeline definitions.

Exit gate: a new user can run the sample and understand the result without
reading internal traces or source code.

### P5 — Onboarding, supportability, and public product description

Replace repository-shaped onboarding with a product-shaped path.

Deliverables:

- a five-minute installation and first-run guide;
- a readiness checklist covering server, provider, project, and local Memo;
- concise concepts for environment, project, thread, turn, handoff, delegation,
  and checkpoint;
- troubleshooting for the failure states exercised in P1–P3;
- a public DIMAGGI product page using only shipped, verifiable claims;
- clear early-access and source/distribution language;
- a release checklist that records web, desktop, mobile, provider, and local vs
  remote applicability.

Exit gate: documentation and the website describe the product a user actually
receives in `v0.2.0`.

## Six-workstream schedule

The sequence is outcome-gated. Workstreams may overlap where they do not share
the same failure surface, but a later gate cannot waive an earlier one.

| Workstream | Focus                         | Demonstrable outcome                                                                       |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| 0          | Release recovery and baseline | Accurate `v0.1.0` story; canonical first-run and failure baseline recorded                 |
| 1          | Lifecycle stability           | Provider failure, cancel, restart, reconnect, and budget exhaustion terminate honestly     |
| 2          | Provider readiness            | Real opt-in probes and actionable setup states work across supported adapters              |
| 3          | Context and result quality    | Oversized document survives Memo storage, handoff, retrieval, reload, and export           |
| 4          | First-run productization      | A clean user completes the public starter scenario and understands the result              |
| 5          | Cross-surface hardening       | Focused regression suite, clean packaging smoke tests, docs, and website are release-ready |

The release candidate is cut only after all six outcomes are demonstrated from
a clean environment. Passing time is not a substitute for passing the gates.

## Canonical acceptance journey

The integrated release test is one user journey:

1. install d4research from the documented distribution path;
2. start the environment and complete pairing where required;
3. see which providers are ready before opening a turn;
4. open the starter research scenario;
5. attach a document larger than one provider request limit;
6. store it locally in Memo and send a compact reference;
7. begin bounded research and see the delegates that actually ran;
8. interrupt or disconnect once, reconnect, and continue or stop cleanly;
9. hand the visible thread to another ready provider without forking history;
10. export a Markdown result containing findings, evidence, uncertainty, run
    provenance, and any delegate failures;
11. restart the app and recover the authoritative thread and result.

## Quality gates

Before any `v0.2.0` tag is proposed:

- no known turn can remain indefinitely running after its provider exits;
- cancellation and reconnect tests use receipts or terminal events, not sleeps;
- no attachment error can permanently disable Send;
- no published provider target is accepted only because a permissive mock says
  it is valid;
- the starter scenario is bounded and does not recursively delegate;
- large-thread and websocket payload behavior shows no material regression;
- process-tree cleanup is verified for every provider path touched;
- the supported artifact matrix passes clean-machine smoke tests;
- web and desktop complete the integrated journey;
- mobile and remote clients render every affected state honestly, with any
  unsupported action explicitly disabled or explained;
- user documentation and public copy contain no unsupported performance,
  safety, independence, or distribution claim;
- no critical or major unresolved finding is deferred into the tag.

## Deliberately out of `v0.2.0`

- recursive scaffold improvement or RSI runtime infrastructure;
- model-generated mutation, evaluator evolution, or autonomous promotion;
- DIMAGGI's proprietary production research and article pipelines;
- new provider adapters;
- hosted accounts, hosted memory, or hosted synchronization;
- scenario marketplace or community package registry;
- broad new voice, monitoring, Mission Control, or enterprise administration;
- autonomous swarms or recursive delegation;
- direct repository commits, releases, or deployments by a research candidate.

## Release sequence after `v0.2.0`

| Milestone           | Theme                            | Exit claim                                                                                          |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `v0.2.0`            | Dependable first run             | A new user can complete and recover one bounded research journey                                    |
| `v0.3.0`            | Evidence-bearing deliverables    | Results are comparable, portable, and reviewable across repeated runs                               |
| `v0.4.0`            | Repeatability and evaluation     | Scenario versions can be evaluated against frozen fixtures and explicit quality gates               |
| Later research gate | Bounded declarative improvement  | A constrained harness change can be evaluated without exposing control authority                    |
| `v1.0.0`            | Supported research control plane | Installation, recovery, privacy, performance, and multi-surface operation meet a stable support bar |

No version is committed for recursive inheritance or source-code mutation.
Those require a separate CEO and security gate after the core product is
dependable.

## Approval boundary

Approval of this plan authorizes issue creation and implementation planning.
It does not authorize a tag, publication, website deployment, or production
release. Each remains a separate explicit gate.
