import {
  type JunieSettings,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeJunieAcpRuntime } from "../acp/JunieAcpSupport.ts";
import type { JunieAdapterShape } from "../Services/JunieAdapter.ts";
import { makeGrokAdapter, type GrokAdapterLiveOptions } from "./GrokAdapter.ts";

const JUNIE = ProviderDriverKind.make("junie");

export function resolveJunieModelSelection(
  selection: ModelSelection | null | undefined,
): ModelSelection | undefined {
  return selection?.model.trim() === "default" ? undefined : (selection ?? undefined);
}

const asJunieSession = (session: ProviderSession): ProviderSession => ({
  ...session,
  provider: JUNIE,
});

const asJunieEvent = (event: ProviderRuntimeEvent): ProviderRuntimeEvent => ({
  ...event,
  provider: JUNIE,
});

export interface JunieAdapterLiveOptions extends Omit<GrokAdapterLiveOptions, "makeRuntime"> {}

/**
 * Junie speaks standard ACP over stdio. The mature ACP orchestration core is
 * shared with Grok here; this boundary rewrites the provider identity while
 * Junie's runtime supplies its own launch and authentication negotiation.
 */
export const makeJunieAdapter = (settings: JunieSettings, options?: JunieAdapterLiveOptions) =>
  makeGrokAdapter(settings, {
    ...options,
    instanceId: options?.instanceId ?? ProviderInstanceId.make("junie"),
    providerIdentity: {
      kind: JUNIE,
      displayName: "Junie",
    },
    makeRuntime: (input) =>
      makeJunieAcpRuntime({
        ...input,
        junieSettings: settings,
      }),
  }).pipe(
    Effect.map(
      (base) =>
        ({
          ...base,
          provider: JUNIE,
          startSession: (input) =>
            base
              .startSession({
                ...input,
                modelSelection: resolveJunieModelSelection(input.modelSelection),
              })
              .pipe(Effect.map(asJunieSession)),
          sendTurn: (input) =>
            base.sendTurn({
              ...input,
              modelSelection: resolveJunieModelSelection(input.modelSelection),
            }),
          listSessions: () =>
            base.listSessions().pipe(Effect.map((sessions) => sessions.map(asJunieSession))),
          streamEvents: base.streamEvents.pipe(Stream.map(asJunieEvent)),
        }) satisfies JunieAdapterShape,
    ),
  );
