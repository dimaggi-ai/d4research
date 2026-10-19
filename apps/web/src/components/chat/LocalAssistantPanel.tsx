import { randomUUID } from "../../lib/utils";
import { useEffect, useRef, useState } from "react";
import * as Option from "effect/Option";
import type { ScopedThreadRef } from "@d4research/contracts";
import {
  localAssistantTasks,
  runLocalAssistant,
  selectLocalExcerpts,
  type LocalAssistantTask,
} from "@d4research/client-runtime/local-assistant";
import { useEnvironmentThread } from "../../state/threads";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

export function LocalAssistantPanel(props: {
  draft: string;
  onChange: (value: string) => void;
  threadRef: ScopedThreadRef | null;
}) {
  const [selection, setSelection] = useState<"clean" | "shorten" | "tools" | null>(null);
  if (!window.desktopBridge?.localAssistantGenerate || !navigator.userAgent.includes("Mac"))
    return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {props.draft.trim() ? (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelection("clean")}>
              Fix typos
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelection("shorten")}>
              Shorten
            </Button>
          </>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={() => setSelection("tools")}>
          More text tools
        </Button>
      </div>
      {selection ? (
        <Assistant {...props} initialTask={selection} close={() => setSelection(null)} />
      ) : null}
    </>
  );
}
function Assistant(props: {
  draft: string;
  onChange: (value: string) => void;
  threadRef: ScopedThreadRef | null;
  initialTask: "clean" | "shorten" | "tools";
  close: () => void;
}) {
  const thread = useEnvironmentThread(
    props.threadRef?.environmentId ?? null,
    props.threadRef?.threadId ?? null,
  );
  const [showTools, setShowTools] = useState(props.initialTask === "tools");
  const started = useRef(false);
  const [source, setSource] = useState(props.draft);
  const [available, setAvailable] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<LocalAssistantTask | "context">("clean");
  const [query, setQuery] = useState("");
  const [baseline, setBaseline] = useState(props.draft);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    let mounted = true;
    void window.desktopBridge
      ?.localAssistantStatus?.()
      .then((status) => {
        if (mounted) {
          setAvailable(status.available);
          if (!status.available)
            setError(
              status.error ?? "Apple Intelligence is unavailable. Enable it on a supported Mac.",
            );
        }
      })
      .catch(() => {
        if (mounted) setError("The on-device assistant is unavailable.");
      });
    return () => {
      mounted = false;
      abort.current?.abort();
    };
  }, []);
  const close = () => {
    abort.current?.abort();
    props.close();
  };
  const run = async (next: LocalAssistantTask) => {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setResult("");
    setError("");
    setTask(next);
    setBaseline(props.draft);
    try {
      const output = await runLocalAssistant(
        next,
        source,
        async (instructions, input, signal) => {
          signal.throwIfAborted();
          const requestId = randomUUID();
          const cancel = () => {
            void window.desktopBridge?.localAssistantCancel?.(requestId).catch(() => {});
          };
          signal.addEventListener("abort", cancel, { once: true });
          let response;
          try {
            response = await window.desktopBridge!.localAssistantGenerate!({
              requestId,
              instructions,
              input,
            });
          } finally {
            signal.removeEventListener("abort", cancel);
          }
          signal.throwIfAborted();
          if (!response.text || response.error)
            throw new Error(response.error ?? "The local model returned no text.");
          return response.text;
        },
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(output);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Local generation failed.");
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };
  useEffect(() => {
    if (available && props.initialTask !== "tools" && !started.current) {
      started.current = true;
      void run(props.initialTask);
    }
  }, [available, props.initialTask, run]);
  const apply = () => {
    if (props.draft !== baseline) {
      setError("Your draft changed. Copy the result or run the action again.");
      return;
    }
    const after =
      task === "clean" || task === "shorten" || task === "context"
        ? result
        : [props.draft, result].filter(Boolean).join("\n\n");
    setUndo({ before: props.draft, after });
    props.onChange(after);
    setBaseline(after);
    setResult("");
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogPopup>
        <DialogTitle>
          {showTools
            ? "Text tools"
            : localAssistantTasks[props.initialTask === "shorten" ? "shorten" : "clean"]}
        </DialogTitle>
        <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto py-3">
          <p className="text-sm text-muted-foreground">
            Uses Apple Intelligence on this Mac. Review changes before applying.
          </p>
          {showTools ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setSource(props.draft);
                    setResult("");
                  }}
                >
                  Use draft
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || Option.isNone(thread.data)}
                  onClick={() => {
                    setSource(
                      Option.isSome(thread.data)
                        ? thread.data.value.messages
                            .map((message) => `${message.role}: ${message.text}`)
                            .join("\n\n")
                        : "",
                    );
                    setResult("");
                  }}
                >
                  Use loaded chat
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Only loaded messages are included. You can also paste a document or log excerpt.
              </p>
              <label className="text-sm text-muted-foreground">
                Open a text file (up to 48 KB)
                <input
                  type="file"
                  accept="text/*,.md,.log,.json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 48_000) {
                      setError("Choose a text file up to 48 KB.");
                      return;
                    }
                    void file
                      .text()
                      .then((text) => {
                        setSource(text);
                        setResult("");
                        setError("");
                      })
                      .catch(() => setError("Could not read the text file."));
                    event.target.value = "";
                  }}
                />
              </label>
              <Textarea
                aria-label="Source text"
                rows={8}
                disabled={busy}
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setResult("");
                }}
              />
              <div className="flex flex-wrap gap-2">
                {Object.entries(localAssistantTasks).map(([key, label]) => (
                  <Button
                    key={key}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !available || !source.trim()}
                    onClick={() => void run(key as LocalAssistantTask)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <Textarea
                aria-label="Find relevant context"
                rows={2}
                placeholder="What context do you need?"
                value={query}
                disabled={busy}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || !query.trim()}
                onClick={() => {
                  setTask("context");
                  setBaseline(props.draft);
                  setError("");
                  const excerpts = selectLocalExcerpts(query, [
                    { label: "Selected source", text: source },
                  ]);
                  setResult(excerpts.map((item) => `[${item.label}]\n${item.text}`).join("\n\n"));
                  if (!excerpts.length)
                    setError(
                      "No matching excerpts fit. Try a more specific query or a smaller source.",
                    );
                }}
              >
                Find excerpts locally
              </Button>
            </>
          ) : null}
          {busy ? <p role="status">Working on this device…</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {result ? (
            <>
              <p className="text-xs text-muted-foreground">
                Preview · {source.length} → {result.length} characters. Character counts are not
                billed tokens.
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-lg border p-3 text-sm">
                {result}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={apply}>
                  {task === "clean" || task === "shorten" || task === "context"
                    ? "Replace draft"
                    : "Add to draft"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(result)
                      .catch(() => setError("Could not copy. Select and copy the preview text."))
                  }
                >
                  Copy
                </Button>
                <Button type="button" variant="ghost" onClick={() => setResult("")}>
                  Discard
                </Button>
              </div>
            </>
          ) : null}
          {!showTools ? (
            <Button type="button" variant="ghost" onClick={() => setShowTools(true)}>
              More text tools
            </Button>
          ) : null}
          {undo ? (
            <Button
              type="button"
              variant="outline"
              disabled={props.draft !== undo.after}
              onClick={() => {
                props.onChange(undo.before);
                setBaseline(undo.before);
                setUndo(null);
              }}
            >
              Undo draft change
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={close}>
            Close
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
