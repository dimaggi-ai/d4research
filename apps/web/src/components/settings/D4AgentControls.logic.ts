import type { ModelSelection } from "@d4research/contracts";

export function withAgentModelOption(
  selection: ModelSelection,
  id: string,
  value: string,
): ModelSelection {
  return {
    ...selection,
    options: [
      ...(selection.options ?? []).filter((option) => option.id !== id),
      ...(value ? [{ id, value }] : []),
    ],
  };
}
