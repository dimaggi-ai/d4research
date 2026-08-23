import type { ProviderDriverKind } from "@d4research/contracts";

export function shouldRestrictModelPickerToLockedProvider(input: {
  readonly lockedProvider: ProviderDriverKind | null;
  readonly allowCrossProviderSelection: boolean;
}): boolean {
  return input.lockedProvider !== null && !input.allowCrossProviderSelection;
}
