import * as Schema from "effect/Schema";
import { useLocalStorage } from "./useLocalStorage";

const scopeSchema = Schema.NullOr(Schema.String);

export function useSidebarProjectScope() {
  // The mobile sheet unmounts its contents on close; component state resets there.
  return useLocalStorage("t3code:sidebar-project-scope:v1", null, scopeSchema);
}
