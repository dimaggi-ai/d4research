# Product contracts

> For maintainers. Generated summary of `packages/contracts/src` — the typed surface every client
> and the server agree on. One section per module; regenerate rather than hand-drift. All schemas
> are Effect Schema; `index.ts` re-exports every module listed here (plus `./settings` and
> `./relay` as dedicated subpath exports).

## baseSchemas

Shared primitive schemas and branded identifiers used by every other module: `TrimmedString`,
`TrimmedNonEmptyString`, `NonNegativeInt`, `PositiveInt`, `PortSchema`, `IsoDateTime`,
`ForwardCompatibleArray`, and the id brands `ThreadId`, `ProjectId`, `EnvironmentId`, `CommandId`,
`EventId`.

## auth

The authorization vocabulary for an environment. Defines `ServerAuthPolicy`, bootstrap/session
method enums, and the scope constants that gate every RPC and HTTP route:
`AuthOrchestrationReadScope`, `AuthOrchestrationOperateScope`, `AuthTerminalOperateScope`,
`AuthReviewWriteScope`, `AuthAccessReadScope`/`WriteScope`, `AuthRelayReadScope`/`WriteScope`, and
the aggregate `AuthEnvironmentScopes`. Enforced server-side in `ws.ts` via `RPC_REQUIRED_SCOPE`.

## background

Client/background activity coordination: `BackgroundScope`, `ClientKind`, client activity
reporting (`ClientActivityReportInput`, `ClientActivityLease`), and host power/thermal state
(`HostPowerSnapshot`, `HostPowerThermalState`, `HostPowerSource`). Used by the client-runtime
background-activity layers that differ between web and mobile.

## environment

Descriptors for an execution environment: platform (`ExecutionEnvironmentPlatform` os/arch),
capabilities including self-update (`ServerSelfUpdateMethod`, `ServerSelfUpdateCapability`),
`ExecutionEnvironmentDescriptor`, `EnvironmentConnectionState`, and `RepositoryIdentityLocator`.
Consumed by all clients to describe and pick environments.

## environmentHttp

Common typed error surface for environment HTTP routes: `EnvironmentRequestInvalidError`,
`EnvironmentAuthInvalidError`, `EnvironmentScopeRequiredError`,
`EnvironmentOperationForbiddenError`, `EnvironmentResourceNotFoundError`,
`EnvironmentInternalError`, unioned as `EnvironmentHttpCommonError`, each with reason enums.

## relayClient

Status of the hosted relay client on an environment: `RelayClientStatus`, install progress
stages/events, failure reasons, and `RelayClientInstallFailedError`. Governs the "connect this
environment to T3 Connect" flow.

## relay

The relay's own record types (see also `infra/relay`): device registration
(`RelayDeviceRegistrationRequest`, `RelayClientDeviceRecord`, `RelayListDevicesResponse`), APNs
environment, live-activity registration, and agent-awareness preferences
(`RelayAgentAwarenessPlatform`/`Phase`/`Preferences`) behind mobile notifications.

## desktopBootstrap

`DesktopBackendBootstrap` — the handshake payload the Electron shell uses to supervise and connect
to its desktop-scoped backend.

## remoteAccess

Advertised endpoints for reaching an environment: `AdvertisedEndpoint` with provider kind
(Tailscale et al.), reachability, hosted-HTTPS compatibility, source, and status. Backs
Settings → Connections and the remote-access picker.

## ipc

Desktop (Electron) IPC shapes: context menus (`ContextMenuItemSchema`), desktop runtime info,
update state and channels (`DesktopUpdateStatusSchema`, `DesktopUpdateChannelSchema`), theme, and
app branding (`DesktopAppBrandingSchema`). Desktop-only.

## terminal

Server-owned PTY sessions: `TerminalOpenInput`, `TerminalAttachInput` (server stream of raw
bytes), `TerminalWriteInput`, `TerminalResizeInput`, `TerminalClearInput`, `TerminalRestartInput`,
`TerminalCloseInput`, keyed by thread (`TerminalThreadInput`, `DEFAULT_TERMINAL_ID`). Renderer
choice (libghostty-vt) never crosses this wire.

## provider

The adapter-facing session/turn surface: `ProviderSession`, `ProviderSessionStartInput`,
`ProviderSendTurnInput` (text plus attachments), `ProviderTurnStartResult`,
`ProviderInterruptTurnInput`, `ProviderStopSessionInput`, `ProviderRespondToRequestInput`
(approvals), `ProviderRespondToUserInputInput`, and the `ProviderEvent` union adapters emit.

