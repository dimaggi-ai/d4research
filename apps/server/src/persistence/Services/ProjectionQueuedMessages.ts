import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationProposedPlanId,
  ThreadId,
} from "@d4research/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionQueuedMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  modelSelection: Schema.NullOr(ModelSelection),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  queuedAt: IsoDateTime,
  scheduledAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionQueuedMessage = typeof ProjectionQueuedMessage.Type;

export const ListProjectionQueuedMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export const ListDueProjectionQueuedMessagesInput = Schema.Struct({ now: IsoDateTime });
export type ListDueProjectionQueuedMessagesInput = typeof ListDueProjectionQueuedMessagesInput.Type;
export type ListProjectionQueuedMessagesInput = typeof ListProjectionQueuedMessagesInput.Type;

export const DeleteProjectionQueuedMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type DeleteProjectionQueuedMessageInput = typeof DeleteProjectionQueuedMessageInput.Type;

export const DeleteProjectionQueuedMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionQueuedMessagesInput = typeof DeleteProjectionQueuedMessagesInput.Type;

export interface ProjectionQueuedMessageRepositoryShape {
  readonly upsert: (
    queuedMessage: ProjectionQueuedMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionQueuedMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionQueuedMessage>, ProjectionRepositoryError>;
  readonly listDue: (
    input: ListDueProjectionQueuedMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionQueuedMessage>, ProjectionRepositoryError>;
  readonly deleteByMessageId: (
    input: DeleteProjectionQueuedMessageInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionQueuedMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionQueuedMessageRepository extends Context.Service<
  ProjectionQueuedMessageRepository,
  ProjectionQueuedMessageRepositoryShape
>()("d4research/persistence/Services/ProjectionQueuedMessages/ProjectionQueuedMessageRepository") {}
