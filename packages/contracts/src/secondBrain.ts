import * as Schema from "effect/Schema";

export const BrainNoteKind = Schema.Literals(["note", "person", "project", "decision", "learning"]);
export type BrainNoteKind = typeof BrainNoteKind.Type;
export const BrainPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const ShortText = Schema.String.check(Schema.isMaxLength(4096));
export const BrainNoteMetadata = Schema.Struct({
  schema: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  id: Schema.optionalKey(ShortText),
  kind: Schema.optionalKey(BrainNoteKind),
  title: Schema.optionalKey(ShortText),
  summary: Schema.optionalKey(ShortText),
  created: Schema.optionalKey(ShortText),
  updated: Schema.optionalKey(ShortText),
  status: Schema.optionalKey(ShortText),
  tags: Schema.optionalKey(Schema.Array(ShortText)),
  aliases: Schema.optionalKey(Schema.Array(ShortText)),
  sources: Schema.optionalKey(Schema.Array(ShortText)),
});
export type BrainNoteMetadata = typeof BrainNoteMetadata.Type;
export const BrainCitation = Schema.Struct({
  path: BrainPath,
  heading: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
  hash: Schema.String,
  excerpt: Schema.String,
});
export type BrainCitation = typeof BrainCitation.Type;
export const BrainNote = Schema.Struct({
  path: BrainPath,
  hash: Schema.String,
  title: Schema.String,
  kind: BrainNoteKind,
  metadata: BrainNoteMetadata,
  bytes: Schema.Int,
});
export type BrainNote = typeof BrainNote.Type;
export const BrainReadInput = Schema.Struct({
  path: BrainPath,
  startLine: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  endLine: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type BrainReadInput = typeof BrainReadInput.Type;
export const BrainReadResult = Schema.Struct({
  possibleDuplicates: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: BrainPath, reason: Schema.String })),
  ),
  content: Schema.String,
  hash: Schema.String,
  citation: BrainCitation,
  truncated: Schema.Boolean,
});
export type BrainReadResult = typeof BrainReadResult.Type;
export const BrainSearchInput = Schema.Struct({
  query: ShortText,
  kind: Schema.optionalKey(BrainNoteKind),
  tag: Schema.optionalKey(ShortText),
  path: Schema.optionalKey(BrainPath),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
  ),
});
export type BrainSearchInput = typeof BrainSearchInput.Type;
export const BrainSearchResult = Schema.Struct({ citation: BrainCitation, score: Schema.Number });
export type BrainSearchResult = typeof BrainSearchResult.Type;
export const BrainSemanticStatus = Schema.Literals(["disabled", "ready", "unavailable"]);
export type BrainSemanticStatus = typeof BrainSemanticStatus.Type;
export const BrainSearchResponse = Schema.Struct({
  results: Schema.Array(BrainSearchResult),
  semanticStatus: BrainSemanticStatus,
  abstain: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type BrainSearchResponse = typeof BrainSearchResponse.Type;
export const BrainEdit = Schema.Struct({
  path: BrainPath,
  kind: BrainNoteKind,
  operation: Schema.Literals([
    "create",
    "append",
    "replace-section",
    "replace",
    "patch_section",
    "str_replace",
    "supersede",
    "replace_file",
  ]),
  content: Schema.String.check(Schema.isMaxLength(1048576)),
  expectedHash: Schema.NullOr(Schema.String),
  heading: Schema.optionalKey(ShortText),
  oldStr: Schema.optionalKey(ShortText),
  newStr: Schema.optionalKey(ShortText),
});
export type BrainEdit = typeof BrainEdit.Type;
export const BrainEvidence = Schema.Struct({
  threadId: ShortText,
  messageId: ShortText,
  quote: ShortText,
});
export const BrainProposeInput = Schema.Struct({
  ...BrainEdit.fields,
  rationale: ShortText,
  evidence: Schema.Array(BrainEvidence).check(Schema.isMaxLength(100)),
});
export type BrainProposeInput = typeof BrainProposeInput.Type;
export const BrainProposalState = Schema.Literals(["pending", "accepted", "rejected", "conflict"]);
export const BrainProposal = Schema.Struct({
  ...BrainProposeInput.fields,
  id: Schema.String,
  vault: Schema.String,
  actor: Schema.String,
  state: BrainProposalState,
  createdAt: Schema.String,
  reviewedAt: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  possibleDuplicates: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: BrainPath, reason: Schema.String })),
  ),
});
export type BrainProposal = typeof BrainProposal.Type;
export const BrainProposalQuery = Schema.Struct({
  id: Schema.optionalKey(ShortText),
  state: Schema.optionalKey(BrainProposalState),
  own: Schema.optionalKey(Schema.Boolean),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
  ),
});
export type BrainProposalQuery = typeof BrainProposalQuery.Type;
export const BrainLintIssue = Schema.Struct({
  path: Schema.String,
  code: Schema.String,
  line: Schema.optionalKey(Schema.Int),
});
export type BrainLintIssue = typeof BrainLintIssue.Type;
export const BrainStatus = Schema.Struct({
  captureJobs: Schema.optionalKey(Schema.Struct({ pending: Schema.Int, failed: Schema.Int })),
  enabled: Schema.Boolean,
  vault: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  notes: Schema.Int,
  chunks: Schema.Int,
  lastIndexedAt: Schema.NullOr(Schema.String),
  semanticStatus: BrainSemanticStatus,
  truncated: Schema.Boolean,
});
export type BrainStatus = typeof BrainStatus.Type;
export const BrainCatalogEntry = Schema.Struct({
  path: BrainPath,
  title: Schema.String,
  kind: BrainNoteKind,
  summary: Schema.String,
  status: Schema.NullOr(Schema.String),
  updated: Schema.NullOr(Schema.String),
  inboundLinks: Schema.Int,
});
export const BrainMap = Schema.Struct({
  catalog: Schema.Array(BrainCatalogEntry),
  stats: Schema.Struct({ notes: Schema.Int, chunks: Schema.Int, generation: Schema.Int }),
  mapFile: Schema.NullOr(Schema.String),
  map: Schema.String,
  files: Schema.Array(Schema.String),
  citations: Schema.Array(BrainCitation),
  truncated: Schema.Boolean,
});
export type BrainMap = typeof BrainMap.Type;
export const BrainTurnContext = Schema.Struct({
  delivery: Schema.optionalKey(
    Schema.Struct({
      vault: Schema.String,
      generation: Schema.Int,
      providerThreadId: Schema.String,
    }),
  ),
  policy: Schema.String,
  core: Schema.String,
  retrieved: Schema.String,
  citations: Schema.Array(BrainCitation),
});
export type BrainTurnContext = typeof BrainTurnContext.Type;
export class SecondBrainError extends Schema.TaggedError<SecondBrainError>()("SecondBrainError", {
  code: Schema.Literals([
    "secret_detected",
    "disabled",
    "invalid_path",
    "unsafe_path",
    "oversized",
    "not_found",
    "stale_revision",
    "malformed",
    "forbidden",
    "unavailable",
  ]),
}) {
  override get message(): string {
    return this.code === "forbidden"
      ? "Direct writes require direct mode. Use brain_propose for review."
      : `Second brain operation failed (${this.code}).`;
  }
}

