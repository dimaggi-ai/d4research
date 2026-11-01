import {
  forkSession,
  getSessionMessages,
  type ForkSessionOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Bundled import.meta.main is always true; imports must have no side effects.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
    }),
  ),
);

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, options)
      : method === "forkSession"
        ? await forkWithinAccount(sessionId, options).then(async (forked) => {
            const headMessageId = await getSessionMessages(forked.sessionId)
              .then((messages) => messages.at(-1)?.uuid)
              .catch(() => undefined);
            return headMessageId === undefined ? forked : { ...forked, headMessageId };
          })
        : (() => {
            throw new Error("Unknown Claude history operation.");
          })();
  process.stdout.write(JSON.stringify(result));
}

async function forkWithinAccount(sessionId: string, options: ForkSessionOptions) {
  try {
    return await forkSession(sessionId, options);
  } catch (cause) {
    if (
      options.dir === undefined ||
      !(cause instanceof Error) ||
      !cause.message.startsWith(`Session ${sessionId} not found`)
    ) {
      throw cause;
    }
    // A thread can move checkouts after its native transcript was created.
    // Search this account's other project directories, never another account.
    const { dir: _dir, ...fallbackOptions } = options;
    return await forkSession(sessionId, fallbackOptions);
  }
}
