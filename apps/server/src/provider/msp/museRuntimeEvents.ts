import {
  ProviderItemId,
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type ItemLifecyclePayload,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnTokenUsage,
} from "@d4research/contracts";
import type { Item, MspNotification, TokenUsage, TurnError } from "./MspProtocol.ts";

export interface MuseEventContext {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly createdAt: string;
  readonly eventId: string;
  readonly model?: string;
  readonly activeTurnId?: TurnId;
  readonly items: ReadonlyMap<string, Item>;
}
export function mapTurnError(error?: TurnError) {
  if (error?.kind === "authRequired")
    return "Muse is not signed in. Run `muse login` in a terminal, then retry.";
  return error
    ? `${error.kind}: ${error.message}${error.retryable ? " (retryable)" : ""}`
    : "Muse turn failed.";
}
export function tokenUsageFromMsp(usage: TokenUsage): TurnTokenUsage {
  return {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
    hasSubagents: false,
  };
}
export function itemTypeForMsp(item: Item): ItemLifecyclePayload["itemType"] {
  switch (item.kind) {
    case "agentMessage":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "compaction":
      return "context_compaction";
    case "userShell":
      return "command_execution";
    case "toolCall": {
      if (item.patchSummary || /write|patch|edit/i.test(item.tool ?? "")) return "file_change";
      if (/shell|bash|exec|terminal/i.test(item.tool ?? "")) return "command_execution";
      if (/search/i.test(item.tool ?? "")) return "web_search";
      return "dynamic_tool_call";
    }
    default:
      return "unknown";
  }
}
export function mspNotificationToRuntimeEvents(
  ctx: MuseEventContext,
  notification: MspNotification,
): ProviderRuntimeEvent[] {
  const params = notification.params;
  const item = "item" in params ? params.item : undefined;
  const turn = ("turnId" in params ? params.turnId : item?.turnId) ?? ctx.activeTurnId;
  const itemId = item?.itemId ?? ("itemId" in params ? params.itemId : undefined);
  const base = {
    eventId: EventId.make(ctx.eventId),
    createdAt: ctx.createdAt,
    provider: ProviderDriverKind.make("muse"),
    providerInstanceId: ctx.instanceId,
    threadId: ctx.threadId,
    ...(turn ? { turnId: TurnId.make(turn) } : {}),
    ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
    providerRefs: {
      ...(turn ? { providerTurnId: turn } : {}),
      ...(itemId ? { providerItemId: ProviderItemId.make(itemId) } : {}),
    },
    raw: { source: "muse.msp.notification" as const, method: notification.method, payload: params },
  };
  const warning = (message: string): ProviderRuntimeEvent[] => [
    { ...base, type: "runtime.warning", payload: { message } },
  ];
  switch (notification.method) {
    case "turn/started":
      return [{ ...base, type: "turn.started", payload: ctx.model ? { model: ctx.model } : {} }];
    case "turn/completed": {
      const p = notification.params;
      const tokenUsage = p.usage ? { tokenUsage: tokenUsageFromMsp(p.usage) } : {};
      if (p.terminal === "completed")
        return [
          {
            ...base,
            type: "turn.completed",
            payload: {
              state: "completed",
              ...(p.reason ? { stopReason: p.reason } : {}),
              ...tokenUsage,
            },
          },
        ];
      if (p.terminal === "cancelled")
        return [
          {
            ...base,
            type: "turn.completed",
            payload: { state: "cancelled", stopReason: "interrupted", ...tokenUsage },
          },
        ];
      const message = mapTurnError(p.error);
      return [
        {
          ...base,
          type: "turn.completed",
          payload: { state: "failed", errorMessage: message, ...tokenUsage },
        },
        {
          ...base,
          eventId: EventId.make(`${ctx.eventId}:error`),
          type: "runtime.error",
          payload: { message, class: "provider_error", detail: p.error },
        },
        ...(p.error?.kind === "authRequired"
          ? [
              {
                ...base,
                eventId: EventId.make(`${ctx.eventId}:auth`),
                type: "auth.status" as const,
                payload: { error: message },
              },
            ]
          : []),
      ];
    }
    case "item/started":
    case "item/updated":
    case "item/completed": {
      const i = notification.params.item;
      if (i.kind === "userMessage") return [];
      const itemType = itemTypeForMsp(i);
      const detail =
        i.failureReason ??
        (i.kind === "toolCall"
          ? i.args?.slice(0, 4000)
          : i.kind === "userShell"
            ? i.commandText
            : i.kind === "compaction"
              ? (i.reason ?? i.outcome)
              : (i.fallbackText ?? i.text));
      const status =
        i.failureKind || i.failureReason || ["failed", "timedOut"].includes(i.status)
          ? "failed"
          : ["rejected", "cancelled"].includes(i.status)
            ? "declined"
            : i.status === "inProgress"
              ? "inProgress"
              : i.status === "completed"
                ? "completed"
                : undefined;
      const events: ProviderRuntimeEvent[] = [
        {
          ...base,
          type:
            notification.method === "item/started"
              ? "item.started"
              : notification.method === "item/updated"
                ? "item.updated"
                : "item.completed",
          payload: {
            itemType,
            ...(status ? { status } : {}),
            title: i.kind === "userShell" ? "User shell" : i.tool || i.kind,
            ...(detail ? { detail } : {}),
            data: i,
          },
        },
      ];
      if (i.kind === "compaction" && notification.method === "item/completed")
        events.push({
          ...base,
          eventId: EventId.make(`${ctx.eventId}:compacted`),
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            ...(i.tokensBefore !== undefined ? { beforeTokens: i.tokensBefore } : {}),
            ...(i.tokensAfter !== undefined ? { afterTokens: i.tokensAfter } : {}),
          },
        });
      return events;
    }
    case "item/delta": {
      const p = notification.params;
      const i = ctx.items.get(p.itemId);
      const field = p.field ?? "text";
      const summary = /^summary\.(\d+)$/.exec(field);
      const streamKind =
        i?.kind === "agentMessage" && field === "text"
          ? "assistant_text"
          : i?.kind === "reasoning" && summary
            ? "reasoning_summary_text"
            : field === "output" && i && itemTypeForMsp(i) === "command_execution"
              ? "command_output"
              : field === "output" && i && itemTypeForMsp(i) === "file_change"
                ? "file_change_output"
                : undefined;
      return streamKind
        ? [
            {
              ...base,
              type: "content.delta",
              payload: {
                streamKind,
                delta: p.delta,
                ...(summary ? { summaryIndex: Number(summary[1]) } : {}),
              },
            },
          ]
        : [];
    }
    case "session/statusChanged": {
      const p = notification.params;
      return [
        {
          ...base,
          type: "session.state.changed",
          payload: {
            state: p.attention?.some(
              (flag) => flag === "approvalPending" || flag === "inputPending",
            )
              ? "waiting"
              : p.status === "running"
                ? "running"
                : p.status === "notLoaded"
                  ? "stopped"
                  : "ready",
          },
        },
      ];
    }
    case "session/tokenUsage": {
      const p = notification.params;
      return [
        {
          ...base,
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: p.cumulative.promptTokens + p.cumulative.outputTokens,
              totalProcessedTokens: p.cumulative.totalTokens,
              inputTokens: p.usage.inputTokens,
              cachedInputTokens: p.usage.cachedTokens,
              outputTokens: p.usage.outputTokens,
            },
          },
        },
      ];
    }
    case "session/contextUsage":
      return [
        {
          ...base,
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: notification.params.usedTokens,
              ...(notification.params.windowTokens
                ? { maxTokens: notification.params.windowTokens }
                : {}),
            },
          },
        },
      ];
    case "session/modelChanged":
    case "session/reasoningEffortChanged":
    case "session/approvalModeChanged":
      return [
        { ...base, type: "session.configured", payload: { config: { ...notification.params } } },
      ];
    case "session/modelRouteUnserved": {
      const p = notification.params;
      if (
        "fromModel" in p &&
        typeof p.fromModel === "string" &&
        "toModel" in p &&
        typeof p.toModel === "string"
      )
        return [
          {
            ...base,
            type: "model.rerouted",
            payload: {
              fromModel: p.fromModel,
              toModel: p.toModel,
              reason: "Muse model route changed.",
            },
          },
        ];
      return warning(
        `Muse could not serve model ${p.modelId} on provider ${p.installedProviderId}.`,
      );
    }
    case "turn/retryScheduled": {
      const p = notification.params;
      return warning(
        `Muse retrying attempt ${p.nextAttempt}/${p.maxAttempts} in ${p.retryDelayMs}ms: ${p.reason}`,
      );
    }
    case "view/gap":
      return warning("Muse dropped view events; transcript may be incomplete");
    case "session/closed":
      return [
        {
          ...base,
          type: "session.exited",
          payload: {
            reason: notification.params.reason ?? "Muse session closed.",
            recoverable: false,
            exitKind: "error",
          },
        },
      ];
    default:
      return [];
  }
}
