import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";

// AndroidAnchoredMenu projects its dropdown here instead of into an RN Modal: a Modal is a
// separate native window, so presenting one moves window focus and closes the soft keyboard —
// which matters for menus anchored to the keyboard-sticky composer pills.
type Entries = ReadonlyMap<number, ReactNode>;
type Listener = (entries: Entries) => void;

let nextKey = 0;
function allocatePortalKey() {
  return nextKey++;
}
const entries = new Map<number, ReactNode>();
const listeners = new Set<Listener>();

function emit() {
  const snapshot = new Map(entries);
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function OverlayPortal(props: { readonly children: ReactNode }) {
  const [key] = useState(allocatePortalKey);

  // No dependency array: re-project after every render so the host always
  // shows the current content (menus re-render while open — drill-in, theme).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Project the current children into the external native overlay host registry.
  useEffect(() => {
    entries.set(key, props.children);
    emit();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Remove this external overlay registry entry when its owning portal unmounts.
  useEffect(
    () => () => {
      entries.delete(key);
      emit();
    },
    [key],
  );

  return null;
}

export function OverlayPortalHost() {
  const [current, setCurrent] = useState<Entries>(() => new Map());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe the native overlay host to external portal registry changes.
  useEffect(() => {
    listeners.add(setCurrent);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  if (current.size === 0) {
    return null;
  }
  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      {[...current.entries()].map(([key, node]) => (
        <View key={key} pointerEvents="box-none" className="absolute inset-0">
          {node}
        </View>
      ))}
    </View>
  );
}
