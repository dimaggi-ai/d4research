import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@d4research/client-runtime/environment";
import {
  communicationDetailRefs,
  communicationThreadKey,
  deriveThreadCommunication,
  retainThreadCommunication,
  type ThreadCommunication,
  type CommunicationSelection,
  type CommunicationParticipant,
} from "@d4research/client-runtime/state/thread-communication";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@d4research/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useThreadProjection, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { AgentCommunicationDialog } from "./AgentCommunicationDialog";
import { AgentCommunicationView } from "./AgentCommunicationView";

const selectedSourcesAtom = Atom.family((key: string) => {
  const ids = JSON.parse(key) as ReadonlyArray<readonly [string, string]>;
  const refs = ids.map(([environmentId, threadId]) =>
    scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
  );
  return Atom.make((get) =>
    refs.map((ref) => ({
      ref,
      thread: get(environmentThreadDetails.threadAtom(ref)),
      error: get(environmentThreadDetails.errorAtom(ref)),
      history: get(environmentThreadDetails.historyAtom(ref)),
    })),
  ).pipe(Atom.setIdleTTL(0));
});

/** Always visible for saved threads. Detail streams mount only while the dialog is open. */
export function AgentCommunicationControl(props: ScopedThreadRef) {
  return (
    <AgentCommunicationDialog>
      {(onClose) => (
        <ConnectedCommunication key={scopedThreadKey(props)} target={props} onClose={onClose} />
      )}
    </AgentCommunicationDialog>
  );
}

function ConnectedCommunication({
  target,
  onClose,
}: {
  target: ScopedThreadRef;
  onClose: () => void;
}) {
  const shells = useThreadShells();
  // Native child views use their parent conversation so sibling names and task IDs resolve.
  let root = target;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    const key = communicationThreadKey(root);
    if (seen.has(key)) break;
    seen.add(key);
    const shell = shells.find(
      (s) => s.environmentId === root.environmentId && s.id === root.threadId,
    );
    if (
      shell?.source.lineage.relationshipToParent !== "subagent" ||
      shell.source.lineage.parentThreadId === null
    )
      break;
    root = scopeThreadRef(root.environmentId, shell.source.lineage.parentThreadId);
  }
  const rootThread = useThreadProjection(root);
  const { environments } = useEnvironments();
  const labels = useMemo(
    () => new Map(environments.map((e) => [e.environmentId, e.label])),
    [environments],
  );
  const [selection, setSelection] = useState<CommunicationSelection>(() =>
    communicationThreadKey(target) === communicationThreadKey(root)
      ? { kind: "all" }
      : { kind: "participant", id: communicationThreadKey(target) },
  );
  const [detailRefs, setDetailRefs] = useState<ReadonlyArray<ScopedThreadRef>>(() =>
    communicationThreadKey(target) === communicationThreadKey(root) ? [] : [target],
  );
  const selected = useAtomValue(
    selectedSourcesAtom(JSON.stringify(detailRefs.map((ref) => [ref.environmentId, ref.threadId]))),
  );
  const rootHistory = useAtomValue(environmentThreadDetails.historyAtom(root));
  const rootError = useAtomValue(environmentThreadDetails.errorAtom(root));
  const currentModel = useMemo(() => {
    const sourceThreads = selected.flatMap((source) =>
      source.thread === null ? [] : [source.thread],
    );
    return deriveThreadCommunication({
      root: { environmentId: root.environmentId, threadId: root.threadId },
      threads: rootThread === null ? sourceThreads : [rootThread, ...sourceThreads],
      environmentLabels: labels,
    });
  }, [root.environmentId, root.threadId, rootThread, selected, labels]);
  const [retained, setRetained] = useState<ThreadCommunication | null>(null);
  useEffect(() => {
    setRetained((previous) => retainThreadCommunication(previous, currentModel));
  }, [currentModel]);
  const model = useMemo(
    () => retainThreadCommunication(retained, currentModel),
    [retained, currentModel],
  );
  const errors = [rootError, ...selected.map((source) => source.error)].filter(
    (error) => error !== null,
  );
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const navigate = useNavigate();
  const histories = [{ ref: root, history: rootHistory }, ...selected];
  const earlier = histories.find((source) => source.history.hasMoreHistory);
  const loading =
    rootThread === null ||
    selected.some((source) => source.thread === null && source.error === null);
  const openThread = (participant: CommunicationParticipant) => {
    if (participant.threadId === null) return;
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(participant.environmentId, participant.threadId),
      ),
    });
  };
  return (
    <>
      {errors.length > 0 || historyError ? (
        <p role="alert" className="shrink-0 px-6 pb-2 text-sm text-destructive">
          {historyError ?? errors.join(" · ")} Available records remain visible.
        </p>
      ) : null}
      <AgentCommunicationView
        model={model}
        selection={selection}
        onSelect={(next) => {
          const refs = communicationDetailRefs(model, next).filter(
            (ref) => communicationThreadKey(ref) !== model.rootId,
          );
          if (next.kind === "all" || refs.length > 0) setDetailRefs(refs);
          setSelection(next);
        }}
        loading={loading}
        onOpenThread={openThread}
        historyActions={
          earlier ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={earlier.history.loading}
              onClick={() => {
                setHistoryError(null);
                void loadEarlier({
                  environmentId: earlier.ref.environmentId,
                  input: { threadId: earlier.ref.threadId },
                }).then((result) => {
                  if (result._tag !== "Success")
                    setHistoryError("Could not load earlier history. Try again.");
                });
              }}
            >
              {earlier.history.loading ? "Loading history…" : "Load earlier history"}
            </Button>
          ) : null
        }
      />
    </>
  );
}
