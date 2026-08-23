// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test support for replaying recorded Claude CLI streams through the adapter.
 * Kept separate from ClaudeAdapter.test.ts so fixture replay does not depend on
 * that file's richer call-recording fake.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  PermissionMode,
  SDKControlGetContextUsageResponse,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, ThreadId } from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

export const THREAD_ID = ThreadId.make("claude-fixture-thread");

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export class ClaudeFixtureAdapter extends Context.Service<
  ClaudeFixtureAdapter,
  ClaudeAdapterShape
>()("d4research/provider/Layers/claudeFixtureHarness/ClaudeFixtureAdapter") {}

const FIXTURE_DIR = NodePath.join(import.meta.dirname, "__fixtures__/claude");

export function listClaudeFixtures(): ReadonlyArray<string> {
  return NodeFS.existsSync(FIXTURE_DIR)
    ? NodeFS.readdirSync(FIXTURE_DIR)
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.replace(/\.json$/, ""))
    : [];
}

export function loadClaudeFixture(name: string): ReadonlyArray<SDKMessage> {
  const raw = NodeFS.readFileSync(NodePath.join(FIXTURE_DIR, `${name}.json`), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture ${name} must be an array of SDK messages.`);
  }
  // A recorded stream failure is stored as a marker rather than a message.
  return parsed.filter(
    (entry) => !(typeof entry === "object" && entry !== null && "__recorderStreamError" in entry),
  ) as ReadonlyArray<SDKMessage>;
}

class ReplayQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private done = false;

  emit(message: SDKMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  readonly interrupt = async (): Promise<void> => {};
  readonly setModel = async (): Promise<void> => {};
  readonly setPermissionMode = async (_mode: PermissionMode): Promise<void> => {};
  readonly setMaxThinkingTokens = async (): Promise<void> => {};
  readonly getContextUsage = async (): Promise<SDKControlGetContextUsageResponse> => {
    throw new Error("Context usage is unavailable in fixture replay.");
  };
  readonly close = (): void => {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ done: false, value: queued });
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export function makeFixtureHarness() {
  const query = new ReplayQuery();
  return {
    query,
    layer: Layer.effect(
      ClaudeFixtureAdapter,
      makeClaudeAdapter(decodeClaudeSettings({}), {
        createQuery: () => query as never,
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-fixture-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}
