import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { EyeIcon, PaperclipIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ResearchPromptFile, ResearchScenario } from "@t3tools/contracts";
import {
  RESEARCH_PIPELINE_PROMPT_MAX_CHARS,
  RESEARCH_PROMPT_FILE_MAX_COUNT,
  RESEARCH_SCENARIO_MAX_COUNT,
  RESEARCH_SCENARIO_NAME_REGEX,
} from "@t3tools/contracts";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import {
  deriveDirectiveSuggestions,
  deriveResearchProviderCandidates,
  listResearchScenarios,
  resolveResearchDirectives,
  type DirectiveSuggestion,
} from "../../researchPipeline";
import { ACCEPTED_PROMPT_FILE_SUFFIXES, mergePromptFiles } from "../../lib/promptFiles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsPageContainer } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Reserved dropdown value for the "Add scenario…" action; scenario names are
// validated against RESEARCH_SCENARIO_NAME_REGEX so this can never collide.
const ADD_SCENARIO_VALUE = "__add_scenario__";

export function ResearchSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [viewedFile, setViewedFile] = useState<ResearchPromptFile | null>(null);

  const research = settings.research;
  const scenarios = listResearchScenarios(research);
  const scenario =
    scenarios.find((candidate) => candidate.name === research.activeScenario) ??
    (scenarios[0] as ResearchScenario);
  const promptFiles = scenario.promptFiles;
  const [newScenarioName, setNewScenarioName] = useState("");
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [addScenarioOpen, setAddScenarioOpen] = useState(false);

  // Every write persists the full scenario list (whole-array replacement in
  // the settings patch), which also migrates the legacy single pipeline into
  // its `default` scenario on first touch.
  const saveScenarios = (next: ReadonlyArray<ResearchScenario>, active: string) =>
    updateSettings({ research: { scenarios: next, activeScenario: active } });
  const updateScenario = (partial: Partial<ResearchScenario>) =>
    saveScenarios(
      scenarios.map((candidate) =>
        candidate.name === scenario.name ? { ...candidate, ...partial } : candidate,
      ),
      scenario.name,
    );

  const pipelineRef = useRef<HTMLTextAreaElement>(null);
  const [pipelineDraft, setPipelineDraft] = useState(scenario.pipelinePrompt);
  const [pipelineCaret, setPipelineCaret] = useState(scenario.pipelinePrompt.length);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  // Scenario switches and remote saves both replace the draft — unless this
  // editor is the one holding unsaved changes.
  useEffect(() => {
    setPipelineDraft((current) =>
      document.activeElement === pipelineRef.current ? current : scenario.pipelinePrompt,
    );
  }, [scenario.name, scenario.pipelinePrompt]);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const candidates = deriveResearchProviderCandidates(instanceEntries);
  const resolutions = resolveResearchDirectives(pipelineDraft, candidates, promptFiles);
  const suggestions = suggestionsDismissed
    ? []
    : deriveDirectiveSuggestions(pipelineDraft.slice(0, pipelineCaret), candidates, promptFiles);

  const acceptSuggestion = (suggestion: DirectiveSuggestion) => {
    const next =
      pipelineDraft.slice(0, suggestion.tokenStart) +
      suggestion.insert +
      pipelineDraft.slice(pipelineCaret);
    const caretAfter = suggestion.tokenStart + suggestion.insert.length;
    setPipelineDraft(next.slice(0, RESEARCH_PIPELINE_PROMPT_MAX_CHARS));
    setPipelineCaret(caretAfter);
    setSuggestionIndex(0);
    // Restore focus and caret after React applies the new value.
    requestAnimationFrame(() => {
      const element = pipelineRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caretAfter, caretAfter);
    });
  };

  const attachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const result = await mergePromptFiles(promptFiles, Array.from(files));
    setFileError(result.errors.length > 0 ? result.errors.join(" ") : null);
    updateScenario({ promptFiles: result.promptFiles });
  };

  const openAddScenario = () => {
    setNewScenarioName("");
    setScenarioError(null);
    setAddScenarioOpen(true);
  };

  const addScenario = () => {
    const name = newScenarioName.trim().toLowerCase();
    if (!RESEARCH_SCENARIO_NAME_REGEX.test(name)) {
      setScenarioError("Lowercase letters, digits, and dashes only (max 40).");
      return;
    }
    if (scenarios.some((candidate) => candidate.name === name)) {
      setScenarioError(`Scenario "${name}" already exists.`);
      return;
    }
    if (scenarios.length >= RESEARCH_SCENARIO_MAX_COUNT) {
      setScenarioError(`At most ${RESEARCH_SCENARIO_MAX_COUNT} scenarios.`);
      return;
    }
    setAddScenarioOpen(false);
    setNewScenarioName("");
    setScenarioError(null);
    saveScenarios([...scenarios, { name, pipelinePrompt: "", promptFiles: [] }], name);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("research-pipeline")}>
        <SettingsRow
          {...searchableSetting("research-scenario")}
          description="Each scenario is a full pipeline: its own prompt and files, run on the thread's current model. Run one with !research:<name>."
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Select
                value={scenario.name}
                onValueChange={(value) => {
                  if (value === ADD_SCENARIO_VALUE) openAddScenario();
                  else saveScenarios(scenarios, String(value));
                }}
              >
                <SelectTrigger className="w-40" aria-label="Research scenario">
                  <SelectValue>{scenario.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {scenarios.map((candidate) => (
                    <SelectItem key={candidate.name} hideIndicator value={candidate.name}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                  <SelectItem hideIndicator value={ADD_SCENARIO_VALUE}>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <PlusIcon className="size-3.5" /> Add scenario…
                    </span>
                  </SelectItem>
                </SelectPopup>
              </Select>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete scenario ${scenario.name}`}
                disabled={scenarios.length <= 1}
                onClick={() => {
                  const remaining = scenarios.filter(
                    (candidate) => candidate.name !== scenario.name,
                  );
                  saveScenarios(remaining, remaining[0]?.name ?? "");
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          }
        />

        <Dialog
          open={addScenarioOpen}
          onOpenChange={(open) => {
            setAddScenarioOpen(open);
            if (!open) {
              setNewScenarioName("");
              setScenarioError(null);
            }
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>New research scenario</DialogTitle>
              <DialogDescription>
                Lowercase letters, digits, and dashes. Run it as !research:name.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={newScenarioName}
              onChange={(event) => setNewScenarioName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addScenario();
              }}
              placeholder="blog"
              className="font-mono text-sm"
              aria-label="New scenario name"
            />
            {scenarioError ? <p className="text-xs text-destructive">{scenarioError}</p> : null}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAddScenarioOpen(false)}>
                Cancel
              </Button>
              <Button onClick={addScenario}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <SettingsRow
          {...searchableSetting("research-prompt-files")}
          description="Markdown attachments a directive can reference by name. Contents are sent to the delegate, not pasted into the orchestrator."
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={promptFiles.length >= RESEARCH_PROMPT_FILE_MAX_COUNT}
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
          {promptFiles.length > 0 ? (
            <ul className="mt-3 max-w-2xl space-y-1 pb-1">
              {promptFiles.map((file) => (
                <li
                  key={file.name}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {Math.max(1, Math.round(file.content.length / 1000))}k chars
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`View ${file.name}`}
                    onClick={() => setViewedFile(file)}
                  >
                    <EyeIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      updateScenario({
                        promptFiles: promptFiles.filter(
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
          {...searchableSetting("research-pipeline-prompt")}
          description="The steps the orchestrator must follow, verbatim. Type ! for model suggestions — loops are allowed and budget-guarded."
        >
          <div className="mt-3 max-w-4xl pb-1">
            <Textarea
              ref={pipelineRef}
              value={pipelineDraft}
              onChange={(event) => {
                setPipelineDraft(event.target.value.slice(0, RESEARCH_PIPELINE_PROMPT_MAX_CHARS));
                setPipelineCaret(event.target.selectionStart ?? event.target.value.length);
                setSuggestionsDismissed(false);
                setSuggestionIndex(0);
              }}
              onSelect={(event) =>
                setPipelineCaret(
                  (event.target as HTMLTextAreaElement).selectionStart ?? pipelineDraft.length,
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
                if (pipelineDraft !== scenario.pipelinePrompt) {
                  updateScenario({ pipelinePrompt: pipelineDraft });
                }
              }}
              rows={24}
              className="min-h-64 resize-y font-mono text-xs"
              placeholder={
                "Step 1: Scope the question.\nStep 2: Fan out to !claude:fable:depth.md and !codex:terra.\nStep 3: Summarize all answers.\nStep 4: Argue with the summary; if it does not hold, ask one model to regenerate and go back to step 3.\nStep 5: Validate and deliver."
              }
              aria-label="Research pipeline prompt"
            />
            {suggestions.length > 0 ? (
              <ul
                className="mt-1 overflow-hidden rounded-md border border-border/60 bg-popover shadow-sm"
                role="listbox"
                aria-label="Directive suggestions"
                data-research-directive-suggestions="true"
              >
                {suggestions.map((suggestion, index) => (
                  <li
                    key={suggestion.insert}
                    role="option"
                    aria-selected={index === suggestionIndex}
                  >
                    <button
                      type="button"
                      className={`flex w-full items-baseline gap-2 px-2 py-1 text-left font-mono text-xs ${
                        index === suggestionIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      // onMouseDown so the click wins over the textarea blur.
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
              <ul className="mt-2 space-y-1" data-research-directives="true">
                {resolutions.map((resolution) => (
                  <li
                    key={resolution.directive.raw}
                    className={`truncate text-xs ${resolution.ok ? "text-muted-foreground" : "text-destructive"}`}
                  >
                    {resolution.ok
                      ? `${resolution.directive.raw} → ${resolution.providerName} / ${resolution.model}${
                          resolution.directive.promptFile !== undefined
                            ? ` + ${resolution.directive.promptFile}`
                            : ""
                        }`
                      : `${resolution.directive.raw} — ${resolution.error}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          {...searchableSetting("research-context")}
          description="Shared context is always used: handoffs and delegates read local memory. These control how much survives."
          control={
            <div className="flex flex-col items-end gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Bypass compression — hand transcripts over as-is
                <Switch
                  checked={research.bypassCompression}
                  onCheckedChange={(checked) =>
                    updateSettings({ research: { bypassCompression: Boolean(checked) } })
                  }
                  aria-label="Bypass context compression for research handoffs"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Inject shared memory into every delegate
                <Switch
                  checked={research.shareMemoContext}
                  onCheckedChange={(checked) =>
                    updateSettings({ research: { shareMemoContext: Boolean(checked) } })
                  }
                  aria-label="Share local memory context with delegates"
                />
              </label>
            </div>
          }
        />
      </SettingsSection>

      <Dialog open={viewedFile !== null} onOpenChange={(open) => !open && setViewedFile(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{viewedFile?.name}</DialogTitle>
            <DialogDescription>
              Sent to a delegate when a directive names this file.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">
            {viewedFile?.content}
          </pre>
        </DialogContent>
      </Dialog>
    </SettingsPageContainer>
  );
}
