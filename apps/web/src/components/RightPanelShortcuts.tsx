import { useAtomValue } from "@effect/atom-react";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand, resolveTextInputShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useRightPanelStore } from "../rightPanelStore";
import { resolveThreadRouteRef } from "../threadRoutes";

// Register before route listeners so printable shortcuts cannot enter the focused field.
// Settings owns keypresses while bindings are being edited there.
export function RightPanelShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threadRef = useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params ?? {};
      return resolveThreadRouteRef(params as Record<string, string | undefined>);
    },
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // The listener registers once and reads through this, so it can never be re-ordered behind a
  // listener mounted later.
  const stateRef = useRef({ keybindings, threadRef, pathname });
  stateRef.current = { keybindings, threadRef, pathname };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the window shortcut listener for the mounted app and remove it on unmount.
  useEffect(() => {
    const claim = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const resolve = (key: string, modifiers: Partial<KeyboardEvent> = {}) => {
      const current = stateRef.current;
      if (current.pathname.startsWith("/settings")) return null;
      if (isCommandPaletteOpen()) return null;
      const command = resolveShortcutCommand(
        {
          key,
          metaKey: modifiers.metaKey ?? false,
          ctrlKey: modifiers.ctrlKey ?? false,
          shiftKey: modifiers.shiftKey ?? false,
          altKey: modifiers.altKey ?? false,
          ...(modifiers.code === undefined ? {} : { code: modifiers.code }),
        },
        current.keybindings,
      );
      return command === "rightPanel.toggle" || command === "rightPanel.toggleMaximized"
        ? command
        : null;
    };

    const resolveTextInput = (text: string) => {
      const current = stateRef.current;
      if (current.pathname.startsWith("/settings")) return null;
      if (isCommandPaletteOpen()) return null;
      const command = resolveTextInputShortcutCommand(text, current.keybindings);
      return command === "rightPanel.toggle" || command === "rightPanel.toggleMaximized"
        ? command
        : null;
    };

    const run = (command: "rightPanel.toggle" | "rightPanel.toggleMaximized") => {
      const ref = stateRef.current.threadRef;
      // Off a thread there is no panel to act on, but the key is still claimed above: a binding
      // that types itself into a field on some routes and not others is worse than one that
      // occasionally does nothing.
      if (!ref) return;
      const store = useRightPanelStore.getState();
      if (command === "rightPanel.toggle") {
        store.toggleVisibility(ref);
        return;
      }
      // One press from closed opens and maximizes, since waiting for a second press reads as a
      // dropped key.
      if (!store.byThreadKey[`${ref.environmentId}:${ref.threadId}`]?.isOpen) {
        store.toggleVisibility(ref);
        store.setMaximized(ref, true);
        return;
      }
      store.toggleMaximized(ref);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const command = resolve(event.key, event);
      if (command === null) return;
      claim(event);
      if (!event.repeat) run(command);
    };

    // macOS can deliver a key such as the section sign to an editable surface as text input with no
    // matching keydown shape, so the insertion itself is the last place to catch it.
    const onBeforeInput = (event: InputEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.inputType !== "insertText" ||
        event.data === null ||
        [...event.data].length !== 1
      ) {
        return;
      }
      const command = resolveTextInput(event.data);
      if (command === null) return;
      claim(event);
      run(command);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("beforeinput", onBeforeInput, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, []);

  return null;
}
