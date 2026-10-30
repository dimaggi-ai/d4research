// @effect-diagnostics nodeBuiltinImport:off
/**
 * What an agent here can do with the user's other environments: discover them, exchange files
 * and relay conversation requests. This server cannot reach another one, so every request goes to a
 * client connected to both (a relay), which answers through `respond`.
 *
 * @module Peers
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  type EnvironmentId,
  PEER_FILE_CHUNK_BYTES,
  type PeerEnvironment,
  PeerFilesFailureCode,
  OrchestratorMcpFailure,
  type PeerFilesListInput,
  type PeerFilesListResult,
  type PeerRelayOperation,
  type PeerRelayReply,
  type PeerRelayRequest,
  type PeerRelayRespondInput,
  type ProjectId,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PeerFiles from "./PeerFiles.ts";

const READ_TEXT_MAX_BYTES = 256 * 1024;

export class PeersError extends Schema.TaggedError<PeersError>()("PeersError", {
  code: Schema.Union([
    PeerFilesFailureCode,
    OrchestratorMcpFailure.fields.code,
    Schema.Literals(["peer_unreachable", "no_relay", "checksum_mismatch"]),
  ]),
  message: Schema.String,
}) {}

export interface PeerCopyInput {
  readonly environmentId: EnvironmentId;
  readonly direction: "to_peer" | "from_peer";
  readonly localPath: string;
  readonly peerPath: string;
  readonly overwrite: boolean;
}

export interface PeerCopyResult {
  readonly files: number;
  readonly bytes: number;
  /** Entries of a copied folder left alone, with the reason. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export class Peers extends Context.Service<
  Peers,
  {
    /** One relaying client: the requests it must answer through `respond`. */
    readonly connect: Stream.Stream<PeerRelayRequest>;
    readonly respond: (input: PeerRelayRespondInput) => Effect.Effect<void>;
    readonly request: (operation: PeerRelayOperation) => Effect.Effect<PeerRelayReply, PeersError>;
    /** The other environments, and where `projectId` lives on each. */
    readonly describe: (
      projectId: ProjectId | null,
    ) => Effect.Effect<ReadonlyArray<PeerEnvironment>, PeersError>;
    readonly list: (
      environmentId: EnvironmentId,
      input: PeerFilesListInput,
    ) => Effect.Effect<PeerFilesListResult, PeersError>;
    readonly readText: (
      environmentId: EnvironmentId,
      path: string,
    ) => Effect.Effect<
      { readonly text: string; readonly size: number; readonly truncated: boolean },
      PeersError
    >;
    /** Copies a file, or every regular file under a folder, verifying each by checksum. */
    readonly copy: (input: PeerCopyInput) => Effect.Effect<PeerCopyResult, PeersError>;
  }
>()("t3/peers/Peers") {}

const noRelay = () =>
  new PeersError({
    code: "no_relay",
    message:
      "No T3 Code app connected to this environment can reach the others right now. The desktop or web app has to be open and connected to both machines.",
  });

const unexpected = () =>
  new PeersError({ code: "io_failed", message: "The relay sent an unexpected reply." });

