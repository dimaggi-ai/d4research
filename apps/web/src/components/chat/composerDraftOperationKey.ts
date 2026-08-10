import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";

/** Stable key for async composer work; object coercion aliases every server thread. */
export function composerDraftOperationKey(target: ScopedThreadRef | DraftId): string {
  return typeof target === "string" ? target : scopedThreadKey(target);
}
