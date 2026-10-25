import type { D4AgentState, EnvironmentId } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function D4AgentSessions({
  environmentId,
  sessions,
  refresh,
}: {
  environmentId: EnvironmentId;
  sessions: NonNullable<D4AgentState["openSessions"]>;
  refresh: () => void;
}) {
  const close = useAtomCommand(serverEnvironment.closeD4AgentSession);
  const allowed = useAtomValue(serverEnvironment.closeD4AgentSession.permissionAtom(environmentId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  return (
    <details className="py-2">
      <summary className="cursor-pointer text-sm">Open sessions · {sessions.length}/4</summary>
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open sessions.</p>
      ) : null}
      {sessions.map((session) => (
        <div
          key={session.context}
          className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-xs"
        >
          <div>
            <p className="font-medium">{session.context}</p>
            <p className="text-muted-foreground">
              Last activity: <time dateTime={session.lastActivityAt}>{session.lastActivityAt}</time>
            </p>
            <p className="text-muted-foreground">
              {session.inputTokens} input tokens · context window{" "}
              {session.contextWindow ?? "unavailable"}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={!allowed || busy !== null}
            onClick={async () => {
              setBusy(session.context);
              setError(false);
              try {
                const result = await close({ environmentId, input: { context: session.context } });
                if (result._tag === "Failure") setError(true);
                else refresh();
              } catch {
                setError(true);
              }
              setBusy(null);
            }}
          >
            {busy === session.context ? "Closing…" : `Close ${session.context} session`}
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not close this session.
        </p>
      ) : null}
    </details>
  );
}