const make = Effect.gen(function* () {
  const files = yield* PeerFiles.PeerFiles;
  const relays = new Map<number, Queue.Queue<PeerRelayRequest>>();
  const pending = new Map<
    string,
    { readonly relayId: number; readonly reply: Deferred.Deferred<PeerRelayReply> }
  >();
  let nextRelayId = 0;

  const connect: Peers["Service"]["connect"] = Stream.unwrap(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<PeerRelayRequest>();
        const relayId = nextRelayId++;
        relays.set(relayId, queue);
        return { relayId, queue };
      }),
      ({ relayId, queue }) =>
        Effect.gen(function* () {
          relays.delete(relayId);
          yield* Queue.shutdown(queue);
          for (const request of pending.values()) {
            if (request.relayId !== relayId) continue;
            yield* Deferred.succeed(request.reply, {
              type: "failed",
              code: "peer_unreachable",
              message: "The relaying app disconnected.",
            });
          }
        }),
    ).pipe(Effect.map(({ queue }) => Stream.fromQueue(queue))),
  );

  const respond: Peers["Service"]["respond"] = (input) =>
    Effect.suspend(() => {
      const request = pending.get(input.requestId);
      return request === undefined ? Effect.void : Deferred.succeed(request.reply, input.reply);
    });

  const ask = Effect.fn("Peers.ask")(function* (
    relayId: number,
    queue: Queue.Queue<PeerRelayRequest>,
    operation: PeerRelayOperation,
  ) {
    const requestId = NodeCrypto.randomUUID();
    const reply = yield* Deferred.make<PeerRelayReply>();
    pending.set(requestId, { relayId, reply });
    yield* Queue.offer(queue, { requestId, operation });
    return yield* Deferred.await(reply).pipe(
      Effect.timeoutOption(operation.type === "list" ? "180 seconds" : "60 seconds"),
      Effect.map(Option.getOrUndefined),
      Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
    );
  });

  // The newest relay goes first. One that cannot reach the environment passes to the next.
  const invoke = Effect.fn("Peers.invoke")(function* (operation: PeerRelayOperation) {
    let fallback: PeerRelayReply | undefined;
    for (const [relayId, queue] of Array.from(relays).toReversed()) {
      const reply = yield* ask(relayId, queue, operation);
      if (reply === undefined) continue;
      const passes =
        (reply.type === "failed" && reply.code === "peer_unreachable") ||
        (reply.type === "described" && reply.peers.length === 0);
      if (!passes) return reply;
      fallback = reply;
    }
    return fallback ?? (yield* noRelay());
  });

  const failed = (reply: PeerRelayReply) =>
    reply.type === "failed"
      ? new PeersError({ code: reply.code, message: `On the other environment: ${reply.message}` })
      : unexpected();

  const onThisEnvironment = (error: {
    readonly code: PeersError["code"];
    readonly message: string;
  }) => new PeersError({ code: error.code, message: `On this environment: ${error.message}` });

  const describe: Peers["Service"]["describe"] = Effect.fn("Peers.describe")(function* (projectId) {
    const reply = yield* invoke({ type: "describe", projectId });
    return reply.type === "described" ? reply.peers : yield* failed(reply);
  });

  const list: Peers["Service"]["list"] = Effect.fn("Peers.list")(function* (environmentId, input) {
    const reply = yield* invoke({ type: "list", environmentId, input });
    return reply.type === "listed" ? reply.result : yield* failed(reply);
  });

  const readPeerChunk = Effect.fn("Peers.readPeerChunk")(function* (
    environmentId: EnvironmentId,
    path: string,
    offset: number,
    length = PEER_FILE_CHUNK_BYTES,
  ) {
    const reply = yield* invoke({ type: "read", environmentId, input: { path, offset, length } });
    return reply.type === "read" ? reply.result : yield* failed(reply);
  });

  const readText: Peers["Service"]["readText"] = Effect.fn("Peers.readText")(
    function* (environmentId, path) {
      const chunk = yield* readPeerChunk(environmentId, path, 0, READ_TEXT_MAX_BYTES);
      return {
        text: Buffer.from(chunk.data, "base64").toString("utf8"),
        size: chunk.size,
        truncated: !chunk.eof,
      };
    },
  );

  const copyFile = Effect.fn("Peers.copyFile")(function* (input: PeerCopyInput) {
    const transferId = NodeCrypto.randomUUID();
    const hash = NodeCrypto.createHash("sha256");
    const toPeer = input.direction === "to_peer";
    let offset = 0;
    for (;;) {
      const chunk = toPeer
        ? yield* files
            .read({ path: input.localPath, offset, length: PEER_FILE_CHUNK_BYTES })
            .pipe(Effect.mapError(onThisEnvironment))
        : yield* readPeerChunk(input.environmentId, input.peerPath, offset);
      const bytes = Buffer.from(chunk.data, "base64");
      hash.update(bytes);
      const write = {
        path: toPeer ? input.peerPath : input.localPath,
        transferId,
        offset,
        data: chunk.data,
        last: chunk.eof,
        overwrite: input.overwrite,
        mode: chunk.mode,
      };
      let written;
      if (toPeer) {
        const reply = yield* invoke({
          type: "write",
          environmentId: input.environmentId,
          input: write,
        });
        written = reply.type === "written" ? reply.result : yield* failed(reply);
      } else {
        written = yield* files.write(write).pipe(Effect.mapError(onThisEnvironment));
      }
      offset += bytes.length;
      if (!chunk.eof) continue;
      if (written.sha256 !== hash.digest("hex")) {
        return yield* new PeersError({
          code: "checksum_mismatch",
          message: `${write.path} does not match its source after the copy. Copy it again.`,
        });
      }
      return offset;
    }
  });

  const copy: Peers["Service"]["copy"] = Effect.fn("Peers.copy")(function* (input) {
    const toPeer = input.direction === "to_peer";
    const sourcePath = toPeer ? input.localPath : input.peerPath;
    const listing = { path: sourcePath, recursive: true, untrackedOnly: false, hash: false };
    const source = toPeer
      ? yield* files.list(listing).pipe(Effect.mapError(onThisEnvironment))
      : yield* list(input.environmentId, listing);
    if (source.kind === "file") return { files: 1, bytes: yield* copyFile(input), skipped: [] };
    if (source.truncated) {
      return yield* new PeersError({
        code: "io_failed",
        message: `${sourcePath} holds too many entries to copy at once. Copy its subfolders one by one.`,
      });
    }
    const skipped: Array<{ path: string; reason: string }> = [];
    let copied = 0;
    let bytes = 0;
    for (const entry of source.entries) {
      if (entry.kind === "directory") continue;
      if (entry.kind !== "file") {
        skipped.push({ path: entry.path, reason: `${entry.kind} entries are not copied` });
        continue;
      }
      const result = yield* copyFile({
        ...input,
        localPath: NodePath.join(input.localPath, entry.path),
        peerPath: `${input.peerPath.replace(/[\\/]+$/, "")}/${entry.path}`,
      }).pipe(
        Effect.catchIf(
          (error) => error.code === "already_exists",
          () => Effect.succeed("already exists" as const),
        ),
      );
      if (typeof result === "string") skipped.push({ path: entry.path, reason: result });
      else {
        copied += 1;
        bytes += result;
      }
    }
    return { files: copied, bytes, skipped };
  });

  return Peers.of({ connect, respond, request: invoke, describe, list, readText, copy });
});

export const layer = Layer.effect(Peers, make);
