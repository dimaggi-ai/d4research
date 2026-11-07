import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { UNVERIFIED_TOOL_RESULT, type NiaMessage } from "./nia.ts";

const StoredMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  content: Schema.NullOr(Schema.String),
  tool_call_id: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.Literal("function"),
        function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
      }),
    ),
  ),
});
const Journal = Schema.Struct({
  providerThreadId: Schema.String,
  history: Schema.Array(StoredMessage),
});
const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(Journal));
const encodeJournal = Schema.encodeEffect(Schema.fromJsonString(Journal));

export const makeNiaJournal = Effect.fn("DeepSeekNiaJournal.make")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest.pipe(Effect.provide(Digest.layerWebCrypto));
  const random = yield* SecureRandom.SecureRandom.pipe(Effect.provide(SecureRandom.layerWebCrypto));
  const directory = path.join(stateDir, "deepseek-nia");
  const file = Effect.fn("DeepSeekNiaJournal.file")(function* (providerThreadId: string) {
    const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(providerThreadId));
    return path.join(directory, `${hash}.json`);
  });
  const locks = new Map<string, Semaphore.Semaphore>();
  const syncDirectory = Effect.fn("DeepSeekNiaJournal.syncDirectory")(function* (
    directoryPath: string,
  ) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(directoryPath, { flag: "r" });
        yield* handle.sync;
      }),
    );
  });
  let directoryDurable = false;
  const write = Effect.fn("DeepSeekNiaJournal.write")(function* (
    providerThreadId: string,
    history: ReadonlyArray<typeof StoredMessage.Type>,
  ) {
    let lock = locks.get(providerThreadId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(providerThreadId, lock);
    }
    yield* Effect.gen(function* () {
      if (!directoryDurable) {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        // A newly created journal directory also needs its parent entry synced.
        yield* syncDirectory(stateDir);
        directoryDurable = true;
      }
      const target = yield* file(providerThreadId);
      const body = yield* encodeJournal({ providerThreadId, history });
      const temporary = `${target}.${yield* random.uuidV4()}.tmp`;
      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
            yield* handle.writeAll(new TextEncoder().encode(body));
            yield* handle.sync;
          }),
        );
        yield* fs.rename(temporary, target);
        yield* syncDirectory(directory);
      }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
    }).pipe(lock.withPermits(1), Effect.uninterruptible);
  });
  const read = Effect.fn("DeepSeekNiaJournal.read")(function* (providerThreadId: string) {
    const target = yield* file(providerThreadId);
    const raw = yield* fs.readFileString(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    if (raw === undefined) return undefined;
    // An unreadable journal is evidence; treating it as absent would erase it on the next write.
    const parsed = yield* decodeJournal(raw);
    if (parsed.providerThreadId !== providerThreadId)
      return yield* new NiaJournalMismatch({ providerThreadId });
    return parsed.history;
  });
  return { read, write };
});

class NiaJournalMismatch extends Schema.TaggedError<NiaJournalMismatch>()("NiaJournalMismatch", {
  providerThreadId: Schema.String,
}) {}

/** A durable journal can extend committed history or resolve an unverified placeholder. */
export const preferJournal = (
  committed: ReadonlyArray<NiaMessage>,
  journal: ReadonlyArray<NiaMessage> | undefined,
): ReadonlyArray<NiaMessage> => {
  if (!journal || journal.length < committed.length) return committed;
  const extendsCommitted = committed.every((message, index) => {
    const journaled = journal[index];
    if (canonical(message) === canonical(journaled)) return true;
    return (
      message.role === "tool" &&
      journaled?.role === "tool" &&
      message.tool_call_id === journaled.tool_call_id &&
      message.content === UNVERIFIED_TOOL_RESULT
    );
  });
  return extendsCommitted ? journal : committed;
};

// Decoded metadata and parsed JSON can have different object key order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).toSorted(([a], [b]) => a.localeCompare(b)))
      : nested,
  );
