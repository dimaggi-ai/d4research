import { create } from "zustand";

export interface PreparingComposerImage {
  readonly id: string;
  readonly name: string;
  /** The uncompressed source, thumbnailed so the placeholder shows the image itself. */
  readonly file: File;
}

/**
 * Images accepted into a draft but still being compressed, keyed by attachment target. Large
 * screenshots take a noticeable moment to re-encode, so the strip shows these right away and
 * they hold their attachment slots until the real image joins the draft.
 */
const usePreparingComposerImageStore = create<{
  readonly byTargetKey: Readonly<Record<string, ReadonlyArray<PreparingComposerImage>>>;
}>(() => ({ byTargetKey: {} }));

export function countPreparingComposerImages(targetKey: string): number {
  return usePreparingComposerImageStore.getState().byTargetKey[targetKey]?.length ?? 0;
}