export const BrainIngestInput = Schema.Struct({
  sourceTitle: ShortText,
  sourceText: Schema.String.check(Schema.isMaxLength(262144)),
});
export type BrainIngestInput = typeof BrainIngestInput.Type;
export const BrainIngestResult = Schema.Struct({
  path: BrainPath,
  related: BrainSearchResponse,
  checklist: Schema.Array(Schema.String),
});
export type BrainIngestResult = typeof BrainIngestResult.Type;
export const BrainDecisionInput = Schema.Struct({
  title: ShortText,
  context: ShortText,
  decision: ShortText,
  consequences: ShortText,
  supersedes: Schema.optionalKey(BrainPath),
  project: Schema.optionalKey(BrainPath),
});
export type BrainDecisionInput = typeof BrainDecisionInput.Type;

export const BrainProposalDetail = Schema.Struct({
  proposal: BrainProposal,
  currentHash: Schema.NullOr(Schema.String),
  currentContent: Schema.String,
  proposedContent: Schema.String,
  diff: Schema.String,
  conflict: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type BrainProposalDetail = typeof BrainProposalDetail.Type;
export const BrainAcceptProposalInput = Schema.Struct({
  id: ShortText,
  expectedHash: Schema.NullOr(Schema.String),
  contentOverride: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1048576))),
});
export type BrainAcceptProposalInput = typeof BrainAcceptProposalInput.Type;
export const BrainRejectProposalInput = Schema.Struct({ id: ShortText, reason: ShortText });

export const BrainProposalSummary = Schema.Struct({
  id: Schema.String,
  path: BrainPath,
  kind: BrainNoteKind,
  state: BrainProposalState,
  createdAt: Schema.String,
  evidence: Schema.Array(Schema.Struct({ threadId: ShortText, messageId: ShortText })),
});
export type BrainProposalSummary = typeof BrainProposalSummary.Type;
