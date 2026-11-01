// @effect-diagnostics nodeBuiltinImport:off - modes, symlinks and random bytes need node:fs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PeerFilesError,
  type PeerRelayReply,
  type PeerRelayRequest,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PeerFiles from "./PeerFiles.ts";
import * as Peers from "./Peers.ts";

const peer = EnvironmentId.make("environment-peer");

// One PeerFiles stands in for both machines: `here` and `there` are two project folders.
let projectFolders: ReadonlyArray<string> = [];

const layerTest = Peers.layer.pipe(
  Layer.provideMerge(PeerFiles.layer),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.sync(
        () =>
          ({
            projects: projectFolders.map((workspaceRoot) => ({ workspaceRoot, deletedAt: null })),
          }) as never,
      ),
    }),
  ),
  Layer.provide(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
    }),
  ),
  Layer.provideMerge(
    GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peers-test-" })),
      Layer.provide(VcsProcess.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeFolders = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-peers-")),
    );
    const folders = {
      root,
      here: NodePath.join(root, "here"),
      there: NodePath.join(root, "there"),
      outside: NodePath.join(root, "outside"),
    };
    await Promise.all(
      [folders.here, folders.there, folders.outside].map((folder) => NodeFSP.mkdir(folder)),
    );
    projectFolders = [folders.here, folders.there];
    return folders;
  }),
  ({ root }) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

