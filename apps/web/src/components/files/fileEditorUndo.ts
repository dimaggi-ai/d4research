export function resolveFileEditorHistoryAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): "undo" | "redo" | null {
  if (event.key.toLowerCase() !== "z" || event.altKey || (!event.metaKey && !event.ctrlKey)) {
    return null;
  }
  return event.shiftKey ? "redo" : "undo";
}
