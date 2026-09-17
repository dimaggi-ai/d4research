// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics unsafeEffectTypeAssertion:off
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@d4research/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { pairCommand } from "./cli/pair.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { uninstallCommand } from "./cli/uninstall.ts";
import { updateCommand } from "./cli/update.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { serviceLauncherCommand } from "./cli/serviceLauncher.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { sshHelperCommand } from "./cli/sshHelper.ts";
import { themeCommand } from "./cli/theme.ts";
import { triageCommand } from "./cli/triage.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

export const makeCli = () =>
  Command.make("d4research", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the T3 Code server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      pairCommand,
      authCommand,
      projectCommand,
      serviceCommand,
      updateCommand,
      uninstallCommand,
      serviceLauncherCommand,
      claudeHistoryCommand,
      servicePreflightCommand,
      sshHelperCommand,
      themeCommand,
      triageCommand,
    ]),
  );

export const cli = makeCli();

if (import.meta.main) {
  const main = Effect.provide(
    Effect.scoped(Command.run(cli, { version: packageJson.version })),
    CliRuntimeLayer,
  ) as Effect.Effect<void, unknown, never>;
  NodeRuntime.runMain(main);
}
