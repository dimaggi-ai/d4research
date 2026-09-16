import * as Schema from "effect/Schema";

// MSP v1 wire shapes from the Muse exported schema (2026-09-16).
// Open enums intentionally accept future host values.
export const CapabilityName = Schema.String;
export type CapabilityName = typeof CapabilityName.Type;

export const PlatformFamily = Schema.Union([Schema.Literal("unix"), Schema.Literal("windows")]);
export type PlatformFamily = typeof PlatformFamily.Type;

export const PlatformOs = Schema.Union([
  Schema.Literal("macos"),
  Schema.Literal("linux"),
  Schema.Literal("windows"),
]);
export type PlatformOs = typeof PlatformOs.Type;

export const SchemaInfo = Schema.Struct({
  fingerprint: Schema.String,
  version: Schema.Number,
});
export type SchemaInfo = typeof SchemaInfo.Type;

export const ServerInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});
export type ServerInfo = typeof ServerInfo.Type;

export const SessionDurability = Schema.String;
export type SessionDurability = typeof SessionDurability.Type;

export const InitializeResult = Schema.Struct({
  experimentalApi: Schema.Boolean,
  grantedCapabilities: Schema.Array(CapabilityName),
  museHome: Schema.String,
  platformFamily: PlatformFamily,
  platformOs: PlatformOs,
  schema: SchemaInfo,
  serverInfo: ServerInfo,
  sessionDurability: Schema.optionalKey(SessionDurability),
  userAgent: Schema.String,
});
export type InitializeResult = typeof InitializeResult.Type;

export const ApprovalMode = Schema.Union([
  Schema.Literal("allowAll"),
  Schema.Literal("promptUnmatched"),
  Schema.Literal("onRequest"),
  Schema.Literal("denyUnmatched"),
]);
export type ApprovalMode = typeof ApprovalMode.Type;

export const ApprovalModeSource = Schema.String;
export type ApprovalModeSource = typeof ApprovalModeSource.Type;

export const EffectiveApprovalModeState = Schema.Struct({
  lastCommandId: Schema.Union([Schema.String, Schema.Null]),
  mode: ApprovalMode,
  source: ApprovalModeSource,
});
export type EffectiveApprovalModeState = typeof EffectiveApprovalModeState.Type;

export const AttentionFlag = Schema.String;
export type AttentionFlag = typeof AttentionFlag.Type;

export const ForkProvenance = Schema.Struct({
  commandId: Schema.String,
  cutCursor: Schema.String,
  cutExplicit: Schema.Boolean,
  sessionId: Schema.String,
});
export type ForkProvenance = typeof ForkProvenance.Type;

export const SessionStatus = Schema.String;
export type SessionStatus = typeof SessionStatus.Type;

export const Session = Schema.Struct({
  activeTurnId: Schema.Union([Schema.String, Schema.Null]),
  approvalMode: Schema.optionalKey(EffectiveApprovalModeState),
  attention: Schema.optionalKey(Schema.Array(AttentionFlag)),
  branch: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  firstUserPrompt: Schema.optionalKey(Schema.String),
  forkedFrom: Schema.Union([ForkProvenance, Schema.Null]),
  lastActivityAt: Schema.optionalKey(Schema.String),
  modelId: Schema.Union([Schema.String, Schema.Null]),
  name: Schema.optionalKey(Schema.String),
  path: Schema.String,
  providerId: Schema.Union([Schema.String, Schema.Null]),
  sessionId: Schema.String,
  status: SessionStatus,
  title: Schema.optionalKey(Schema.String),
  turnCount: Schema.Number,
  updatedAt: Schema.String,
  workspaceRoot: Schema.Union([Schema.String, Schema.Null]),
});
export type Session = typeof Session.Type;

export const SessionStartResult = Schema.Struct({
  session: Session,
  viewCursor: Schema.String,
});
export type SessionStartResult = typeof SessionStartResult.Type;

