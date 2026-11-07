import {
  type ModelSelection,
  type ProviderInteractionMode,
  type ThreadId,
} from "@d4research/contracts";

const draftSendStateByRouteKey = new Map<
  string,
  {
    readonly sendInFlight: { current: boolean };
    readonly uncertainSubmissions: { current: Map<string, ThreadId> };
  }
>();
export function draftSendState(routeKey: string) {
  let state = draftSendStateByRouteKey.get(routeKey);
  if (!state) {
    state = { sendInFlight: { current: false }, uncertainSubmissions: { current: new Map() } };
    draftSendStateByRouteKey.set(routeKey, state);
  }
  return state;
}

export interface MultipleModelTarget {
  readonly selection: ModelSelection;
  readonly text: string;
  readonly interactionMode: ProviderInteractionMode;
}
