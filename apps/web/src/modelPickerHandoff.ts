import type { ProviderDriverKind } from "@t3tools/contracts";

export function shouldRestrictModelPickerToLockedProvider(input: {
  readonly lockedProvider: ProviderDriverKind | null;
  readonly allowCrossProviderSelection: boolean;
}): boolean {
  return input.lockedProvider !== null && !input.allowCrossProviderSelection;
}
