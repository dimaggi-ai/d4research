import { useState } from "react";
import { FileTextIcon, RefreshCwIcon } from "lucide-react";
import { AuthFilesystemReadScope, type EnvironmentId, type ThreadId } from "@d4research/contracts";
import { notesList, notesRead } from "../../rpc/notes";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";

type ThreadNotesTarget = { environmentId: EnvironmentId; threadId: ThreadId };

export function ThreadNotesButton(target: ThreadNotesTarget) {
  const [open, setOpen] = useState(false);
  const canRead = useEnvironmentScope(target.environmentId, AuthFilesystemReadScope);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!canRead}
        aria-label="Open thread notes"
        onClick={() => setOpen(true)}
      >
        <FileTextIcon className="size-3.5" />
        Notes
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Notes</DialogTitle>
            <DialogDescription>Research artifacts from this thread.</DialogDescription>
          </DialogHeader>
          <DialogPanel>{open ? <ThreadNotes {...target} canRead={canRead} /> : null}</DialogPanel>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ThreadNotes({
  environmentId,
  threadId,
  canRead,
}: ThreadNotesTarget & { canRead: boolean }) {
  const [artifact, setArtifact] = useState<string | null>(null);
  const list = useEnvironmentQuery(
    canRead ? notesList({ environmentId, input: { threadId } }) : null,
  );
  if (!canRead) return <p role="status">This connection cannot read notes.</p>;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 break-all text-xs text-muted-foreground">
          {list.data?.folderStatus === "disabled"
            ? "Notes export is disabled. Set a Notes folder in Settings → Research."
            : list.data?.folderStatus === "unavailable"
              ? "The Notes folder is unavailable. Existing workspace artifacts are listed below."
              : list.data?.folder}
        </p>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh notes" onClick={list.refresh}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {list.error || list.data?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {list.error ?? list.data?.error}
        </p>
      ) : null}
      {list.isPending && !list.data ? <p role="status">Loading notes…</p> : null}
      {list.data?.entries.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No research artifacts in this thread.</p>
      ) : null}
      {list.data && list.data.entries.length > 0 ? (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/60 p-1">
          {list.data.entries.map((entry) => (
            <button
              key={entry.artifact}
              type="button"
              aria-pressed={artifact === entry.artifact}
              aria-label={`Read note ${entry.artifact}`}
              onClick={() => setArtifact(entry.artifact)}
              className="flex w-full min-w-0 items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-accent"
            >
              <span className="min-w-0 truncate font-mono">
                {entry.step} · visit {entry.visit} · {entry.runId}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {entry.outcome === "success" ? "Complete" : "Incomplete"} ·{" "}
                {entry.chars.toLocaleString()} chars
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {artifact ? (
        <NoteReader
          key={artifact}
          environmentId={environmentId}
          threadId={threadId}
          artifact={artifact}
        />
      ) : null}
    </div>
  );
}

function NoteReader({
  artifact,
  environmentId,
  threadId,
}: ThreadNotesTarget & { artifact: string }) {
  const [offsets, setOffsets] = useState([0]);
  const offset = offsets[offsets.length - 1] ?? 0;
  const note = useEnvironmentQuery(
    notesRead({ environmentId, input: { threadId, artifact, offset } }),
  );
  const nextOffset = note.data?.nextOffset ?? null;
  return (
    <div className="min-w-0 space-y-2">
      <p className="break-all font-mono text-xs text-muted-foreground">{artifact}</p>
      {note.error ? (
        <p role="alert" className="text-sm text-destructive">
          {note.error}
        </p>
      ) : null}
      {note.isPending ? <p role="status">Loading note…</p> : null}
      {note.data ? (
        <>
          <pre className="max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-xs">
            {note.data.text}
          </pre>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {offset.toLocaleString()}–{(offset + note.data.text.length).toLocaleString()} of{" "}
              {note.data.totalChars.toLocaleString()} chars
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offsets.length <= 1 || note.isPending}
                onClick={() => setOffsets((current) => current.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={nextOffset === null || note.isPending}
                onClick={() => {
                  if (nextOffset !== null) setOffsets((current) => [...current, nextOffset]);
                }}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
