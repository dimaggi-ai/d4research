import * as HostProcess from "@d4research/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Native no-follow file handles and exclusive publishing protect artifact boundaries.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { publishArtifact, safeDirectory } from "./artifactFiles.ts";
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const key = (id: string) => NodeCrypto.createHash("sha256").update(id).digest("hex");

export const exportResearchNote = (input: {
  folder: string;
  projectId: string;
  threadId: string;
  runId: string;
  seq: number;
  text: string;
}) =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.tryPromise(async () => {
      if (!input.folder) return;
      const root = await safeDirectory(input.folder, false, platform); // never create a mistyped vault root
      const directory = NodePath.join(
        root,
        "projects",
        key(input.projectId),
        "threads",
        key(input.threadId),
        "runs",
        key(input.runId),
      );
      await safeDirectory(directory, true, platform);
      const text = `---\nd4research: 1\nscope: project-thread\nproject: ${quote(input.projectId)}\nthread: ${quote(input.threadId)}\nrun: ${quote(input.runId)}\n---\n\n${input.text}`;
      await publishArtifact(
        NodePath.join(
          directory,
          `${String(input.seq).padStart(3, "0")}-${NodeCrypto.randomUUID()}.md`,
        ),
        text,
        platform,
      );
    }),
  );
