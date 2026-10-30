import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { resolveMergeBackTargetThreadId } from "@d4research/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@d4research/client-runtime/state/thread-workflows";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2ThreadProjection,
} from "@d4research/contracts";
import { useRef } from "react";

import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { useThreadSelection } from "../../state/use-thread-selection";

type Selection = ReturnType<typeof useThreadSelection>;
export function useThreadMergeBack(
  thread: Selection["selectedThread"],
  detail: OrchestrationV2ThreadProjection | null,
) {
  const selectDetail = useSelectWorkspaceDetail();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const targetThreadId = resolveMergeBackTargetThreadId(detail);
  const run = detail === null ? null : resolveLatestMergeBackRun(detail);
  const busyRef = useRef(false);
  const onMergeBack = async () => {
    if (busyRef.current || !canOperate || !thread || !targetThreadId || !run) return;
    busyRef.current = true;
    const result = await mergeBack({
      environmentId: thread.environmentId,
      input: {
        sourceThreadId: thread.id,
        targetThreadId,
        runId: run.id,
        creationSource: "mobile",
      },
    }).finally(() => {
      busyRef.current = false;
    });
    if (result._tag === "Success")
      selectDetail({
        name: "Thread",
        params: { environmentId: thread.environmentId, threadId: targetThreadId },
      });
  };
  return canOperate && targetThreadId !== null && run !== null
    ? () => void onMergeBack()
    : undefined;
}
