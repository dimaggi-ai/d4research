import { EventId, TurnId, type OrchestrationV2ProjectedTurnItem } from "@d4research/contracts";
import * as DateTime from "effect/DateTime";

export interface ResearchActivity {
  readonly id: string;
  readonly kind: string;
  readonly tone: "error" | "info" | "tool";
  readonly summary: string;
  readonly turnId: TurnId | null;
  readonly sequence?: number;
  readonly createdAt: string;
  readonly payload: unknown;
}

/** Adapt durable V2 tool items for the research ledger and Markdown exporter. */
export function researchActivitiesFromTurnItems(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<ResearchActivity> {
  return rows.flatMap<ResearchActivity>(({ item, position }) => {
    if (item.type === "system_notice" && item.activity) {
      return [
        {
          id: EventId.make(String(item.id)),
          kind: item.activity.kind,
          tone:
            item.activity.kind === "research.integrity-warning"
              ? ("error" as const)
              : ("info" as const),
          summary: item.title || item.activity.kind,
          turnId: item.runId === null ? null : TurnId.make(String(item.runId)),
          sequence: position,
          createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
          payload: item.activity.payload,
        },
      ];
    }
    if (item.type !== "dynamic_tool") return [];
    if (item.status === "idle" || item.status === "pending") return [];
    const settled = ["completed", "failed", "cancelled", "interrupted"].includes(item.status);
    const failed = settled && item.status !== "completed";
    const output = item.output;
    const delegate =
      output && typeof output === "object" && "researchDelegate" in output
        ? output.researchDelegate
        : null;
    const projectedDelegate =
      delegate &&
      typeof delegate === "object" &&
      "target" in delegate &&
      typeof delegate.target === "string"
        ? { ...delegate, failed: failed || ("failed" in delegate && delegate.failed === true) }
        : null;
    return [
      {
        id: EventId.make(String(item.id)),
        kind: settled ? "tool.completed" : "tool.started",
        tone: failed ? ("error" as const) : ("tool" as const),
        summary: item.title || item.toolName || "Tool",
        turnId: item.runId === null ? null : TurnId.make(String(item.runId)),
        sequence: position,
        createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
        payload: {
          toolCallId: String(item.id),
          status: failed ? "failed" : item.status,
          data: {
            ...(projectedDelegate ? { researchDelegate: projectedDelegate } : {}),
            toolName: item.toolName,
            input: item.input,
            output: item.output,
            isError: failed,
          },
        },
      },
    ];
  });
}