## providerInstance

Configured provider identity: `ProviderDriverKind` (open slug: `codex`, `claudeAgent`, `agy`,
`cursor`, `grok`, `junie`, `opencode`, …), `ProviderInstanceId`/`ProviderInstanceRef`,
per-instance environment variables (`ProviderInstanceEnvironmentVariable`, with `sensitive`
flag), `ProviderInstanceConfig`/`ProviderInstanceConfigMap`, and `defaultInstanceIdForDriver`.
This is what Settings → Providers edits.

## providerRuntime

Normalized runtime event stream every driver maps its transport into: session/thread/turn state
enums (`RuntimeSessionState`, `RuntimeThreadState`, `RuntimeTurnState`), item and request
taxonomies (`CanonicalItemType`, `CanonicalRequestType`, `ToolLifecycleItemType`), the
`ProviderRuntimeEventType` union with payloads (`SessionStartedPayload`, `SessionExitedPayload`,
`ThreadStateChangedPayload`, `ThreadMetadataUpdatedPayload`, …), raw passthrough
(`RuntimeEventRaw`), error classes (`RuntimeErrorClass`), and `ThreadTokenUsageSnapshot` — the
token/cost report that feeds the context-window meter.

## model

Model and option descriptors: `ModelCapabilities`, provider option descriptors
(`SelectProviderOptionDescriptor`, `BooleanProviderOptionDescriptor`,
`ProviderOptionDescriptor`), and user selections (`ProviderOptionSelection(s)`). Drives the model
picker and per-model option UI.

## keybindings

User keybinding storage limits and command vocabulary: `KeybindingCommand` (thread commands,
model-picker jump commands, script-run pattern), `KeybindingValue`, `KeybindingWhen` (bounded
expression depth), and count/length maximums.

## server

The provider snapshot clients render: `ServerProvider` (instanceId, driver, display metadata,
enabled/installed, `ServerProviderState` status, `ServerProviderAuth`, models
(`ServerProviderModel`), `slashCommands`, `skills` (`ServerProviderSkill`), availability,
`versionAdvisory` (`ServerProviderVersionAdvisory`), `updateState`
(`ServerProviderUpdateStatus`), and `usage: ServerProviderUsage` — plan type, rolling
`ServerProviderUsageWindow`s with utilization/reset, credits, `limitReached`). Plus
`ServerConfigIssue` and `ServerProviders`.

## settings

`ServerSettings` — the server-persisted configuration tree: appearance (font sizes/families,
smoothing), sidebar ordering/grouping/preview counts and auto-settle, timestamp format, thread
defaults, `MemoryConnectorSettings` (`memory.localEnabled`, local Memo base URL), and
`HandoffSettings` with `HandoffContextCompressionSettings` (`enabled`, `instanceId`, `model`,
`maxInputCharacters` default 6000, `maxOutputCharacters` default 2000, `customPrompt`). Unions are
decoded forward-compatibly so older clients survive newer config.

## git

Git action progress and stacked actions: `GitStackedAction`, progress phases/kinds/streams,
run-action toasts, `VcsRef`, `GitResolvedPullRequest`, and inputs like `VcsStatusInput`,
`VcsPullInput`. Backs the toolbar Git controls.

## vcs

The VCS driver capability surface: `VcsDriverKind`, `VcsDriverCapabilities`, repository identity,
freshness (`VcsFreshness`), remotes and workspace file listings, and process-error contexts.
Implemented by the Git driver in `apps/server/src/vcs/`.

## sourceControl

Hosting-provider integration: `SourceControlProviderKind` (GitHub, GitLab, Bitbucket, Azure
DevOps), provider info/auth status, change requests (`ChangeRequest`, `ChangeRequestState`),
repository lookup/clone/publish shapes (`SourceControlRepositoryInfo`, clone URLs, visibility,
protocol). Backs Settings → Source control and the PR/MR flows.

## orchestration

The event-sourced core: command and event unions for projects and threads (client-dispatchable
commands like `thread.create`, `thread.turn.start`, `thread.approval.respond`,
`thread.checkpoint.revert`; internal events like `thread.message.assistant.delta`), the read
model (`OrchestrationProject`, `OrchestrationThread`, messages, activities — including
`context-window.updated` — checkpoints, session state), mode enums (`RuntimeMode`:
`approval-required` | `auto-accept-edits` | `auto` | `full-access`, `ProviderInteractionMode`:
`default` | `plan`, `AssistantDeliveryMode`: `streaming` | `buffered`), approval policy/sandbox
enums, `ModelSelection`, and `ORCHESTRATION_WS_METHODS`.

