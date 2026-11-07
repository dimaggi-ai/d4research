import { EnvironmentId } from "@d4research/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";

type Presentation = {
  connection: { phase: "connected" };
  entry: { target: { label: string } };
};
const state = vi.hoisted(() => ({
  presentations: undefined as Atom.Writable<ReadonlyMap<EnvironmentId, Presentation>> | undefined,
  refreshProviders: vi.fn(),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("react-native", () => ({ Alert: {}, Pressable: "button", View: "div" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./usageProviders", () => ({ useProviderColors: () => ({}) }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return state.presentations;
    },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    refreshProviders: {
      label: "refresh limits",
      run: (_registry: unknown, input: unknown) => state.refreshProviders(input),
    },
  },
}));

import { useRefreshLimits } from "./UsageLimitsSection";
import { refreshEnvironmentLimits } from "./usageLimitsRefresh";
import { refreshUsageLimits } from "@d4research/client-runtime/state/usage";

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let view: ReturnType<typeof useRefreshLimits>;
function Probe({
  selected,
  active,
}: {
  selected: ReadonlySet<EnvironmentId> | null;
  active: boolean;
}) {
  const current = useRefreshLimits(selected, active);
  useLayoutEffect(() => {
    view = current;
  }, [current]);
  return null;
}
async function render(selected: ReadonlySet<EnvironmentId> | null = null, active = false) {
  await act(async () => {
    root.render(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(Probe, { selected, active }),
      ),
    );
  });
}
const presentation = (label: string): Presentation => ({
  connection: { phase: "connected" },
  entry: { target: { label } },
});
const success = () => AsyncResult.success(undefined);
const failure = () => AsyncResult.failure(Cause.fail("Connection lost"));

beforeEach(() => {
  state.refreshProviders.mockReset();
  state.presentations = Atom.make<ReadonlyMap<EnvironmentId, Presentation>>(new Map());
  registry = AtomRegistry.make();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

it("keeps a newer environment failure when an older refresh finishes", async () => {
  const a = EnvironmentId.make("mobile-limits-a");
  const b = EnvironmentId.make("mobile-limits-b");
  const pending = Promise.withResolvers<ReturnType<typeof success>>();
  registry.set(state.presentations!, new Map([[a, presentation("A")]]));
  state.refreshProviders.mockImplementation(({ environmentId }) =>
    environmentId === a ? pending.promise : Promise.resolve(failure()),
  );
  await render();
  let first: Promise<void>;
  await act(async () => {
    first = view.refresh();
  });
  await act(async () => {
    registry.set(
      state.presentations!,
      new Map([
        [a, presentation("A")],
        [b, presentation("B")],
      ]),
    );
  });
  await render(null, true);
  await act(async () => {
    await refreshEnvironmentLimits(registry, b);
  });
  expect(view.failedLabels).toEqual(["B"]);
  await act(async () => {
    pending.resolve(success());
    await first;
  });
  expect(view.failedLabels).toEqual(["B"]);
});

it("does not let an older multi-environment batch clear a newer failure for the same environment", async () => {
  const a = EnvironmentId.make("mobile-limits-race-a");
  const b = EnvironmentId.make("mobile-limits-race-b");
  const aFirst = Promise.withResolvers<ReturnType<typeof success>>();
  const bFirst = Promise.withResolvers<ReturnType<typeof success>>();
  registry.set(
    state.presentations!,
    new Map([
      [a, presentation("A")],
      [b, presentation("B")],
    ]),
  );
  let aCalls = 0;
  state.refreshProviders.mockImplementation(({ environmentId }) =>
    environmentId === b
      ? bFirst.promise
      : ++aCalls === 1
        ? aFirst.promise
        : Promise.resolve(failure()),
  );
  await render(null, true);
  const older = Promise.all([
    refreshEnvironmentLimits(registry, a),
    refreshEnvironmentLimits(registry, b),
  ]);
  await act(async () => {
    aFirst.resolve(success());
    await refreshUsageLimits(a, () => aFirst.promise);
  });
  const selected = new Set([a]);
  await render(selected, true);
  await act(async () => {
    await view.refresh();
  });
  expect(view.failedLabels).toEqual(["A"]);
  await act(async () => {
    bFirst.resolve(success());
    await older;
  });
  expect(view.failedLabels).toEqual(["A"]);
});
