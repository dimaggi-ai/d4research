import type { EnvironmentId, ThreadId } from "@d4research/contracts";
import { squashAtomCommandFailure } from "@d4research/client-runtime/state/runtime";
import type { PipelineInterruption } from "@d4research/shared/pipelineRunResume";
import { useAtomValue } from "@effect/atom-react";
import { RotateCcwIcon } from "lucide-react";
import { memo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const INTERRUPTION_LABEL: Record<PipelineInterruption, string> = {
  restart: "Interrupted by restart",
  user: "Stopped",
  failed: "Failed",
};

/**
 * Offers to continue a pipeline run that a restart, a stop, or a failure cut
 * short. The server resumes from its step ledger, so completed steps are not
 * delegated again.
 */
export const PipelineResumeBanner = memo(function PipelineResumeBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly interruption: PipelineInterruption;
}) {
  const resume = useAtomCommand(serverEnvironment.resumePipelineRun, { reportFailure: false });
  const allowed = useAtomValue(
    serverEnvironment.resumePipelineRun.permissionAtom(props.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!allowed) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span>{INTERRUPTION_LABEL[props.interruption]}: the pipeline run did not finish.</span>
      <Button
        size="compact"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await resume({
            environmentId: props.environmentId,
            input: { threadId: props.threadId },
          });
          setBusy(false);
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            setError(
              typeof failure === "object" && failure !== null && "detail" in failure
                ? String(failure.detail)
                : "The run could not be resumed.",
            );
          }
        }}
      >
        <RotateCcwIcon />
        Resume
      </Button>
      {error !== null ? <span className="text-destructive-foreground">{error}</span> : null}
    </div>
  );
});
