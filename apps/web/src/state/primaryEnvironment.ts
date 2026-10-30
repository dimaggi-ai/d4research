import { isHostPrimaryConnectionTarget } from "@d4research/client-runtime/connection";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (isHostPrimaryConnectionTarget(entry.target)) {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));
