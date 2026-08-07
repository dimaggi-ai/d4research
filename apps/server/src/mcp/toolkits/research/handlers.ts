import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeConfiguredMemoryConnector } from "../memory/localConnector.ts";
import { ResearchDelegationBudget } from "./budget.ts";
import { ResearchDelegateError, ResearchToolkit } from "./tools.ts";

/** Delegates run real research prompts; give them room but never forever. */
const DELEGATE_TURN_TIMEOUT_MILLIS = 240_000;
const DELEGATE_START_TIMEOUT_MILLIS = 120_000;
const SESSION_STOP_TIMEOUT_MILLIS = 10_000;
/** Cap what flows back into the orchestrator context per delegation. */
export const DELEGATE_MAX_OUTPUT_CHARS = 24_000;

/**
 * Splits "instanceId:model" on the FIRST colon only — model slugs carry
 * colons of their own (`glm-5.2:cloud`).
 */
export function parseDelegateTarget(
  target: string,
): { readonly instanceId: string; readonly model: string } | null {
  const separator = target.indexOf(":");
  if (separator <= 0 || separator === target.length - 1) return null;
  const instanceId = target.slice(0, separator).trim();
  const model = target.slice(separator + 1).trim();
  if (!instanceId || !model) return null;
  return { instanceId, model };
}

const handlers = {
  research_delegate: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const parsedTarget = parseDelegateTarget(input.target);
      if (!parsedTarget) {
        return yield* new ResearchDelegateError({
          detail: `Target "${input.target}" is not "instanceId:model". Use the exact target strings from the research briefing.`,
        });
      }

      // The delegate must never be this thread's own session — that is the
      // recursive-delegation door the product contract keeps shut.
      const nowMs = yield* Clock.currentTimeMillis;
      const budget = yield* ResearchDelegationBudget;
      const charge = yield* budget.charge({
        threadId: String(invocation.threadId),
        step: input.step,
        target: input.target,
        nowMs,
      });
      if (!charge.ok) {
        return yield* new ResearchDelegateError({
          detail: charge.reason ?? "Delegation budget exhausted.",
          budgetExhausted: true,
        });
      }

      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDelegateError({ detail: `Could not read settings: ${String(cause)}` }),
        ),
      );
      let promptFileContent: string | null = null;
      if (input.promptFileName !== undefined) {
        // Prefer the named scenario's files; fall back to every scenario plus
        // the legacy single-pipeline list so older briefings keep working.
        const scenario = settings.research.scenarios.find(
          (candidate) => candidate.name === input.scenario,
        );
        const searchable = [
          ...(scenario?.promptFiles ?? []),
          ...settings.research.scenarios.flatMap((candidate) => candidate.promptFiles),
          ...settings.research.promptFiles,
        ];
        const file = searchable.find((candidate) => candidate.name === input.promptFileName);
        if (!file) {
          const attached = [...new Set(searchable.map((candidate) => candidate.name))];
          return yield* new ResearchDelegateError({
            detail: `Prompt file "${input.promptFileName}" is not attached in Settings → Research. Attached: ${
              attached.join(", ") || "none"
            }.`,
          });
        }
        promptFileContent = file.content;
      }

      const registry = yield* ProviderAdapterRegistry;
      const instanceId = ProviderInstanceId.make(parsedTarget.instanceId);
      const adapter = yield* registry.getByInstance(instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDelegateError({
              detail: `Provider "${parsedTarget.instanceId}" unavailable: ${cause.message}`,
            }),
        ),
      );

      // Shared context rides along as-is — no summarization between what one
      // model learned and what the next one reads. Best-effort: a memory
      // outage degrades to a delegate without context, never a failed step.
      let sharedContext: string | null = null;
      if (settings.research.shareMemoContext) {
        sharedContext = yield* Effect.gen(function* () {
          const connector = yield* makeConfiguredMemoryConnector();
          const found = yield* connector.search(input.prompt, 5);
          if (found.results.length === 0) return null;
          return found.results.map((entry) => entry.text).join("\n---\n");
        }).pipe(Effect.orElseSucceed(() => null));
      }

      const config = yield* ServerConfig.ServerConfig;
      const turnInput = [
        ...(sharedContext !== null
          ? ["--- SHARED CONTEXT (local memory, verbatim) ---", sharedContext, ""]
          : []),
        ...(promptFileContent !== null
          ? [`--- PROMPT FILE: ${input.promptFileName} ---`, promptFileContent, ""]
          : []),
        input.prompt,
      ].join("\n");
      const modelSelection = { instanceId, model: parsedTarget.model };
      const threadId = ThreadId.make(`research-delegate-${nowMs}`);

      yield* adapter
        .startSession({
          threadId,
          provider: adapter.provider,
          cwd: config.cwd,
          runtimeMode: "approval-required",
          modelSelection,
        })
        .pipe(
          Effect.timeout(DELEGATE_START_TIMEOUT_MILLIS),
          Effect.mapError(
            (cause) =>
              new ResearchDelegateError({
                detail: `Failed to start ${input.target}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        );

      const text = yield* adapter
        .sendTurn({ threadId, input: turnInput, attachments: [], modelSelection })
        .pipe(
          Effect.flatMap(() => adapter.readThread(threadId)),
          Effect.map((thread) => {
            const lastTurn = thread.turns[thread.turns.length - 1];
            if (!lastTurn) return "";
            return lastTurn.items
              .map((item) => {
                if (typeof item === "string") return item;
                if (typeof item === "object" && item !== null && "text" in item) {
                  return String((item as { text: unknown }).text);
                }
                return "";
              })
              .join("")
              .trim();
          }),
          Effect.timeout(DELEGATE_TURN_TIMEOUT_MILLIS),
          Effect.mapError(
            (cause) =>
              new ResearchDelegateError({
                detail: `Delegate turn on ${input.target} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
          Effect.ensuring(
            adapter
              .stopSession(threadId)
              .pipe(Effect.timeout(SESSION_STOP_TIMEOUT_MILLIS), Effect.ignore),
          ),
        );

      if (!text) {
        return yield* new ResearchDelegateError({
          detail: `Empty response from ${input.target}. Report the step as failed rather than inventing its answer.`,
        });
      }

      const truncated = text.length > DELEGATE_MAX_OUTPUT_CHARS;
      return {
        target: input.target,
        step: input.step,
        visit: input.visit,
        remainingBudget: charge.remaining,
        truncated,
        text: truncated ? text.slice(0, DELEGATE_MAX_OUTPUT_CHARS) : text,
      };
    }),
} satisfies Parameters<typeof ResearchToolkit.toLayer>[0];

export const ResearchToolkitHandlersLive = ResearchToolkit.toLayer(handlers);
