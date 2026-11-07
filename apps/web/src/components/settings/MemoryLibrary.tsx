import { useAtomValue } from "@effect/atom-react";
import type {
  AlmanacMemory,
  AlmanacPassage,
  BrainCatalogEntry,
  EnvironmentId,
} from "@d4research/contracts";
import { useState, type ReactNode } from "react";
import { almanac } from "../../state/almanac";
import { useDebouncedValue } from "../../state/queries";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { secondBrain } from "../../state/second-brain";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

type Selection =
  | { readonly kind: "note"; readonly path: string }
  | { readonly kind: "source"; readonly sourceId: string; readonly title: string }
  | { readonly kind: "memory"; readonly memory: AlmanacMemory };

type Select = (selection: Selection) => void;

const READ_WINDOW = 8000;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

function Row({
  title,
  detail,
  meta,
  selected,
  onClick,
}: {
  title: string;
  detail?: string | undefined;
  meta?: string | null | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        className={`w-full rounded-md px-3 py-2 text-left hover:bg-accent ${selected ? "bg-accent" : ""}`}
        onClick={onClick}
      >
        <span className="block truncate text-sm font-medium">{title}</span>
        {detail && (
          <span className="line-clamp-2 block text-xs text-muted-foreground">{detail}</span>
        )}
        {meta && <span className="block text-xs text-muted-foreground">{meta}</span>}
      </button>
    </li>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="px-3 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}

function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p role={alert ? "alert" : "status"} className="px-3 py-2 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function sameSource(selection: Selection | null, sourceId: string) {
  return selection?.kind === "source" && selection.sourceId === sourceId;
}

function sameMemory(selection: Selection | null, id: string) {
  return selection?.kind === "memory" && selection.memory.id === id;
}

function PassageRow({
  passage,
  selection,
  onSelect,
}: {
  passage: AlmanacPassage;
  selection: Selection | null;
  onSelect: Select;
}) {
  return (
    <Row
      title={passage.title}
      detail={passage.text}
      meta={passage.date}
      selected={sameSource(selection, passage.sourceId)}
      onClick={() => onSelect({ kind: "source", sourceId: passage.sourceId, title: passage.title })}
    />
  );
}

function MemoryRow({
  memory,
  selection,
  onSelect,
}: {
  memory: AlmanacMemory;
  selection: Selection | null;
  onSelect: Select;
}) {
  return (
    <Row
      title={memory.text}
      meta={[memory.date, memory.category].filter(Boolean).join(" · ")}
      selected={sameMemory(selection, memory.id)}
      onClick={() => onSelect({ kind: "memory", memory })}
    />
  );
}

function NotesList({
  environmentId,
  selection,
  onSelect,
}: {
  environmentId: EnvironmentId;
  selection: Selection | null;
  onSelect: Select;
}) {
  const catalog = useEnvironmentQuery(secondBrain.secondBrainCatalogQuery(environmentId));
  if (catalog.error) return <Message alert>{catalog.error}</Message>;
  if (!catalog.data) return <Message>Loading notes…</Message>;
  if (catalog.data.length === 0) return <Message>This folder has no notes.</Message>;
  const groups = new Map<string, BrainCatalogEntry[]>();
  for (const note of catalog.data) {
    const folder = note.path.includes("/") ? note.path.split("/")[0]! : "Top level";
    groups.set(folder, [...(groups.get(folder) ?? []), note]);
  }
  return (
    <>
      {[...groups].map(([folder, notes]) => (
        <Group key={folder} title={folder}>
          {notes.map((note) => (
            <Row
              key={note.path}
              title={note.title}
              detail={note.summary}
              selected={selection?.kind === "note" && selection.path === note.path}
              onClick={() => onSelect({ kind: "note", path: note.path })}
            />
          ))}
        </Group>
      ))}
    </>
  );
}

function AlmanacList({
  environmentId,
  selection,
  onSelect,
}: {
  environmentId: EnvironmentId;
  selection: Selection | null;
  onSelect: Select;
}) {
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState(0);
  const browse = useEnvironmentQuery(almanac.almanacBrowseQuery({ environmentId, path, offset }));
  const open = (next: string) => {
    setPath(next);
    setOffset(0);
  };
  const data = browse.data;
  const empty = data && !data.categories.length && !data.memories.length && !data.passages.length;
  return (
    <>
      {path && (
        <Button
          variant="ghost"
          onClick={() => open(path.slice(0, Math.max(0, path.lastIndexOf("/"))))}
        >
          Back from {path}
        </Button>
      )}
      {browse.error && <Message alert>{browse.error}</Message>}
      {browse.isPending && !data && <Message>Loading Almanac…</Message>}
      {empty && <Message>Nothing is stored here yet.</Message>}
      {data && data.categories.length > 0 && (
        <Group title="Categories">
          {data.categories.map((category) => (
            <Row
              key={category.path}
              title={category.path}
              meta={`${category.items} items`}
              selected={false}
              onClick={() => open(category.path)}
            />
          ))}
        </Group>
      )}
      {data && data.memories.length > 0 && (
        <Group title="Memories">
          {data.memories.map((memory) => (
            <MemoryRow key={memory.id} memory={memory} selection={selection} onSelect={onSelect} />
          ))}
        </Group>
      )}
      {data && data.passages.length > 0 && (
        <Group title="Documents">
          {data.passages.map((passage) => (
            <PassageRow
              key={`${passage.sourceId}@${passage.start}`}
              passage={passage}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </Group>
      )}
      {(offset > 0 || data?.nextOffset != null) && (
        <div className="flex gap-2 px-3">
          <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(0)}>
            First page
          </Button>
          <Button
            variant="outline"
            disabled={data?.nextOffset == null}
            onClick={() => setOffset(data?.nextOffset ?? offset)}
          >
            Next page
          </Button>
        </div>
      )}
      <RememberForm environmentId={environmentId} />
    </>
  );
}

function RememberForm({ environmentId }: { environmentId: EnvironmentId }) {
  const remember = useAtomCommand(almanac.almanacRememberCommand);
  const canWrite = useAtomValue(almanac.almanacRememberCommand.permissionAtom(environmentId));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await remember({ environmentId, input: { text: text.trim() } });
    setBusy(false);
    if (result._tag === "Success") setText("");
    else setError(formatEnvironmentQueryError(result.cause));
  };
  return (
    <div className="space-y-2 border-t px-3 pt-3">
      <Textarea
        aria-label="New memory"
        placeholder="Add one fact as a short sentence"
        value={text}
        rows={2}
        maxLength={8192}
        disabled={!canWrite || busy}
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        variant="outline"
        disabled={!canWrite || busy || !text.trim()}
        onClick={() => void save()}
      >
        Save memory
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function SearchResults({
  environmentId,
  query,
  notesEnabled,
  almanacEnabled,
  selection,
  onSelect,
}: {
  environmentId: EnvironmentId;
  query: string;
  notesEnabled: boolean;
  almanacEnabled: boolean;
  selection: Selection | null;
  onSelect: Select;
}) {
  return (
    <>
      {notesEnabled && (
        <NoteResults
          environmentId={environmentId}
          query={query}
          selection={selection}
          onSelect={onSelect}
        />
      )}
      {almanacEnabled && (
        <AlmanacResults
          environmentId={environmentId}
          query={query}
          selection={selection}
          onSelect={onSelect}
        />
      )}
    </>
  );
}

function NoteResults({
  environmentId,
  query,
  selection,
  onSelect,
}: {
  environmentId: EnvironmentId;
  query: string;
  selection: Selection | null;
  onSelect: Select;
}) {
  const results = useEnvironmentQuery(
    secondBrain.secondBrainSearchQuery({ environmentId, query, limit: 20 }),
  );
  const seen = new Set<string>();
  const unique = (results.data?.results ?? []).filter(({ citation }) => {
    if (seen.has(citation.path)) return false;
    seen.add(citation.path);
    return true;
  });
  return (
    <Group title="Notes">
      {results.error && <Message alert>{results.error}</Message>}
      {results.isPending && !results.data && <Message>Searching notes…</Message>}
      {results.data && unique.length === 0 && <Message>No matching notes.</Message>}
      {unique.map(({ citation }) => (
        <Row
          key={citation.path}
          title={citation.path}
          detail={citation.excerpt}
          selected={selection?.kind === "note" && selection.path === citation.path}
          onClick={() => onSelect({ kind: "note", path: citation.path })}
        />
      ))}
    </Group>
  );
}

function AlmanacResults({
  environmentId,
  query,
  selection,
  onSelect,
}: {
  environmentId: EnvironmentId;
  query: string;
  selection: Selection | null;
  onSelect: Select;
}) {
  const passages = useEnvironmentQuery(
    almanac.almanacSearchQuery({ environmentId, query, limit: 20 }),
  );
  const memories = useEnvironmentQuery(
    almanac.almanacRecallQuery({ environmentId, query, limit: 20 }),
  );
  const none = passages.data?.passages.length === 0 && memories.data?.memories.length === 0;
  return (
    <Group title="Almanac">
      {(passages.error ?? memories.error) && (
        <Message alert>{passages.error ?? memories.error}</Message>
      )}
      {passages.isPending && !passages.data && <Message>Searching Almanac…</Message>}
      {none && <Message>No matches in Almanac.</Message>}
      {passages.data?.indexingIncomplete && (
        <Message>Almanac is still indexing, so results may be missing.</Message>
      )}
      {memories.data?.memories.map((memory) => (
        <MemoryRow key={memory.id} memory={memory} selection={selection} onSelect={onSelect} />
      ))}
      {passages.data?.passages.map((passage) => (
        <PassageRow
          key={`${passage.sourceId}@${passage.start}`}
          passage={passage}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
    </Group>
  );
}

function NoteReader({ environmentId, path }: { environmentId: EnvironmentId; path: string }) {
  const note = useEnvironmentQuery(secondBrain.secondBrainNoteQuery({ environmentId, path }));
  return (
    <article className="space-y-3">
      <h3 className="break-words text-sm font-medium">{path}</h3>
      {note.error && <p role="alert">{note.error}</p>}
      {!note.data && !note.error && <p role="status">Loading note…</p>}
      {note.data && (
        <ChatMarkdown text={note.data.content.replace(FRONTMATTER, "")} cwd={undefined} />
      )}
      {note.data?.truncated && <p role="note">This note is too long to show in full.</p>}
    </article>
  );
}

function SourceReader({
  environmentId,
  sourceId,
  title,
}: {
  environmentId: EnvironmentId;
  sourceId: string;
  title: string;
}) {
  const [start, setStart] = useState(0);
  const source = useEnvironmentQuery(
    almanac.almanacReadQuery({ environmentId, sourceId, start, maxChars: READ_WINDOW }),
  );
  const data = source.data;
  return (
    <article className="space-y-3">
      <h3 className="break-words text-sm font-medium">{title}</h3>
      {source.error && <p role="alert">{source.error}</p>}
      {!data && !source.error && <p role="status">Loading document…</p>}
      {data && (
        <>
          <p className="break-words text-xs text-muted-foreground">
            {data.uri} · characters {data.start}–{data.end} of {data.total}
          </p>
          <ChatMarkdown text={data.content} cwd={undefined} />
          {(data.start > 0 || data.end < data.total) && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={data.start === 0}
                onClick={() => setStart(Math.max(0, data.start - READ_WINDOW))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={data.end >= data.total}
                onClick={() => setStart(data.end)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </article>
  );
}

function MemoryReader({
  environmentId,
  memory,
  onForgotten,
}: {
  environmentId: EnvironmentId;
  memory: AlmanacMemory;
  onForgotten: () => void;
}) {
  const update = useAtomCommand(almanac.almanacUpdateCommand);
  const forget = useAtomCommand(almanac.almanacForgetCommand);
  const canUpdate = useAtomValue(almanac.almanacUpdateCommand.permissionAtom(environmentId));
  const canForget = useAtomValue(almanac.almanacForgetCommand.permissionAtom(environmentId));
  const [text, setText] = useState(memory.text);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shortened = text.endsWith("…");
  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { memoryId: memory.id, text: draft.trim() },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setText(draft.trim());
      setDraft(null);
    } else setError(formatEnvironmentQueryError(result.cause));
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await forget({ environmentId, input: { memoryId: memory.id } });
    setBusy(false);
    if (result._tag === "Success") onForgotten();
    else setError(formatEnvironmentQueryError(result.cause));
  };
  return (
    <article className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {[memory.date, memory.category].filter(Boolean).join(" · ") || "Almanac memory"}
      </p>
      {memory.replacedBy && <p role="note">A newer memory replaced this one.</p>}
      {draft === null ? (
        <p className="text-sm whitespace-pre-wrap">{text}</p>
      ) : (
        <Textarea
          aria-label="Memory text"
          value={draft}
          rows={6}
          maxLength={8192}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {shortened && <p role="note">Almanac shortened this text. Editing replaces all of it.</p>}
      <div className="flex flex-wrap gap-2">
        {draft === null ? (
          <Button variant="outline" disabled={!canUpdate || busy} onClick={() => setDraft(text)}>
            Edit
          </Button>
        ) : (
          <>
            <Button disabled={busy || !draft.trim()} onClick={() => void save()}>
              Save
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </>
        )}
        {confirming ? (
          <>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              Confirm forget
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Keep memory
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            disabled={!canForget || busy}
            onClick={() => setConfirming(true)}
          >
            Forget
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

export function MemoryLibrary({
  environmentId,
  notesEnabled,
  almanacEnabled,
}: {
  environmentId: EnvironmentId;
  notesEnabled: boolean;
  almanacEnabled: boolean;
}) {
  const [source, setSource] = useState<"notes" | "almanac">(notesEnabled ? "notes" : "almanac");
  const [input, setInput] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const query = useDebouncedValue(input.trim(), 300);
  const listProps = { environmentId, selection, onSelect: setSelection };
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
        <Input
          type="search"
          aria-label="Search memory"
          placeholder="Search notes and Almanac"
          value={input}
          maxLength={500}
          onChange={(event) => setInput(event.target.value)}
        />
        {!query && (
          <ToggleGroup
            aria-label="Memory source"
            variant="segmented"
            value={[source]}
            onValueChange={(next) => {
              if (next[0] === "notes" || next[0] === "almanac") setSource(next[0]);
            }}
          >
            <ToggleGroupItem value="notes">Notes</ToggleGroupItem>
            <ToggleGroupItem value="almanac">Almanac</ToggleGroupItem>
          </ToggleGroup>
        )}
        <div className="space-y-4">
          {query ? (
            <SearchResults
              {...listProps}
              query={query}
              notesEnabled={notesEnabled}
              almanacEnabled={almanacEnabled}
            />
          ) : source === "notes" ? (
            notesEnabled ? (
              <NotesList {...listProps} />
            ) : (
              <Message>Set a notes folder in the Settings tab.</Message>
            )
          ) : almanacEnabled ? (
            <AlmanacList {...listProps} />
          ) : (
            <Message>Set the Almanac command in the Settings tab.</Message>
          )}
        </div>
      </div>
      <div className="min-w-0 rounded-lg border p-4">
        {selection === null ? (
          <p className="text-sm text-muted-foreground">Select an item to read it.</p>
        ) : selection.kind === "note" ? (
          <NoteReader key={selection.path} environmentId={environmentId} path={selection.path} />
        ) : selection.kind === "source" ? (
          <SourceReader
            key={selection.sourceId}
            environmentId={environmentId}
            sourceId={selection.sourceId}
            title={selection.title}
          />
        ) : (
          <MemoryReader
            key={selection.memory.id}
            environmentId={environmentId}
            memory={selection.memory}
            onForgotten={() => setSelection(null)}
          />
        )}
      </div>
    </div>
  );
}