export const SessionResumeResult = Schema.Struct({
  session: Session,
  viewCursor: Schema.String,
});
export type SessionResumeResult = typeof SessionResumeResult.Type;

export const ItemReadOutputResult = Schema.Struct({
  byteLen: Schema.Number,
  content: Schema.String,
  encoding: Schema.String,
  eof: Schema.Boolean,
  mediaType: Schema.String,
  offsetBytes: Schema.Number,
});
export type ItemReadOutputResult = typeof ItemReadOutputResult.Type;

// Per-session MCP servers for `session/start` and `session/resume` `config`
// (MSP schema SessionConfig/SessionMcpServerConfig). Only the streamableHttp
// arm is used: the adapter injects the per-thread `t3-code` toolkit endpoint.
export const SessionMcpServerMode = Schema.Union([
  Schema.Literal("required"),
  Schema.Literal("optional"),
]);
export type SessionMcpServerMode = typeof SessionMcpServerMode.Type;

export const SessionMcpStdioServer = Schema.Struct({
  transport: Schema.Literal("stdio"),
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  framing: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(SessionMcpServerMode),
});
export type SessionMcpStdioServer = typeof SessionMcpStdioServer.Type;

export const SessionMcpStreamableHttpServer = Schema.Struct({
  transport: Schema.Literal("streamableHttp"),
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  mode: Schema.optionalKey(SessionMcpServerMode),
});
export type SessionMcpStreamableHttpServer = typeof SessionMcpStreamableHttpServer.Type;

export const SessionMcpServerConfig = Schema.Union([
  SessionMcpStdioServer,
  SessionMcpStreamableHttpServer,
]);
export type SessionMcpServerConfig = typeof SessionMcpServerConfig.Type;

export const SessionConfig = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, SessionMcpServerConfig)),
});
export type SessionConfig = typeof SessionConfig.Type;

export const TurnStartDisposition = Schema.String;
export type TurnStartDisposition = typeof TurnStartDisposition.Type;

export const CommandStatus = Schema.String;
export type CommandStatus = typeof CommandStatus.Type;

export const TurnStartResult = Schema.Struct({
  commandId: Schema.String,
  disposition: TurnStartDisposition,
  startedNewTurn: Schema.Boolean,
  status: CommandStatus,
  turnId: Schema.String,
});
export type TurnStartResult = typeof TurnStartResult.Type;

export const RecordPosition = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Number,
});
export type RecordPosition = typeof RecordPosition.Type;

export const StreamRef = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
});
export type StreamRef = typeof StreamRef.Type;

export const SourceRange = Schema.Struct({
  first: RecordPosition,
  last: RecordPosition,
  stream: StreamRef,
});
export type SourceRange = typeof SourceRange.Type;

export const TurnStartedParams = Schema.Struct({
  commandId: Schema.String,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  turnId: Schema.String,
  viewCursor: Schema.String,
});
export type TurnStartedParams = typeof TurnStartedParams.Type;

export const TurnErrorKind = Schema.String;
export type TurnErrorKind = typeof TurnErrorKind.Type;

