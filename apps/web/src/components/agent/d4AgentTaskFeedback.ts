import { D4AgentError, type ModelSelection, type ServerProvider } from "@d4research/contracts";
import * as Schema from "effect/Schema";

const isD4AgentError = Schema.is(D4AgentError);

function providerQuotaExhausted(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null,
) {
  const provider = providers.find((entry) => entry.instanceId === selection?.instanceId);
  return (
    provider?.usageLimits?.windows.some(
      (window) =>
        window.usedPercent >= 100 &&
        (window.resetsAt === undefined || Date.parse(window.resetsAt) > Date.now()),
    ) === true
  );
}

export function d4AgentTaskFailureMessage(input: {
  failure: unknown;
  preserved: "Your brief is preserved." | "Your draft is preserved.";
  providers: ReadonlyArray<ServerProvider>;
  selection: ModelSelection | null;
}) {
  const { failure, preserved, providers, selection } = input;
  if (!isD4AgentError(failure)) return `Could not send this message. ${preserved}`;
  if (failure.reason === "stale")
    return `Not sent: Nia's context or session changed after you wrote this. ${preserved} Check it, then try again.`;
  if (failure.reason === "provider-unavailable") {
    return providerQuotaExhausted(providers, selection)
      ? `The selected task provider is out of quota. Choose another task model or try again after the quota resets. ${preserved}`
      : `The selected task provider is unavailable or not authenticated. Check the provider connection or choose another task model. ${preserved}`;
  }
  if (failure.reason === "model-mismatch") return `${failure.message} ${preserved}`;
  if (failure.detail) return `${failure.detail} ${preserved}`;
  if (failure.reason === "model-unavailable")
    return `The selected task model is unavailable. Choose another task model. ${preserved}`;
  if (failure.reason === "option-unavailable")
    return `The selected task model options are unavailable. Choose valid options or another task model. ${preserved}`;
  return `Could not send this message. ${preserved}`;
}
