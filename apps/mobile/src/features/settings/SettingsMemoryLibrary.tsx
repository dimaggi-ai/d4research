import { useAtomValue } from "@effect/atom-react";
import type { AlmanacMemory, EnvironmentId } from "@d4research/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { almanac } from "../../state/almanac";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import {
  secondBrainCatalogQuery,
  secondBrainNoteQuery,
  secondBrainSearchQuery,
} from "../../state/second-brain";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

type Selection =
  | { readonly kind: "note"; readonly path: string }
  | { readonly kind: "source"; readonly sourceId: string; readonly title: string }
  | { readonly kind: "memory"; readonly memory: AlmanacMemory };

type ListProps = {
  readonly environmentId: EnvironmentId;
  readonly onSelect: (selection: Selection) => void;
};

const READ_WINDOW = 8000;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

function preview(text: string) {
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function NotesList({ environmentId, onSelect }: ListProps) {
  const catalog = useEnvironmentQuery(secondBrainCatalogQuery(environmentId));
  return (
    <SettingsSection title="Notes">
      {catalog.data ? null : <Text>{catalog.error ?? "Loading notes…"}</Text>}
      {catalog.data?.length === 0 ? <Text>This folder has no notes.</Text> : null}
      {catalog.data?.map((note) => (
        <SettingsActionRow
          key={note.path}
          label={note.title}
          description={note.path}
          onPress={() => onSelect({ kind: "note", path: note.path })}
        />
      ))}
    </SettingsSection>
  );
}

function AlmanacList({ environmentId, onSelect }: ListProps) {
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState(0);
  const browse = useEnvironmentQuery(almanac.almanacBrowseQuery({ environmentId, path, offset }));
  const data = browse.data;
  const open = (next: string) => {
    setPath(next);
    setOffset(0);
  };
  const empty = data && !data.categories.length && !data.memories.length && !data.passages.length;
  return (
    <SettingsSection title="Almanac">
      {path ? (
        <SettingsActionRow
          label={`Back from ${path}`}
          onPress={() => open(path.slice(0, Math.max(0, path.lastIndexOf("/"))))}
        />
      ) : null}
      {data ? null : <Text>{browse.error ?? "Loading Almanac…"}</Text>}
      {empty ? <Text>Nothing is stored here yet.</Text> : null}
      {data?.categories.map((category) => (
        <SettingsActionRow
          key={category.path}
          label={category.path}
          description={`${category.items} items`}
          onPress={() => open(category.path)}
        />
      ))}
      {data?.memories.map((memory) => (
        <SettingsActionRow
          key={memory.id}
          label={preview(memory.text)}
          description={memory.date ?? undefined}
          onPress={() => onSelect({ kind: "memory", memory })}
        />
      ))}
      {data?.passages.map((passage) => (
        <SettingsActionRow
          key={`${passage.sourceId}@${passage.start}`}
          label={passage.title}
          description={preview(passage.text)}
          onPress={() =>
            onSelect({ kind: "source", sourceId: passage.sourceId, title: passage.title })
          }
        />
      ))}
      {offset > 0 ? <SettingsActionRow label="First page" onPress={() => setOffset(0)} /> : null}
      {data?.nextOffset != null ? (
        <SettingsActionRow label="Next page" onPress={() => setOffset(data.nextOffset ?? offset)} />
      ) : null}
    </SettingsSection>
  );
}

function SearchResults({
  environmentId,
  onSelect,
  query,
  notesEnabled,
  almanacEnabled,
}: ListProps & { query: string; notesEnabled: boolean; almanacEnabled: boolean }) {
  return (
    <>
      {notesEnabled ? (
        <NoteResults environmentId={environmentId} onSelect={onSelect} query={query} />
      ) : null}
      {almanacEnabled ? (
        <AlmanacResults environmentId={environmentId} onSelect={onSelect} query={query} />
      ) : null}
    </>
  );
}

function NoteResults({ environmentId, onSelect, query }: ListProps & { query: string }) {
  const results = useEnvironmentQuery(secondBrainSearchQuery({ environmentId, query, limit: 20 }));
  const seen = new Set<string>();
  const unique = (results.data?.results ?? []).filter(({ citation }) => {
    if (seen.has(citation.path)) return false;
    seen.add(citation.path);
    return true;
  });
  return (
    <SettingsSection title="Notes">
      {results.data ? null : <Text>{results.error ?? "Searching notes…"}</Text>}
      {results.data && unique.length === 0 ? <Text>No matching notes.</Text> : null}
      {unique.map(({ citation }) => (
        <SettingsActionRow
          key={citation.path}
          label={citation.path}
          description={preview(citation.excerpt)}
          onPress={() => onSelect({ kind: "note", path: citation.path })}
        />
      ))}
    </SettingsSection>
  );
}

function AlmanacResults({ environmentId, onSelect, query }: ListProps & { query: string }) {
  const passages = useEnvironmentQuery(
    almanac.almanacSearchQuery({ environmentId, query, limit: 20 }),
  );
  const memories = useEnvironmentQuery(
    almanac.almanacRecallQuery({ environmentId, query, limit: 20 }),
  );
  const none = passages.data?.passages.length === 0 && memories.data?.memories.length === 0;
  return (
    <SettingsSection title="Almanac">
      {passages.data ? null : <Text>{passages.error ?? "Searching Almanac…"}</Text>}
      {memories.error ? <Text>{memories.error}</Text> : null}
      {none ? <Text>No matches in Almanac.</Text> : null}
      {passages.data?.indexingIncomplete ? (
        <Text>Almanac is still indexing, so results may be missing.</Text>
      ) : null}
      {memories.data?.memories.map((memory) => (
        <SettingsActionRow
          key={memory.id}
          label={preview(memory.text)}
          description={memory.date ?? undefined}
          onPress={() => onSelect({ kind: "memory", memory })}
        />
      ))}
      {passages.data?.passages.map((passage) => (
        <SettingsActionRow
          key={`${passage.sourceId}@${passage.start}`}
          label={passage.title}
          description={preview(passage.text)}
          onPress={() =>
            onSelect({ kind: "source", sourceId: passage.sourceId, title: passage.title })
          }
        />
      ))}
    </SettingsSection>
  );
}

function NoteReader({ environmentId, path }: { environmentId: EnvironmentId; path: string }) {
  const note = useEnvironmentQuery(secondBrainNoteQuery({ environmentId, path }));
  return (
    <SettingsSection title={path}>
      <View className="gap-2 p-4">
        {note.data ? (
          <Text selectable>{note.data.content.replace(FRONTMATTER, "")}</Text>
        ) : (
          <Text>{note.error ?? "Loading note…"}</Text>
        )}
        {note.data?.truncated ? <Text>This note is too long to show in full.</Text> : null}
      </View>
    </SettingsSection>
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
    <SettingsSection title={title}>
      <View className="gap-2 p-4">
        {data ? (
          <>
            <Text>
              Characters {data.start}–{data.end} of {data.total}
            </Text>
            <Text selectable>{data.content}</Text>
          </>
        ) : (
          <Text>{source.error ?? "Loading document…"}</Text>
        )}
      </View>
      {data && data.start > 0 ? (
        <SettingsActionRow
          label="Previous"
          onPress={() => setStart(Math.max(0, data.start - READ_WINDOW))}
        />
      ) : null}
      {data && data.end < data.total ? (
        <SettingsActionRow label="Next" onPress={() => setStart(data.end)} />
      ) : null}
    </SettingsSection>
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
  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    const next = draft.trim();
    const result = await update({ environmentId, input: { memoryId: memory.id, text: next } });
    setBusy(false);
    if (result._tag === "Success") {
      setText(next);
      setDraft(null);
    } else setError("Could not save this memory.");
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await forget({ environmentId, input: { memoryId: memory.id } });
    setBusy(false);
    if (result._tag === "Success") onForgotten();
    else setError("Could not forget this memory.");
  };
  return (
    <SettingsSection title={memory.date ?? "Almanac memory"}>
      <View className="gap-2 p-4">
        {memory.category ? <Text>{memory.category}</Text> : null}
        {memory.replacedBy ? <Text>A newer memory replaced this one.</Text> : null}
        {draft === null ? (
          <Text selectable>{text}</Text>
        ) : (
          <AppTextInput
            accessibilityLabel="Memory text"
            multiline
            value={draft}
            maxLength={8192}
            onChangeText={setDraft}
          />
        )}
        {text.endsWith("…") ? (
          <Text>Almanac shortened this text. Editing replaces all of it.</Text>
        ) : null}
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      </View>
      {draft === null ? (
        <SettingsActionRow
          label="Edit"
          disabled={!canUpdate || busy}
          onPress={() => setDraft(text)}
        />
      ) : (
        <>
          <SettingsActionRow
            label="Save"
            disabled={busy || !draft.trim()}
            onPress={() => void save()}
          />
          <SettingsActionRow label="Cancel" disabled={busy} onPress={() => setDraft(null)} />
        </>
      )}
      {confirming ? (
        <>
          <SettingsActionRow
            label="Confirm forget"
            tone="danger"
            disabled={busy}
            onPress={() => void remove()}
          />
          <SettingsActionRow
            label="Keep memory"
            disabled={busy}
            onPress={() => setConfirming(false)}
          />
        </>
      ) : (
        <SettingsActionRow
          label="Forget"
          disabled={!canForget || busy}
          onPress={() => setConfirming(true)}
        />
      )}
    </SettingsSection>
  );
}

export function SettingsMemoryLibrary({
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
  const query = useDebouncedValue(input.trim(), 300);
  const [selection, setSelection] = useState<Selection | null>(null);
  if (selection) {
    return (
      <View className="gap-6">
        <SettingsActionRow label="Back to library" onPress={() => setSelection(null)} />
        {selection.kind === "note" ? (
          <NoteReader environmentId={environmentId} path={selection.path} />
        ) : selection.kind === "source" ? (
          <SourceReader
            environmentId={environmentId}
            sourceId={selection.sourceId}
            title={selection.title}
          />
        ) : (
          <MemoryReader
            environmentId={environmentId}
            memory={selection.memory}
            onForgotten={() => setSelection(null)}
          />
        )}
      </View>
    );
  }
  return (
    <View className="gap-6">
      <AppTextInput
        accessibilityLabel="Search memory"
        placeholder="Search notes and Almanac"
        value={input}
        maxLength={500}
        onChangeText={setInput}
      />
      {query ? (
        <SearchResults
          environmentId={environmentId}
          onSelect={setSelection}
          query={query}
          notesEnabled={notesEnabled}
          almanacEnabled={almanacEnabled}
        />
      ) : (
        <>
          <SettingsSection title="Browse">
            <SettingsChoiceRow
              label="Notes"
              selected={source === "notes"}
              onPress={() => setSource("notes")}
            />
            <SettingsChoiceRow
              label="Almanac"
              selected={source === "almanac"}
              onPress={() => setSource("almanac")}
            />
          </SettingsSection>
          {source === "notes" ? (
            notesEnabled ? (
              <NotesList environmentId={environmentId} onSelect={setSelection} />
            ) : (
              <Text>Set a notes folder in the Settings view.</Text>
            )
          ) : almanacEnabled ? (
            <AlmanacList environmentId={environmentId} onSelect={setSelection} />
          ) : (
            <Text>Set the Almanac command in the Settings view.</Text>
          )}
        </>
      )}
    </View>
  );
}