export const TurnError = Schema.Struct({
  kind: TurnErrorKind,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type TurnError = typeof TurnError.Type;

export const TurnTerminal = Schema.String;
export type TurnTerminal = typeof TurnTerminal.Type;

export const TokenUsage = Schema.Struct({
  cacheReadTokens: Schema.optionalKey(Schema.Number),
  cacheWriteTokens: Schema.optionalKey(Schema.Number),
  cachedTokens: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.Number,
});
export type TokenUsage = typeof TokenUsage.Type;

export const TurnCompletedParams = Schema.Struct({
  durationMs: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(TurnError),
  reason: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  sourceRange: SourceRange,
  terminal: TurnTerminal,
  timeToFirstTokenMs: Schema.optionalKey(Schema.Number),
  turnId: Schema.String,
  usage: Schema.optionalKey(TokenUsage),
  viewCursor: Schema.String,
});
export type TurnCompletedParams = typeof TurnCompletedParams.Type;

export const MessageAttachment = Schema.Struct({
  height: Schema.optionalKey(Schema.Number),
  mediaType: Schema.String,
  type: Schema.String,
  width: Schema.optionalKey(Schema.Number),
});
export type MessageAttachment = typeof MessageAttachment.Type;

export const BackgroundInitiator = Schema.String;
export type BackgroundInitiator = typeof BackgroundInitiator.Type;

export const SubagentControlStatus = Schema.String;
export type SubagentControlStatus = typeof SubagentControlStatus.Type;

export const ItemKind = Schema.String;
export type ItemKind = typeof ItemKind.Type;

export const CompactionOutcome = Schema.String;
export type CompactionOutcome = typeof CompactionOutcome.Type;

export const OutputRefAvailability = Schema.String;
export type OutputRefAvailability = typeof OutputRefAvailability.Type;

export const OutputRef = Schema.Struct({
  availability: OutputRefAvailability,
  byteLen: Schema.Number,
  digest: Schema.optionalKey(Schema.String),
  id: Schema.String,
  kind: Schema.String,
  mediaType: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  uri: Schema.String,
});
export type OutputRef = typeof OutputRef.Type;

export const PatchSummary = Schema.Struct({
  added: Schema.Number,
  files: Schema.Number,
  removed: Schema.Number,
});
export type PatchSummary = typeof PatchSummary.Type;

export const ItemStatus = Schema.String;
export type ItemStatus = typeof ItemStatus.Type;

export const CompactionTrigger = Schema.String;
export type CompactionTrigger = typeof CompactionTrigger.Type;

export const Item = Schema.Struct({
  agentPath: Schema.optionalKey(Schema.String),
  approvalId: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(MessageAttachment)),
  background: Schema.optionalKey(Schema.Boolean),
  backgroundInitiator: Schema.optionalKey(BackgroundInitiator),
  callId: Schema.optionalKey(Schema.String),
  childSessionId: Schema.optionalKey(Schema.String),
  childSessionLogPath: Schema.optionalKey(Schema.String),
  commandId: Schema.optionalKey(Schema.String),
  commandText: Schema.optionalKey(Schema.String),
  controlStatus: Schema.optionalKey(SubagentControlStatus),
  depth: Schema.optionalKey(Schema.Number),
  displayText: Schema.optionalKey(Schema.String),
  durationMs: Schema.optionalKey(Schema.Number),
  entryId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  exitSignal: Schema.optionalKey(Schema.Number),
  failureKind: Schema.optionalKey(Schema.String),
  failureReason: Schema.optionalKey(Schema.String),
  fallbackText: Schema.optionalKey(Schema.String),
  generationId: Schema.optionalKey(Schema.Number),
  itemId: Schema.String,
  kind: ItemKind,
  message: Schema.optionalKey(Schema.String),
  objective: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(CompactionOutcome),
  outputRef: Schema.optionalKey(OutputRef),
  patchRef: Schema.optionalKey(OutputRef),
  patchSummary: Schema.optionalKey(PatchSummary),
  providerItemId: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  recordedAt: Schema.optionalKey(Schema.String),
  reminderAgentId: Schema.optionalKey(Schema.String),
  resumeFromRunId: Schema.optionalKey(Schema.String),
  retracted: Schema.optionalKey(Schema.Boolean),
  revision: Schema.Number,
  role: Schema.optionalKey(Schema.String),
  scriptId: Schema.optionalKey(Schema.String),
  status: ItemStatus,
  steered: Schema.optionalKey(Schema.Boolean),
  strategyId: Schema.optionalKey(Schema.String),
  subagentId: Schema.optionalKey(Schema.String),
  summarizedThrough: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.Array(Schema.String)),
  taskId: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  tokensAfter: Schema.optionalKey(Schema.Number),
  tokensBefore: Schema.optionalKey(Schema.Number),
  tool: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(CompactionTrigger),
  triggerSource: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
  turnId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  usage: Schema.optionalKey(TokenUsage),
  visibleOutput: Schema.optionalKey(Schema.String),
  workflowRunId: Schema.optionalKey(Schema.String),
});
export type Item = typeof Item.Type;

