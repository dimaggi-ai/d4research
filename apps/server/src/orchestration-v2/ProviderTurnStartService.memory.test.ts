// @effect-diagnostics nodeBuiltinImport:off - memory assertions run in an isolated Node process with explicit GC.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it.each(["regular", "handoff", "handoff-compact", "handoff-failure"])(
  "releases startup history while %s run workers remain alive",
  async (mode) => {
    const root = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
    const fixture = NodeURL.fileURLToPath(
      new URL("./testkit/ProviderTurnStartMemory.fixture.mjs", import.meta.url),
    );
    const { stdout } = await execFile(process.execPath, ["--expose-gc", fixture, root, mode]);
    const result = JSON.parse(stdout) as {
      checkpoints: ReadonlyArray<{ runs: number; retained: number }>;
    };
    expect(result.checkpoints.map(({ runs, retained }) => ({ runs, retained }))).toEqual([
      { runs: 2, retained: 0 },
      { runs: 4, retained: 0 },
    ]);
  },
);

it.each(["brain", "brain-error", "brain-slash", "brain-compact", "brain-disabled", "brain-empty"])(
  "shared provider delivery preserves visible messages for %s",
  async (mode) => {
    const root = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
    const fixture = NodeURL.fileURLToPath(
      new URL("./testkit/ProviderTurnStartMemory.fixture.mjs", import.meta.url),
    );
    const { stdout } = await execFile(process.execPath, ["--expose-gc", fixture, root, mode]);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      brainCalls: number;
      receipts: number;
      sent: string[];
    };
    expect(result.brainCalls).toBe(mode === "brain" || mode === "brain-error" ? 4 : 0);
    expect(result.receipts).toBe(mode === "brain" ? 4 : 0);
    if (mode === "brain") {
      expect(result.sent).toHaveLength(4);
      expect(
        result.sent.every(
          (text) =>
            text.includes("<second_brain_context>") && text.endsWith("User message:\nContinue"),
        ),
      ).toBe(true);
    } else if (mode === "brain-error" || mode === "brain-disabled" || mode === "brain-empty")
      expect(result.sent).toEqual(Array(4).fill("Continue"));
    else if (mode === "brain-slash") expect(result.sent).toEqual(Array(4).fill("/help"));
  },
);
