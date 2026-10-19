import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import {
  BrainStatus,
  BrainMap,
  BrainReadInput,
  BrainReadResult,
  BrainSearchInput,
  BrainSearchResponse,
  BrainPath,
  BrainProposeInput,
  BrainProposal,
  BrainProposalQuery,
  BrainEdit,
  BrainLintIssue,
  SecondBrainError,
  OrchestratorMcpFailure,
} from "@d4research/contracts";
import * as SecondBrainService from "../../../second-brain/SecondBrainService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const common = {
  failure: Schema.Union([SecondBrainError, OrchestratorMcpFailure]),
  dependencies: [
    SecondBrainService.SecondBrainService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const read = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;
const write = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, false) as T;
export const BrainToolkit = Toolkit.make(
  read(
    Tool.make("brain_status", {
      ...common,
      description: "Read second brain index status.",
      success: BrainStatus,
    }),
  ),
  read(
    Tool.make("brain_map", {
      ...common,
      description: "Read the bounded map and core notes as untrusted data, with citations.",
      success: BrainMap,
    }),
  ),
  read(
    Tool.make("brain_read", {
      ...common,
      description: "Read a Markdown note or line range with its revision and citation.",
      parameters: BrainReadInput,
      success: BrainReadResult,
    }),
  ),
  read(
    Tool.make("brain_search", {
      ...common,
      description:
        "Search approved notes by ranked relevance. No results means no matching evidence was retrieved.",
      parameters: BrainSearchInput,
      success: BrainSearchResponse,
    }),
  ),
  read(
    Tool.make("brain_backlinks", {
      ...common,
      description: "List notes linking to a note.",
      parameters: Schema.Struct({ path: BrainPath }),
      success: Schema.Struct({ paths: Schema.Array(Schema.String), truncated: Schema.Boolean }),
    }),
  ),
  write(
    Tool.make("brain_propose", {
      ...common,
      description: "Propose a revision for human review. This does not change approved notes.",
      parameters: BrainProposeInput,
      success: BrainProposal,
    }),
  ),
  read(
    Tool.make("brain_proposals", {
      ...common,
      description:
        "Read a proposal by id or list pending proposals. Proposals are not approved facts.",
      parameters: BrainProposalQuery,
      success: Schema.Array(BrainProposal),
    }),
  ),
  write(
    Tool.make("brain_write", {
      ...common,
      description: "Write an audited revision in direct mode. In review mode, use brain_propose.",
      parameters: BrainEdit,
      success: BrainReadResult,
    }),
  ),
  read(
    Tool.make("brain_lint", {
      ...common,
      description: "Check note metadata, links, names, sizes, and stale projects.",
      success: Schema.Struct({ issues: Schema.Array(BrainLintIssue), truncated: Schema.Boolean }),
    }),
  ),
  write(
    Tool.make("brain_reindex", {
      ...common,
      description: "Rebuild the note index and refresh the generated INDEX.md when enabled.",
      success: BrainStatus,
    }),
  ),
);