export const ItemStartedParams = Schema.Struct({
  item: Item,
  sessionId: Schema.String,
  sourceRange: Schema.optionalKey(SourceRange),
  viewCursor: Schema.String,
});
export type ItemStartedParams = typeof ItemStartedParams.Type;

export const ItemUpdatedParams = Schema.Struct({
  item: Item,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  viewCursor: Schema.String,
});
export type ItemUpdatedParams = typeof ItemUpdatedParams.Type;

export const ItemCompletedParams = Schema.Struct({
  item: Item,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  viewCursor: Schema.String,
});
export type ItemCompletedParams = typeof ItemCompletedParams.Type;

export const ItemDeltaParams = Schema.Struct({
  delta: Schema.String,
  field: Schema.optionalKey(Schema.String),
  itemId: Schema.String,
  sessionId: Schema.String,
  viewCursor: Schema.String,
});
export type ItemDeltaParams = typeof ItemDeltaParams.Type;

export const SessionStatusChangedParams = Schema.Struct({
  attention: Schema.optionalKey(Schema.Array(AttentionFlag)),
  sessionId: Schema.String,
  status: SessionStatus,
  viewCursor: Schema.Union([Schema.String, Schema.Null]),
});
export type SessionStatusChangedParams = typeof SessionStatusChangedParams.Type;

export const CumulativeTokenUsage = Schema.Struct({
  outputTokens: Schema.Number,
  promptTokens: Schema.Number,
  totalTokens: Schema.Number,
});
export type CumulativeTokenUsage = typeof CumulativeTokenUsage.Type;

export const SessionTokenUsageParams = Schema.Struct({
  cumulative: CumulativeTokenUsage,
  durationMs: Schema.optionalKey(Schema.Number),
  finishReason: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String),
  promptTokens: Schema.Number,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  totalTokens: Schema.Number,
  turnId: Schema.String,
  usage: TokenUsage,
  viewCursor: Schema.String,
});
export type SessionTokenUsageParams = typeof SessionTokenUsageParams.Type;

export const ContextPressureLevel = Schema.String;
export type ContextPressureLevel = typeof ContextPressureLevel.Type;

export const SessionContextUsageParams = Schema.Struct({
  pressure: ContextPressureLevel,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  usedTokens: Schema.Number,
  viewCursor: Schema.String,
  windowTokens: Schema.optionalKey(Schema.Number),
});
export type SessionContextUsageParams = typeof SessionContextUsageParams.Type;

export const ApprovalDecision = Schema.String;
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const ApprovalChoiceScope = Schema.String;
export type ApprovalChoiceScope = typeof ApprovalChoiceScope.Type;

export const ApprovalChoice = Schema.Struct({
  acceptsFeedback: Schema.optionalKey(Schema.Boolean),
  choiceId: Schema.String,
  decision: ApprovalDecision,
  label: Schema.String,
  rulePreview: Schema.optionalKey(Schema.String),
  scope: ApprovalChoiceScope,
});
export type ApprovalChoice = typeof ApprovalChoice.Type;

export const ApprovalRequirementRef = Schema.Struct({
  approvalId: Schema.String,
  sourceIndex: Schema.Number,
});
export type ApprovalRequirementRef = typeof ApprovalRequirementRef.Type;

export const ApprovalOrigin = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  url: Schema.optionalKey(Schema.String),
});
export type ApprovalOrigin = typeof ApprovalOrigin.Type;

export const ApprovalStageResolution = Schema.Struct({
  argvPrefix: Schema.optionalKey(Schema.Array(Schema.String)),
  diagnostic: Schema.optionalKey(Schema.String),
  kind: Schema.String,
});
export type ApprovalStageResolution = typeof ApprovalStageResolution.Type;

