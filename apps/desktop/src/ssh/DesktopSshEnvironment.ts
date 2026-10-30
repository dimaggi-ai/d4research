import { fetchRemoteEnvironmentDescriptor } from "@d4research/client-runtime/environment";
import type { BundledServerRuntime, DesktopBundledServerUpdateInput } from "@d4research/contracts";
import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@d4research/contracts";
import * as NetService from "@d4research/shared/Net";
import * as SshAuth from "@d4research/ssh/auth";
import { resolveSshTarget } from "@d4research/ssh/command";
import { discoverSshHosts } from "@d4research/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@d4research/ssh/errors";
import * as SshTunnel from "@d4research/ssh/tunnel";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly getBundledRuntime: Effect.Effect<BundledServerRuntime | null>;
    readonly updateBundledRuntime: (
      input: DesktopBundledServerUpdateInput,
    ) => Effect.Effect<BundledServerRuntime, DesktopSshEnvironmentOperationError>;
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@d4research/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveBundledRuntime?: Effect.Effect<SshTunnel.BundledSshRuntimeAsset | null>;
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteT3RunnerOptions>;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "T3 Code window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

/** @public */
export const make = Effect.fn("desktop.ssh.make")(function* (
  options: DesktopSshEnvironmentLayerOptions = {},
) {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));

  const getBundledRuntime = (options.resolveBundledRuntime ?? Effect.succeed(null)).pipe(
    Effect.map((asset) => asset?.metadata ?? null),
    Effect.orDie,
  );
  return DesktopSshEnvironment.of({
    getBundledRuntime,
    updateBundledRuntime: Effect.fn("desktop.ssh.updateBundledRuntime")(function* (input) {
      const metadata = yield* manager
        .updateBundledRuntime(input.target, input.environmentId, input.buildId)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
        );
      const bootstrap = yield* manager
        .ensureEnvironment(input.target)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
        );
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: bootstrap.httpBaseUrl,
      }).pipe(
        Effect.provide(runtimeContext),
        Effect.mapError(
          (cause) =>
            new SshLaunchError({
              stdout: "",
              message: "Could not verify the updated server.",
              cause,
            }),
        ),
      );
      if (
        descriptor.environmentId !== input.environmentId ||
        descriptor.serverBuildId !== metadata.buildId ||
        descriptor.serverVersion !== metadata.version
      ) {
        return yield* new SshLaunchError({
          stdout: "",
          message: "The remote server did not report the installed fork build.",
        });
      }
      return metadata;
    }),
    discoverHosts: Effect.fn("desktop.ssh.discoverHosts")((input) =>
      discoverDesktopSshHostsEffect(input).pipe(Effect.provide(runtimeContext)),
    ),
    resolveHost: Effect.fn("desktop.ssh.resolveHost")((alias) =>
      resolveSshTarget(alias.trim()).pipe(Effect.provide(runtimeContext)),
    ),
    ensureEnvironment: Effect.fn("desktop.ssh.ensureEnvironment")((target, ensureOptions) =>
      manager
        .ensureEnvironment(target, ensureOptions)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
        ),
    ),
    disconnectEnvironment: Effect.fn("desktop.ssh.disconnectEnvironment")((target) =>
      manager
        .disconnectEnvironment(target)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
        ),
    ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make(options)).pipe(
    Layer.provide(SshTunnel.SshEnvironmentManager.layer(options)),
  );
