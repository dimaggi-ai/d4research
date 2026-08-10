import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PaperclipIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ResearchScenario } from "@t3tools/contracts";
import {
  DEV_SCENARIO_MAX_COUNT,
  RESEARCH_PIPELINE_PROMPT_MAX_CHARS,
  RESEARCH_PROMPT_FILE_MAX_COUNT,
  RESEARCH_SCENARIO_NAME_REGEX,
} from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { listDevScenarios } from "../../devPipeline";
import { ACCEPTED_PROMPT_FILE_SUFFIXES, mergePromptFiles } from "../../lib/promptFiles";
import {
  deriveDirectiveSuggestions,
  deriveResearchProviderCandidates,
  resolveResearchDirectives,
  type DirectiveSuggestion,
} from "../../researchPipeline";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const ADD_PIPELINE_VALUE = "__add_pipeline__";

export function replaceNamedPipelinePromptFiles(
  pipelines: ReadonlyArray<ResearchScenario>,
  targetName: string,
  promptFiles: ResearchScenario["promptFiles"],
): Array<ResearchScenario> | null {
  if (!pipelines.some((candidate) => candidate.name === targetName)) return null;
  return pipelines.map((candidate) =>
    candidate.name === targetName ? { ...candidate, promptFiles } : candidate,
  );
}

