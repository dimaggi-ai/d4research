import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@d4research/client-runtime/state/models";

export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}
