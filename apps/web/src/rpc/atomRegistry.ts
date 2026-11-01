import { RegistryContext } from "@effect/atom-react";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { createElement } from "react";

export let appAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider({ children }: React.PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: appAtomRegistry }, children);
}

/** Replaces the process-wide registry so isolated hook tests cannot leak atoms between cases. */
export function resetAppAtomRegistryForTests(): void {
  appAtomRegistry.dispose();
  appAtomRegistry = AtomRegistry.make();
}

/**
 * Calls `listener` with each value after the current one. A bare `subscribe` never computes a
 * derived atom nobody has read, so it never learns its parents and never fires.
 */
export function subscribeAtomChanges<A>(
  atom: Atom.Atom<A>,
  listener: (value: A) => void,
): () => void {
  let current = true;
  return appAtomRegistry.subscribe(
    atom,
    (value) => {
      if (current) {
        current = false;
        return;
      }
      listener(value);
    },
    { immediate: true },
  );
}
