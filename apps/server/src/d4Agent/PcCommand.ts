// @effect-diagnostics-next-line nodeBuiltinImport:off -- spawn gives a process group to kill on timeout and lets the wait end when bash exits, even if a started app keeps the pipes open.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous PATH probe at layer build.
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface PcCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}

export class PcCommand extends Context.Service<
  PcCommand,
  { readonly run: (command: string, id: string) => Effect.Effect<PcCommandResult> }
>()("d4research/d4Agent/PcCommand") {}

const OUTPUT_LIMIT = 8000;

const hasSystemdRun = () =>
  (process.env.PATH ?? "")
    .split(":")
    .some((dir) => dir !== "" && NodeFS.existsSync(`${dir}/systemd-run`));

export const make = (options: { readonly useScope: boolean }) =>
  PcCommand.of({
    run: (command, id) =>
      Effect.gen(function* () {
        // A transient scope keeps apps Nia opens alive when the d4research service restarts,
        // because the service's KillMode stops everything left in its own cgroup.
        const [file, args] = options.useScope
          ? [
              "systemd-run",
              [
                "--user",
                "--scope",
                "--quiet",
                "--collect",
                `--unit=nia-pc-${id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64)}`,
                "bash",
                "-lc",
                command,
              ],
            ]
          : ["bash", ["-lc", command]];
        const child = NodeChildProcess.spawn(file, args, {
          cwd: process.env.HOME,
          env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const append = (chunk: Buffer) => {
          if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8");
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        const killGroup = Effect.sync(() => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            // The group already exited.
          }
        });
        const exited = Effect.callback<number | null>((resume) => {
          child.on("exit", (code) => resume(Effect.succeed(code)));
          child.on("error", (error) => {
            output += error.message;
            resume(Effect.succeed(null));
          });
          return killGroup;
        });
        const exit = yield* exited.pipe(
          Effect.map((exitCode) => ({ exitCode, timedOut: false })),
          Effect.timeoutOrElse({
            duration: "60 seconds",
            orElse: () => killGroup.pipe(Effect.as({ exitCode: null, timedOut: true })),
          }),
        );
        // Let buffered output arrive, then stop reading so a started app cannot hold the wait open.
        yield* Effect.sleep("200 millis");
        child.stdout?.destroy();
        child.stderr?.destroy();
        return { ...exit, output: output.slice(0, OUTPUT_LIMIT) } satisfies PcCommandResult;
      }),
  });

export const layer = Layer.sync(PcCommand, () => make({ useScope: hasSystemdRun() }));
