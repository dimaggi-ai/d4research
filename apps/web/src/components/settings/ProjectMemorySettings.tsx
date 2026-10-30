import type { EnvironmentId, ProjectId } from "@d4research/contracts";
import { useState } from "react";
import { projectMemory } from "../../state/projectMemory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function ProjectMemorySettings({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const query = useEnvironmentQuery(projectMemory.list({ environmentId, input: { projectId } }));
  const read = useAtomCommand(projectMemory.read);
  const save = useAtomCommand(projectMemory.save);
  const remove = useAtomCommand(projectMemory.remove);
  const [draft, setDraft] = useState<{ name: string; description: string; content: string } | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium">Project notes and memory</h3>
      <p className="text-xs text-muted-foreground">
        Shared across every thread in this project and its workspace copies. Agents receive names
        and descriptions on the first message and read full entries only when needed. Do not store
        secrets.
      </p>
      {(query.error || error) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? query.error}
        </p>
      )}
      {query.isPending && !query.data && (
        <p className="text-xs text-muted-foreground">Loading memories…</p>
      )}
      {query.data?.map((memory) => (
        <div key={memory.name} className="flex items-start gap-2 border-b border-border/50 pb-2">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm">{memory.name}</p>
            <p className="break-words text-xs text-muted-foreground">{memory.description}</p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await read({
                  environmentId,
                  input: { projectId, name: memory.name },
                });
                if (result._tag === "Success") {
                  const { name, description, content } = result.value;
                  setDraft({ name, description, content });
                  setEditing(true);
                } else setError("Could not read memory.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmDelete(memory.name)}
          >
            Delete
          </Button>
        </div>
      ))}
      {confirmDelete && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>Delete {confirmDelete}?</span>
          <Button
            size="xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await remove({
                  environmentId,
                  input: { projectId, name: confirmDelete },
                });
                if (result._tag === "Success") {
                  if (draft?.name === confirmDelete) setDraft(null);
                  setConfirmDelete(null);
                  query.refresh();
                } else setError("Could not delete memory.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(null)}>
            Cancel
          </Button>
        </div>
      )}
      {draft ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!editing && query.data?.some((memory) => memory.name === draft.name)) {
              setError("That name already exists. Edit the existing memory instead.");
              return;
            }
            setBusy(true);
            setError(null);
            try {
              const result = await save({ environmentId, input: { projectId, ...draft } });
              if (result._tag === "Success") {
                setDraft(null);
                query.refresh();
              } else setError("Could not save memory.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="block text-xs">
            Name
            <Input
              required
              disabled={editing || busy}
              pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
              maxLength={100}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            When to use this memory
            <Input
              required
              disabled={busy}
              maxLength={300}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            Content
            <Textarea
              required
              disabled={busy}
              maxLength={16_000}
              className="min-h-32"
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="xs" disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setDraft({ name: "", description: "", content: "" });
            setEditing(false);
          }}
        >
          Add memory
        </Button>
      )}
    </section>
  );
}