export function DevPipelinesSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const candidates = useMemo(
    () =>
      deriveResearchProviderCandidates(
        sortProviderInstanceEntries(
          applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
        ),
      ),
    [serverProviders, settings],
  );
  const persistedPipelines = useMemo(
    () => listDevScenarios(settings.dev, candidates),
    [candidates, settings.dev],
  );
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [pipelines, setPipelines] = useState(persistedPipelines);
  const pipelinesRef = useRef<ReadonlyArray<ResearchScenario>>(persistedPipelines);
  const [selectedPipelineName, setSelectedPipelineName] = useState(
    settings.dev.activeScenario || persistedPipelines[0]?.name || "default",
  );
  const selectedPipelineNameRef = useRef(selectedPipelineName);
  useEffect(() => {
    // Do not replace a focused, unsaved prompt because an unrelated settings
    // patch arrived. The local canonical array is flushed on blur/switch.
    if (document.activeElement === promptRef.current) return;
    pipelinesRef.current = persistedPipelines;
    setPipelines(persistedPipelines);
    const nextActive = settings.dev.activeScenario || persistedPipelines[0]?.name || "default";
    selectedPipelineNameRef.current = nextActive;
    setSelectedPipelineName(nextActive);
  }, [persistedPipelines, settings.dev.activeScenario]);
  const pipeline =
    pipelines.find((candidate) => candidate.name === selectedPipelineName) ??
    (pipelines[0] as ResearchScenario);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveRevisionRef = useRef(0);
  const attachFilesQueueRef = useRef<Promise<void>>(Promise.resolve());
  const setLocalPipelines = (next: ReadonlyArray<ResearchScenario>, active: string) => {
    pipelinesRef.current = next;
    setPipelines(next);
    selectedPipelineNameRef.current = active;
    setSelectedPipelineName(active);
  };
  const savePipelines = async (
    next: ReadonlyArray<ResearchScenario>,
    active: string,
  ): Promise<boolean> => {
    const previous = pipelinesRef.current;
    const previousActive = selectedPipelineNameRef.current;
    const revision = saveRevisionRef.current + 1;
    saveRevisionRef.current = revision;
    setLocalPipelines(next, active);
    setSaving(true);
    setSaveError(null);
    try {
      await updateSettings({ dev: { scenarios: next, activeScenario: active } });
      return true;
    } catch (error) {
      if (saveRevisionRef.current === revision) {
        setLocalPipelines(previous, previousActive);
        setSaveError(error instanceof Error ? error.message : "Could not save dev pipelines.");
      }
      return false;
    } finally {
      if (saveRevisionRef.current === revision) setSaving(false);
    }
  };
  const updatePipeline = (partial: Partial<ResearchScenario>) =>
    savePipelines(
      pipelinesRef.current.map((candidate) =>
        candidate.name === pipeline.name ? { ...candidate, ...partial } : candidate,
      ),
      pipeline.name,
    );
  const attachFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const targetName = pipeline.name;
    const selectedFiles = Array.from(files);
    const pending = attachFilesQueueRef.current.then(async () => {
      const target = pipelinesRef.current.find((candidate) => candidate.name === targetName);
      if (!target) return;
      const result = await mergePromptFiles(target.promptFiles, selectedFiles);
      const next = replaceNamedPipelinePromptFiles(
        pipelinesRef.current,
        targetName,
        result.promptFiles,
      );
      if (!next) return;
      setFileError(result.errors.length > 0 ? result.errors.join(" ") : null);
      await savePipelines(next, selectedPipelineNameRef.current);
    });
    attachFilesQueueRef.current = pending.catch(() => undefined);
    await pending;
  };

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState(pipeline.pipelinePrompt);
  const promptPipelineNameRef = useRef(pipeline.name);
  const [promptCaret, setPromptCaret] = useState(pipeline.pipelinePrompt.length);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);

  useEffect(() => {
    const pipelineChanged = promptPipelineNameRef.current !== pipeline.name;
    promptPipelineNameRef.current = pipeline.name;
    setPromptDraft((current) =>
      !pipelineChanged && document.activeElement === promptRef.current
        ? current
        : pipeline.pipelinePrompt,
    );
  }, [pipeline.name, pipeline.pipelinePrompt]);

  const resolutions = resolveResearchDirectives(promptDraft, candidates, pipeline.promptFiles);
  const suggestions = suggestionsDismissed
    ? []
    : deriveDirectiveSuggestions(
        promptDraft.slice(0, promptCaret),
        candidates,
        pipeline.promptFiles,
      );

  const setCurrentPipelinePromptLocal = (nextPrompt: string) => {
    setPromptDraft(nextPrompt);
    const nextPipelines = pipelinesRef.current.map((candidate) =>
      candidate.name === pipeline.name ? { ...candidate, pipelinePrompt: nextPrompt } : candidate,
    );
    pipelinesRef.current = nextPipelines;
    setPipelines(nextPipelines);
  };

  const acceptSuggestion = (suggestion: DirectiveSuggestion) => {
    const next =
      promptDraft.slice(0, suggestion.tokenStart) +
      suggestion.insert +
      promptDraft.slice(promptCaret);
    const caretAfter = suggestion.tokenStart + suggestion.insert.length;
    setCurrentPipelinePromptLocal(next.slice(0, RESEARCH_PIPELINE_PROMPT_MAX_CHARS));
    setPromptCaret(caretAfter);
    setSuggestionIndex(0);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(caretAfter, caretAfter);
    });
  };

  const createPipeline = async () => {
    const name = newName.trim().toLowerCase();
    if (!RESEARCH_SCENARIO_NAME_REGEX.test(name)) {
      setNameError("Lowercase letters, digits, and dashes only (max 40).");
      return;
    }
    if (pipelines.some((candidate) => candidate.name === name)) {
      setNameError(`Pipeline "${name}" already exists.`);
      return;
    }
    if (pipelines.length >= DEV_SCENARIO_MAX_COUNT) {
      setNameError(`At most ${DEV_SCENARIO_MAX_COUNT} pipelines.`);
      return;
    }
    const saved = await savePipelines(
      [...pipelinesRef.current, { name, pipelinePrompt: "", promptFiles: [] }],
      name,
    );
    if (!saved) return;
    setAddOpen(false);
    setNewName("");
    setNameError(null);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("dev-pipelines")}>
        <SettingsRow
          {...searchableSetting("dev-pipeline-scenario")}
          description="Choose the plan, build, review, and fallback sequence shown in the composer's Build menu. Run one with !dev:<name>."
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Select
                value={pipeline.name}
                onValueChange={(value) => {
                  if (value === ADD_PIPELINE_VALUE) {
                    setNewName("");
                    setNameError(null);
                    setAddOpen(true);
                  } else {
                    void savePipelines(pipelinesRef.current, String(value));
                  }
                }}
              >
                <SelectTrigger className="w-40" aria-label="Dev pipeline">
                  <SelectValue>{pipeline.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {pipelines.map((candidate) => (
                    <SelectItem key={candidate.name} hideIndicator value={candidate.name}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                  <SelectItem hideIndicator value={ADD_PIPELINE_VALUE}>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <PlusIcon className="size-3.5" /> Add pipeline…
                    </span>
                  </SelectItem>
                </SelectPopup>
              </Select>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete pipeline ${pipeline.name}`}
                disabled={pipelines.length <= 1 || saving}
                onClick={() => {
                  const remaining = pipelines.filter(
                    (candidate) => candidate.name !== pipeline.name,
                  );
                  void savePipelines(remaining, remaining[0]?.name ?? "");
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("dev-pipeline-prompt-files")}
          description="Markdown or text context a dev directive can reference by filename. It is sent only to that delegate."
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={pipeline.promptFiles.length >= RESEARCH_PROMPT_FILE_MAX_COUNT}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon className="size-3.5" /> Attach
            </Button>
          }
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_PROMPT_FILE_SUFFIXES.join(",")}
            multiple
            hidden
            onChange={(event) => {
              void attachFiles(event.target.files);
              event.target.value = "";
            }}
          />
          {fileError ? <p className="mt-2 text-xs text-destructive">{fileError}</p> : null}
          {pipeline.promptFiles.length > 0 ? (
            <ul className="mt-3 max-w-2xl space-y-1">
              {pipeline.promptFiles.map((file) => (
                <li key={file.name} className="flex items-center gap-2 rounded-md border px-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      void updatePipeline({
                        promptFiles: pipeline.promptFiles.filter(
                          (candidate) => candidate.name !== file.name,
                        ),
                      })
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">No prompt files attached.</p>
          )}
        </SettingsRow>

        <SettingsRow
          {...searchableSetting("dev-pipeline-prompt")}
          description="The exact orchestration steps. Type ! for live provider/model suggestions; unresolved targets are shown below before you run it."
        >
          <div className="mt-3 max-w-4xl pb-1">
            <Textarea
              ref={promptRef}
              value={promptDraft}
              onChange={(event) => {
                const nextPrompt = event.target.value.slice(0, RESEARCH_PIPELINE_PROMPT_MAX_CHARS);
                setCurrentPipelinePromptLocal(nextPrompt);
                setPromptCaret(event.target.selectionStart ?? event.target.value.length);
                setSuggestionsDismissed(false);
                setSuggestionIndex(0);
              }}
              onSelect={(event) =>
                setPromptCaret(
                  (event.target as HTMLTextAreaElement).selectionStart ?? promptDraft.length,
                )
              }
              onKeyDown={(event) => {
                if (suggestions.length === 0) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSuggestionIndex((index) => (index + 1) % suggestions.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSuggestionIndex(
                    (index) => (index - 1 + suggestions.length) % suggestions.length,
                  );
                } else if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  acceptSuggestion(suggestions[suggestionIndex] ?? suggestions[0]!);
                } else if (event.key === "Escape") {
                  setSuggestionsDismissed(true);
                }
              }}
              onBlur={() => {
                void savePipelines(pipelinesRef.current, selectedPipelineNameRef.current);
              }}
              rows={24}
              className="min-h-64 resize-y font-mono text-xs"
              aria-label="Dev pipeline prompt"
            />
            {suggestions.length > 0 ? (
              <ul
                className="mt-1 overflow-hidden rounded-md border border-border/60 bg-popover shadow-sm"
                role="listbox"
                aria-label="Dev directive suggestions"
              >
                {suggestions.map((suggestion, index) => (
                  <li
                    key={suggestion.insert}
                    role="option"
                    aria-selected={index === suggestionIndex}
                  >
                    <button
                      type="button"
                      className={`flex w-full items-baseline gap-2 px-2 py-1 text-left font-mono text-xs ${index === suggestionIndex ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        acceptSuggestion(suggestion);
                      }}
                    >
                      <span className="shrink-0 text-foreground">{suggestion.insert}</span>
                      <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {resolutions.length > 0 ? (
              <ul className="mt-2 space-y-1" data-dev-directives="true">
                {resolutions.map((resolution) => (
                  <li
                    key={resolution.directive.raw}
                    className={`truncate text-xs ${resolution.ok ? "text-muted-foreground" : "text-destructive"}`}
                  >
                    {resolution.ok
                      ? `${resolution.directive.raw} → ${resolution.providerName} / ${resolution.model}`
                      : `${resolution.directive.raw} — ${resolution.error}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {saveError ? <p className="mt-2 text-xs text-destructive">{saveError}</p> : null}
        </SettingsRow>
      </SettingsSection>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) {
            setNewName("");
            setNameError(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New dev pipeline</DialogTitle>
            <DialogDescription>
              Lowercase letters, digits, and dashes. Run it as !dev:name.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createPipeline();
            }}
            placeholder="fix-and-review"
            className="font-mono text-sm"
            aria-label="New dev pipeline name"
          />
          {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createPipeline()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageContainer>
  );
}