/** A relaying client that runs every request against the same PeerFiles. */
const startRelay = Effect.gen(function* () {
  const peers = yield* Peers.Peers;
  const files = yield* PeerFiles.PeerFiles;
  const answer = ({ operation }: PeerRelayRequest): Effect.Effect<PeerRelayReply> => {
    const failed = (error: PeerFilesError) =>
      Effect.succeed<PeerRelayReply>({ type: "failed", code: error.code, message: error.message });
    switch (operation.type) {
      case "describe":
        return Effect.succeed({ type: "described", peers: [] });
      case "threads-list":
      case "usage-limits":
      case "thread-read":
      case "thread-send":
      case "thread-wait":
        return Effect.succeed({
          type: "failed",
          code: "peer_unreachable",
          message: "This file-only relay does not handle threads.",
        });
      case "list":
        return files.list(operation.input).pipe(
          Effect.map((result): PeerRelayReply => ({ type: "listed", result })),
          Effect.catch(failed),
        );
      case "read":
        return files.read(operation.input).pipe(
          Effect.map((result): PeerRelayReply => ({ type: "read", result })),
          Effect.catch(failed),
        );
      case "write":
        return files.write(operation.input).pipe(
          Effect.map((result): PeerRelayReply => ({ type: "written", result })),
          Effect.catch(failed),
        );
    }
  };
  yield* peers.connect.pipe(
    Stream.runForEach((request) =>
      Effect.flatMap(answer(request), (reply) =>
        peers.respond({ requestId: request.requestId, reply }),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
});

it.layer(layerTest, { excludeTestServices: true })("Peers", (it) => {
  describe("copy", () => {
    it.effect("copies a folder to the other machine and reports what already exists", () =>
      Effect.gen(function* () {
        const peers = yield* Peers.Peers;
        const { here, there } = yield* makeFolders;
        yield* startRelay;
        const large = NodeCrypto.randomBytes(1_300_000);
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(here, ".env"), "TOKEN=1\n", { mode: 0o600 });
          await NodeFSP.mkdir(NodePath.join(here, "data"));
          await NodeFSP.writeFile(NodePath.join(here, "data", "large.bin"), large);
          await NodeFSP.mkdir(NodePath.join(here, "node_modules"));
          await NodeFSP.writeFile(NodePath.join(here, "node_modules", "skipped.js"), "");
        });

        const sent = yield* peers.copy({
          environmentId: peer,
          direction: "to_peer",
          localPath: here,
          peerPath: there,
          overwrite: false,
        });

        expect(sent).toEqual({ files: 2, bytes: 8 + large.length, skipped: [] });
        const copied = yield* Effect.promise(async () => ({
          large: await NodeFSP.readFile(NodePath.join(there, "data", "large.bin")),
          envMode: (await NodeFSP.stat(NodePath.join(there, ".env"))).mode & 0o777,
          entries: (await NodeFSP.readdir(there)).sort(),
        }));
        expect(copied.large.equals(large)).toBe(true);
        expect(copied.envMode).toBe(0o600);
        expect(copied.entries).toEqual([".env", "data"]);

        const again = yield* peers.copy({
          environmentId: peer,
          direction: "from_peer",
          localPath: here,
          peerPath: there,
          overwrite: false,
        });
        expect(again).toEqual({
          files: 0,
          bytes: 0,
          skipped: [
            { path: ".env", reason: "already exists" },
            { path: "data/large.bin", reason: "already exists" },
          ],
        });
      }),
    );

    it.effect("brings one file here and replaces it only with overwrite", () =>
      Effect.gen(function* () {
        const peers = yield* Peers.Peers;
        const { here, there } = yield* makeFolders;
        yield* startRelay;
        const input = {
          environmentId: peer,
          direction: "from_peer" as const,
          localPath: NodePath.join(here, "config", ".env"),
          peerPath: NodePath.join(there, ".env"),
        };
        yield* Effect.promise(() => NodeFSP.writeFile(input.peerPath, "A=1\n"));
        expect(yield* peers.copy({ ...input, overwrite: false })).toMatchObject({ files: 1 });

        yield* Effect.promise(() => NodeFSP.writeFile(input.peerPath, "A=2\n"));
        const refused = yield* peers.copy({ ...input, overwrite: false }).pipe(Effect.flip);
        expect(refused.code).toBe("already_exists");
        yield* peers.copy({ ...input, overwrite: true });

        expect(yield* Effect.promise(() => NodeFSP.readFile(input.localPath, "utf8"))).toBe(
          "A=2\n",
        );
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(input.localPath))),
        ).toEqual([".env"]);
      }),
    );

    it.effect("says so when no app can relay", () =>
      Effect.gen(function* () {
        const peers = yield* Peers.Peers;
        const failure = yield* peers.describe(null).pipe(Effect.flip);
        expect(failure.code).toBe("no_relay");
      }),
    );
  });

  describe("PeerFiles", () => {
    it.effect("refuses paths outside project folders, symlinks included", () =>
      Effect.gen(function* () {
        const files = yield* PeerFiles.PeerFiles;
        const { here, outside } = yield* makeFolders;
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(outside, "secret"), "x");
          await NodeFSP.symlink(outside, NodePath.join(here, "link"));
        });
        const read = (path: string) =>
          files.read({ path, offset: 0, length: 16 }).pipe(Effect.flip);

        expect((yield* read(NodePath.join(outside, "secret"))).code).toBe("outside_projects");
        expect((yield* read(NodePath.join(here, "link", "secret"))).code).toBe("outside_projects");
        expect((yield* read(NodePath.join(here, "..", "outside", "secret"))).code).toBe(
          "outside_projects",
        );
        const written = yield* files
          .write({
            path: NodePath.join(here, "link", "new"),
            transferId: "transfer-1",
            offset: 0,
            data: "",
            last: true,
            overwrite: true,
          })
          .pipe(Effect.flip);
        expect(written.code).toBe("outside_projects");
      }),
    );

    it.effect("lists what Git does not carry", () =>
      Effect.gen(function* () {
        const files = yield* PeerFiles.PeerFiles;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const { here } = yield* makeFolders;
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(here, ".gitignore"), ".env\nbuild/\n");
          await NodeFSP.writeFile(NodePath.join(here, "tracked.txt"), "tracked");
          await NodeFSP.writeFile(NodePath.join(here, ".env"), "TOKEN=1");
          await NodeFSP.mkdir(NodePath.join(here, "build"));
          await NodeFSP.writeFile(NodePath.join(here, "build", "out.bin"), "out");
          await NodeFSP.writeFile(NodePath.join(here, "notes.txt"), "untracked");
        });
        yield* git.execute({ operation: "test.init", cwd: here, args: ["init", "--quiet"] });
        yield* git.execute({
          operation: "test.add",
          cwd: here,
          args: ["add", ".gitignore", "tracked.txt"],
        });

        const listed = yield* files.list({
          path: here,
          recursive: false,
          untrackedOnly: true,
          hash: true,
        });

        expect(listed.entries.map((entry) => [entry.path, entry.kind])).toEqual([
          [".env", "file"],
          ["build", "directory"],
          ["notes.txt", "file"],
        ]);
        expect(listed.entries[0]?.sha256).toBe(
          NodeCrypto.createHash("sha256").update("TOKEN=1").digest("hex"),
        );
      }),
    );
  });
});
