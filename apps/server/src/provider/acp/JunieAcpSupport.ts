import { type JunieSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type JunieAcpSettings = Pick<JunieSettings, "binaryPath" | "defaultModel">;

export interface JunieAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly junieSettings: JunieAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildJunieAcpSpawnInput(
  settings: JunieAcpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "junie",
    args: [
      "--acp=true",
      "--skip-update-check",
      ...(settings?.defaultModel ? ["--model", settings.defaultModel] : []),
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeJunieAcpRuntime = (
  input: JunieAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        safeRequestIds: true,
        spawn: buildJunieAcpSpawnInput(input.junieSettings, input.cwd, input.environment),
        // Junie advertises the active JetBrains/BYOK authentication method;
        // omitting the id lets the shared runtime select the first advertised one.
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