export const ApprovalSuggestedPrefix = Schema.Struct({
  argvPrefix: Schema.Array(Schema.String),
  label: Schema.String,
});
export type ApprovalSuggestedPrefix = typeof ApprovalSuggestedPrefix.Type;

export const ApprovalStage = Schema.Struct({
  argv: Schema.Array(Schema.String),
  argvComplete: Schema.Boolean,
  position: Schema.Number,
  requirementId: ApprovalRequirementRef,
  resolution: ApprovalStageResolution,
  suggestedPrefix: Schema.optionalKey(ApprovalSuggestedPrefix),
  totalStages: Schema.Number,
});
export type ApprovalStage = typeof ApprovalStage.Type;

export const ApprovalSubject = Schema.Struct({
  access: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  origin: Schema.optionalKey(ApprovalOrigin),
  path: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  protocol: Schema.optionalKey(Schema.String),
  stages: Schema.optionalKey(Schema.Array(ApprovalStage)),
  target: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
  workspaceRoot: Schema.optionalKey(Schema.String),
});
export type ApprovalSubject = typeof ApprovalSubject.Type;

export const ApprovalRequestParams = Schema.Struct({
  approvalId: Schema.String,
  availableChoices: Schema.Array(ApprovalChoice),
  currentRequirementId: ApprovalRequirementRef,
  itemId: Schema.String,
  judgeEscalated: Schema.Boolean,
  protectedWrite: Schema.Boolean,
  rawArgs: Schema.String,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  subject: ApprovalSubject,
  taskId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  turnId: Schema.String,
  viewCursor: Schema.String,
});
export type ApprovalRequestParams = typeof ApprovalRequestParams.Type;

export const ApprovalAmendmentDurability = Schema.String;
export type ApprovalAmendmentDurability = typeof ApprovalAmendmentDurability.Type;

export const ApprovalAmendment = Schema.Struct({
  durability: ApprovalAmendmentDurability,
  rulePreview: Schema.String,
});
export type ApprovalAmendment = typeof ApprovalAmendment.Type;

export const ApprovalPolicyResult = Schema.String;
export type ApprovalPolicyResult = typeof ApprovalPolicyResult.Type;

export const ApprovalResolvedBy = Schema.String;
export type ApprovalResolvedBy = typeof ApprovalResolvedBy.Type;

export const ApprovalStageEvidence = Schema.Struct({
  argv: Schema.Array(Schema.String),
  position: Schema.Number,
  requirementId: ApprovalRequirementRef,
  resolution: ApprovalStageResolution,
  totalStages: Schema.Number,
});
export type ApprovalStageEvidence = typeof ApprovalStageEvidence.Type;

export const ApprovalResolvedParams = Schema.Struct({
  amendment: Schema.optionalKey(ApprovalAmendment),
  approvalId: Schema.String,
  decidedByCommandId: Schema.optionalKey(Schema.String),
  decision: ApprovalDecision,
  itemId: Schema.String,
  policyResult: ApprovalPolicyResult,
  resolvedBy: ApprovalResolvedBy,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  stageEvidence: Schema.Array(ApprovalStageEvidence),
  turnId: Schema.String,
  viewCursor: Schema.String,
});
export type ApprovalResolvedParams = typeof ApprovalResolvedParams.Type;

export const UserInputOptionPreview = Schema.Struct({
  content: Schema.String,
  format: Schema.String,
});
export type UserInputOptionPreview = typeof UserInputOptionPreview.Type;

export const UserInputOption = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  label: Schema.String,
  preview: Schema.optionalKey(UserInputOptionPreview),
});
export type UserInputOption = typeof UserInputOption.Type;

export const UserInputSelectionMode = Schema.Union([
  Schema.Literal("single"),
  Schema.Literal("multiple"),
]);
export type UserInputSelectionMode = typeof UserInputSelectionMode.Type;

