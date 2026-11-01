import * as Effect from "effect/Effect";
import WorkspaceRoots from "./041_ProjectionProjectWorkspaceRoots.ts";
import AuthClientConnection from "./041_AuthSessionClientConnection.ts";

// Upstream and fork releases used different meanings for ids 41–44. A database
// that advanced past those ids needs the same additive repairs after v2 cutover.
export default WorkspaceRoots.pipe(Effect.andThen(AuthClientConnection));
