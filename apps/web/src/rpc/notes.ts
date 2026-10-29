import { WS_METHODS } from "@d4research/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@d4research/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const notesList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web-thread-notes-list",
  tag: WS_METHODS.notesList,
  staleTimeMs: 0,
});
export const notesRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web-thread-notes-read",
  tag: WS_METHODS.notesRead,
  staleTimeMs: 0,
});