export const UserInputSelection = Schema.Struct({
  maxSelections: Schema.optionalKey(Schema.Number),
  minSelections: Schema.optionalKey(Schema.Number),
  mode: UserInputSelectionMode,
});
export type UserInputSelection = typeof UserInputSelection.Type;

export const UserInputQuestion = Schema.Struct({
  header: Schema.String,
  id: Schema.String,
  options: Schema.Array(UserInputOption),
  question: Schema.String,
  selection: UserInputSelection,
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

export const UserInputRequestParams = Schema.Struct({
  autoResolutionMs: Schema.optionalKey(Schema.Number),
  itemId: Schema.String,
  questions: Schema.Array(UserInputQuestion),
  sessionId: Schema.String,
  sourceRange: Schema.optionalKey(SourceRange),
  toolCallId: Schema.String,
  toolName: Schema.String,
  turnId: Schema.String,
  userInputId: Schema.String,
  viewCursor: Schema.String,
});
export type UserInputRequestParams = typeof UserInputRequestParams.Type;

export const UserInputAnswer = Schema.Struct({
  freeText: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  questionId: Schema.String,
  selectedLabel: Schema.optionalKey(Schema.String),
  selectedLabels: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type UserInputAnswer = typeof UserInputAnswer.Type;

export const UserInputClarification = Schema.Struct({
  content: Schema.String,
  format: Schema.String,
});
export type UserInputClarification = typeof UserInputClarification.Type;

export const UserInputOutcome = Schema.String;
export type UserInputOutcome = typeof UserInputOutcome.Type;

export const UserInputSettledParams = Schema.Struct({
  answers: Schema.Array(UserInputAnswer),
  clarification: Schema.Union([UserInputClarification, Schema.Null]),
  decidedByCommandId: Schema.Union([Schema.String, Schema.Null]),
  outcome: UserInputOutcome,
  reason: Schema.Union([Schema.String, Schema.Null]),
  sessionId: Schema.String,
  sourceRange: SourceRange,
  userInputId: Schema.String,
  viewCursor: Schema.String,
});
export type UserInputSettledParams = typeof UserInputSettledParams.Type;

export const ModelCost = Schema.Struct({
  cached: Schema.String,
  currency: Schema.Union([Schema.String, Schema.Null]),
  input: Schema.String,
  output: Schema.String,
});
export type ModelCost = typeof ModelCost.Type;

export const ModelCatalogEntry = Schema.Struct({
  contextLimit: Schema.Union([Schema.Number, Schema.Null]),
  cost: Schema.Union([ModelCost, Schema.Null]),
  description: Schema.Union([Schema.String, Schema.Null]),
  displayLabel: Schema.String,
  isActive: Schema.Boolean,
  isDefault: Schema.Boolean,
  modelId: Schema.String,
  outputLimit: Schema.Union([Schema.Number, Schema.Null]),
  profileId: Schema.Union([Schema.String, Schema.Null]),
  providerId: Schema.String,
  releaseDate: Schema.Union([Schema.String, Schema.Null]),
});
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type;

export const ModelCatalogSource = Schema.String;
export type ModelCatalogSource = typeof ModelCatalogSource.Type;

export const ModelListResult = Schema.Struct({
  models: Schema.Array(ModelCatalogEntry),
  profileId: Schema.Union([Schema.String, Schema.Null]),
  providerId: Schema.String,
  source: ModelCatalogSource,
});
export type ModelListResult = typeof ModelListResult.Type;

export const TurnRetryScheduledParams = Schema.Struct({
  attempt: Schema.Number,
  maxAttempts: Schema.Number,
  nextAttempt: Schema.Number,
  reason: Schema.String,
  retryDelayMs: Schema.Number,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  turnId: Schema.String,
  viewCursor: Schema.String,
});
export type TurnRetryScheduledParams = typeof TurnRetryScheduledParams.Type;

export const ModelChangeSource = Schema.String;
export type ModelChangeSource = typeof ModelChangeSource.Type;

export const SessionModelChangedParams = Schema.Struct({
  modelId: Schema.String,
  providerId: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  source: ModelChangeSource,
  sourceRange: SourceRange,
  viewCursor: Schema.String,
});
export type SessionModelChangedParams = typeof SessionModelChangedParams.Type;

export const ReasoningEffort = Schema.Union([
  Schema.Literal("none"),
  Schema.Literal("minimal"),
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
  Schema.Literal("max"),
  Schema.Literal("ultra"),
]);
export type ReasoningEffort = typeof ReasoningEffort.Type;

export const ReasoningEffortChangeSource = Schema.String;
export type ReasoningEffortChangeSource = typeof ReasoningEffortChangeSource.Type;

export const SessionReasoningEffortChangedParams = Schema.Struct({
  reasoningEffort: ReasoningEffort,
  sessionId: Schema.String,
  source: ReasoningEffortChangeSource,
  sourceRange: SourceRange,
  viewCursor: Schema.String,
});
export type SessionReasoningEffortChangedParams = typeof SessionReasoningEffortChangedParams.Type;

export const SessionApprovalModeChangedParams = Schema.Struct({
  clientName: Schema.String,
  commandId: Schema.String,
  mode: ApprovalMode,
  sessionId: Schema.String,
  source: ApprovalModeSource,
  sourceRange: SourceRange,
  viewCursor: Schema.String,
});
export type SessionApprovalModeChangedParams = typeof SessionApprovalModeChangedParams.Type;

export const SessionModelRouteUnservedParams = Schema.Struct({
  commandId: Schema.String,
  installedProviderId: Schema.String,
  modelId: Schema.String,
  providerId: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  sourceRange: SourceRange,
  viewCursor: Schema.String,
});
export type SessionModelRouteUnservedParams = typeof SessionModelRouteUnservedParams.Type;

export const ViewGapParams = Schema.Struct({
  after: Schema.String,
  next: Schema.String,
  sessionId: Schema.String,
});
export type ViewGapParams = typeof ViewGapParams.Type;
export const ErrorData = Schema.Struct({
  kind: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
export type ErrorData = typeof ErrorData.Type;
export const SessionClosedParams = Schema.Struct({
  sessionId: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
export const ApprovalUpdatedParams = Schema.Struct({
  approvalId: Schema.String,
  availableChoices: Schema.Array(ApprovalChoice),
  change: Schema.Unknown,
  currentRequirementId: ApprovalRequirementRef,
  sessionId: Schema.String,
  sourceRange: SourceRange,
  subject: ApprovalSubject,
  viewCursor: Schema.String,
});
export type ApprovalUpdatedParams = typeof ApprovalUpdatedParams.Type;
const decodeApprovalResolvedParams = Schema.decodeUnknownSync(ApprovalResolvedParams);
const decodeApprovalUpdatedParams = Schema.decodeUnknownSync(ApprovalUpdatedParams);
const decodeItemCompletedParams = Schema.decodeUnknownSync(ItemCompletedParams);
const decodeItemDeltaParams = Schema.decodeUnknownSync(ItemDeltaParams);
const decodeItemStartedParams = Schema.decodeUnknownSync(ItemStartedParams);
const decodeItemUpdatedParams = Schema.decodeUnknownSync(ItemUpdatedParams);
const decodeSessionApprovalModeChangedParams = Schema.decodeUnknownSync(
  SessionApprovalModeChangedParams,
);
const decodeSessionClosedParams = Schema.decodeUnknownSync(SessionClosedParams);
const decodeSessionContextUsageParams = Schema.decodeUnknownSync(SessionContextUsageParams);
const decodeSessionModelChangedParams = Schema.decodeUnknownSync(SessionModelChangedParams);
const decodeSessionModelRouteUnservedParams = Schema.decodeUnknownSync(
  SessionModelRouteUnservedParams,
);
const decodeSessionReasoningEffortChangedParams = Schema.decodeUnknownSync(
  SessionReasoningEffortChangedParams,
);
const decodeSessionStatusChangedParams = Schema.decodeUnknownSync(SessionStatusChangedParams);
const decodeSessionTokenUsageParams = Schema.decodeUnknownSync(SessionTokenUsageParams);
const decodeTurnCompletedParams = Schema.decodeUnknownSync(TurnCompletedParams);
const decodeTurnRetryScheduledParams = Schema.decodeUnknownSync(TurnRetryScheduledParams);
const decodeTurnStartedParams = Schema.decodeUnknownSync(TurnStartedParams);
const decodeUserInputSettledParams = Schema.decodeUnknownSync(UserInputSettledParams);
const decodeViewGapParams = Schema.decodeUnknownSync(ViewGapParams);
export function decodeMspNotification(method: string, params: unknown) {
  switch (method) {
    case "turn/started":
      return {
        method,
        params: decodeTurnStartedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "turn/completed":
      return {
        method,
        params: decodeTurnCompletedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "item/started":
      return {
        method,
        params: decodeItemStartedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "item/updated":
      return {
        method,
        params: decodeItemUpdatedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "item/completed":
      return {
        method,
        params: decodeItemCompletedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "item/delta":
      return {
        method,
        params: decodeItemDeltaParams(params, { onExcessProperty: "preserve" }),
      };
    case "session/statusChanged":
      return {
        method,
        params: decodeSessionStatusChangedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "session/tokenUsage":
      return {
        method,
        params: decodeSessionTokenUsageParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "session/contextUsage":
      return {
        method,
        params: decodeSessionContextUsageParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "approval/resolved":
      return {
        method,
        params: decodeApprovalResolvedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "approval/updated":
      return {
        method,
        params: decodeApprovalUpdatedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "userInput/settled":
      return {
        method,
        params: decodeUserInputSettledParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "turn/retryScheduled":
      return {
        method,
        params: decodeTurnRetryScheduledParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "session/modelChanged":
      return {
        method,
        params: decodeSessionModelChangedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "session/reasoningEffortChanged":
      return {
        method,
        params: decodeSessionReasoningEffortChangedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "session/approvalModeChanged":
      return {
        method,
        params: decodeSessionApprovalModeChangedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "session/modelRouteUnserved":
      return {
        method,
        params: decodeSessionModelRouteUnservedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    case "view/gap":
      return {
        method,
        params: decodeViewGapParams(params, { onExcessProperty: "preserve" }),
      };
    case "session/closed":
      return {
        method,
        params: decodeSessionClosedParams(params, {
          onExcessProperty: "preserve",
        }),
      };
    default:
      return undefined;
  }
}
export type MspNotification = NonNullable<ReturnType<typeof decodeMspNotification>>;
export type MspMethod =
  | "initialize"
  | "subagent/sendMessage"
  | "subagent/followupTask"
  | "subagent/interrupt"
  | "subagent/stop"
  | "subagent/resume"
  | "subagent/reopen"
  | "subagent/close"
  | "subagent/readResult"
  | "session/start"
  | "session/resume"
  | "session/fork"
  | "session/list"
  | "session/read"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "turn/cancel"
  | "turn/unqueue"
  | "session/compact"
  | "session/setModel"
  | "session/rename"
  | "session/setReasoningEffort"
  | "session/userShell"
  | "model/list"
  | "skill/list"
  | "task/background"
  | "task/stop"
  | "task/stopAll"
  | "goal/set"
  | "goal/edit"
  | "goal/clear"
  | "goal/pause"
  | "goal/resume"
  | "workflow/cancel"
  | "workflow/childControl"
  | "view/subscribe"
  | "view/unsubscribe"
  | "view/page"
  | "item/readOutput"
  | "approval/decide"
  | "approval/listPending"
  | "session/setApprovalMode"
  | "userInput/answer"
  | "userInput/cancel"
  | "userInput/clarify"
  | "usage/read";
export type MspServerRequest = "approval/request" | "userInput/request";