## t3ProjectFile

The `t3.json` project file: `T3_PROJECT_FILE_NAME`, `T3_PROJECT_FILE_SCHEMA_URL`,
`T3ProjectFile` and `T3ProjectFileScript` (project-declared scripts, runnable via keybindings).

## editor

External editor/IDE launching: `EDITORS` catalog, `EditorId`, `EditorLaunchStyle`,
`LaunchEditorInput`, and the `ExternalLauncherError` union (unknown editor, command not found,
spawn failures). Backs the Open-in picker.

## project

Workspace browsing and search: `ProjectEntry`/`ProjectEntryKind`, entry search
(`ProjectSearchEntriesInput`/`Result` — feeds `@` mentions), content search
(`ProjectSearchContentsInput`, `ProjectContentMatch` with ranges), and directory listing inputs.

## filesystem

Generic host filesystem browsing for pickers: `FilesystemBrowseInput`, `FilesystemBrowseEntry`,
`FilesystemBrowseResult`, `FilesystemBrowseFailure`, `FilesystemBrowseError`.

## assets

Workspace asset (image/attachment) resolution: `AssetResource`, signed URL creation
(`AssetCreateUrlInput`/`Result`), and a family of tagged errors covering workspace context
resolution, path validation, preview type checks, attachment lookup, and project favicon
resolution.

## review

Diff review data: `ReviewDiffPreviewInput`/`Result`, diff sources (`ReviewDiffPreviewSourceKind`),
file contents requests (`ReviewDiffFileContentsInput`/`Result`), and `ReviewDiffPreviewError`.
Backs the changed-files/diff review UI.

## preview

Collaborative preview/browser sessions: `PreviewTabId`, viewport model (`PreviewViewportSize`,
`PreviewViewportSetting` = fill | freeform | preset, `PREVIEW_VIEWPORT_PRESET_IDS` device catalog,
dimension clamps 240–3840), `PreviewNavStatus`, `PreviewSessionSnapshot`, the `preview.*` RPC
inputs (`PreviewOpenInput`, `PreviewNavigateInput`, `PreviewResizeInput`, `PreviewRefreshInput`,
`PreviewCloseInput`, `PreviewListInput`/`Result`, `PreviewReportStatusInput`), `PreviewEvent`
stream, discovered local dev servers (`DiscoveredLocalServer(List)`), and lookup/URL errors.

## previewAutomation

The agent-facing browser automation protocol: `PREVIEW_AUTOMATION_OPERATIONS` (`status`, `open`,
`navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `evaluate`, `waitFor`,
`recordingStart`, `recordingStop`, plus v2 `resize` and `setColorScheme`;
`PREVIEW_AUTOMATION_V1_OPERATIONS` for older desktop hosts), per-operation input/result structs
(`PreviewAutomationOpenInput`, `PreviewAutomationNavigateInput` with `BrowserNavigationTarget`,
click/type/press/scroll/evaluate/waitFor inputs), tab targeting
(`PreviewAutomationTabTargetInput`), `PreviewAutomationStatus`, element and console entry shapes.

## resourceTelemetry

The resource-monitor protocol (native monitor binaries → server → System panel):
`RESOURCE_MONITOR_PROTOCOL_VERSION`, process identity/category/samples
(`ResourceMonitorProcessSample`), capabilities, external process registration, configure/set
commands, and source status. See [resource-telemetry.md](./resource-telemetry.md).

## toolGuardPolicy

Plain TypeScript interfaces (not Effect Schema) for the Tool Guard policy document:
`ToolGuardPolicyMode` (`enforcement` | `shadow`), `ToolGuardRuleEffect`
(`deny` | `escalate` | `allow`), `ToolGuardPolicyCondition`, `ToolGuardPolicyRule`,
`ToolGuardPolicy`. Mirrors `ops/tool-guard/profiles/*/policy.yaml`; see
[tool-guard.md](./tool-guard.md).

## rpc

The assembled WebSocket contract: `WS_METHODS` names every unary and streaming member
(orchestration dispatch/subscriptions, `terminal.*`, `preview.*`, keybindings, settings get/update,
provider refresh/update, server update with progress, source-control discovery, diagnostics,
resource telemetry, process signals, …), and the per-method `Ws…Rpc` definitions are aggregated
into the `WsRpcGroup` served at `/ws`. `RPC_REQUIRED_SCOPE` (server-side) pairs each method with an
`auth` scope.
