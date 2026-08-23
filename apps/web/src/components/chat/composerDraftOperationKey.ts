import { scopedThreadKey } from "@d4research/client-runtime/environment";
import type { ScopedThreadRef } from "@d4research/contracts";

import type { DraftId } from "../../composerDraftStore";

/** Stable key for async composer work; object coercion aliases every server thread. */
export function composerDraftOperationKey(target: ScopedThreadRef | DraftId): string {
  return typeof target === "string" ? target : scopedThreadKey(target);
}
