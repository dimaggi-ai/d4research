import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@d4research/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { acpMcpBridgeCommand, acpMcpCallCommand } from "./cli/acpMcpBridge.ts";
import { authCommand } from "./cli/auth.ts";
import { appCommand } from "./cli/app.ts";
import { pairCommand } from "./cli/pair.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { updateCommand } from "./cli/update.ts";
import { uninstallCommand } from "./cli/uninstall.ts";
import { serviceLauncherCommand } from "./cli/serviceLauncher.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { sshHelperCommand } from "./cli/sshHelper.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { themeCommand } from "./cli/theme.ts";
import { traceCommand } from "./cli/trace.ts";
import { triageCommand } from "./cli/triage.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

export const makeCli = () =>
  Command.make("d4research", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the d4research server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      acpMcpBridgeCommand,
      acpMcpCallCommand,
      startCommand,
      serveCommand,
      appCommand,
      pairCommand,
      authCommand,
      projectCommand,
      serviceCommand,
      updateCommand,
      uninstallCommand,
      serviceLauncherCommand,
      claudeHistoryCommand,
      sshHelperCommand,

      servicePreflightCommand,
      themeCommand,
      traceCommand,
      triageCommand,
    ]),
  );

export const cli = makeCli();

export function runCli() {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
