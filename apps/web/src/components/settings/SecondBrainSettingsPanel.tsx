import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";
import {
  MessageId,
  ThreadId,
  type BrainLintIssue,
  type BrainProposal,
  type EnvironmentId,
} from "@d4research/contracts";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { secondBrain } from "../../state/second-brain";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

export function SecondBrainSettingsPanel() {
  const { target } = useSettingsScope();
  return target ? (
    <SecondBrainPanel key={target.environmentId} environmentId={target.environmentId} />
  ) : (
    <SettingsPageContainer>
      <p>Select a connected environment.</p>
    </SettingsPageContainer>
  );
}

function Choice<T extends string>({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: T;
  values: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const match = values.find((item) => item === next);
        if (match) onChange(match);
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {values.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SecondBrainPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const settings = useEnvironmentSettings(environmentId).secondBrain;
  const update = useUpdateEnvironmentSettings(environmentId);
  const status = useEnvironmentQuery(secondBrain.secondBrainStatusQuery(environmentId));
  const reindex = useAtomCommand(secondBrain.secondBrainReindexCommand);
  const lint = useAtomCommand(secondBrain.secondBrainLintCommand);
  const regenerate = useAtomCommand(secondBrain.secondBrainRegenerateIndexCommand);
  const canWrite = useAtomValue(
    secondBrain.secondBrainReindexCommand.permissionAtom(environmentId),
  );
  const canRegenerate = useAtomValue(
    secondBrain.secondBrainRegenerateIndexCommand.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly BrainLintIssue[] | null>(null);
  const [lintTruncated, setLintTruncated] = useState(false);
  useEffect(() => {
    const refresh = () => secondBrain.refresh(environmentId, registry);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [environmentId, registry]);
  useEffect(() => {
    secondBrain.refresh(environmentId, registry);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A committed settings change invalidates the vault and its derived queries.
  }, [environmentId, registry, settings]);
  const maintain = async (action: "reindex" | "lint" | "regenerate") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "lint") {
        const result = await lint({ environmentId, input: {} });
        if (result._tag === "Success") {
          setIssues(result.value.issues);
          setLintTruncated(result.value.truncated);
        } else setError(formatEnvironmentQueryError(result.cause));
      } else {
        const result = await (action === "reindex" ? reindex : regenerate)({
          environmentId,
          input: {},
        });
        if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("research-second-brain")}>
        <fieldset disabled={!canWrite}>
          <SettingsRow
            title="Folder"
            description="Markdown notes stored on this environment. Leave empty to disable the second brain."
            control={
              <Input
                aria-label="Second brain folder"
                key={settings.path}
                defaultValue={settings.path}
                onBlur={(e) => update({ secondBrain: { path: e.target.value.trim() } })}
              />
            }
          />
          <SettingsRow
            title="Inject context"
            description="Send relevant notes to the thread's provider. A hosted provider receives this text."
            control={
              <Switch
                aria-label="Inject second brain context"
                checked={settings.injection.enabled}
                onCheckedChange={(enabled) => update({ secondBrain: { injection: { enabled } } })}
              />
            }
          />
          {(
            [
              ["coreBudgetChars", "Core character budget", 0, 262144],
              ["retrievalBudgetChars", "Retrieval character budget", 0, 262144],
              ["retrievalResults", "Retrieval results", 1, 50],
            ] as const
          ).map(([field, label, min, max]) => (
            <SettingsRow
              key={field}
              title={label}
              control={
                <Input
                  type="number"
                  min={min}
                  max={max}
                  aria-label={label}
                  key={settings.injection[field]}
                  defaultValue={settings.injection[field]}
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (Number.isInteger(value) && value >= min && value <= max)
                      update({ secondBrain: { injection: { [field]: value } } });
                  }}
                />
              }
            />
          ))}
          <SettingsRow
            title="Capture mode"
            description="After successful turns, local capture can suggest notes for review."
            control={
              <Choice
                label="Capture mode"
                value={settings.capture}
                values={["off", "proposals"]}
                onChange={(capture) => update({ secondBrain: { capture } })}
              />
            }
          />
          <SettingsRow
            title="Capture model"
            description="Local Ollama model. Leave empty to use the handoff compression model."
            control={
              <Input
                aria-label="Capture model"
                key={settings.captureModel}
                defaultValue={settings.captureModel ?? ""}
                onBlur={(e) => update({ secondBrain: { captureModel: e.target.value.trim() } })}
              />
            }
          />
          <SettingsRow
            title="Write mode"
            description="Review requires approval. Direct mode allows agents to change notes without approval."
            control={
              <Choice
                label="Write mode"
                value={settings.writeMode}
                values={["review", "direct"]}
                onChange={(writeMode) => update({ secondBrain: { writeMode } })}
              />
            }
          />
          <SettingsRow
            title="Local embeddings"
            description="Use local Ollama embeddings for semantic search. Keyword search remains available if embeddings fail."
            control={
              <Switch
                aria-label="Enable local embeddings"
                checked={settings.embeddings.enabled}
                onCheckedChange={(enabled) => update({ secondBrain: { embeddings: { enabled } } })}
              />
            }
          />
          <SettingsRow
            title="Embedding model"
            control={
              <Input
                aria-label="Embedding model"
                key={settings.embeddings.model}
                defaultValue={settings.embeddings.model}
                onBlur={(e) =>
                  update({ secondBrain: { embeddings: { model: e.target.value.trim() } } })
                }
              />
            }
          />
        </fieldset>
      </SettingsSection>
      <SettingsSection title="Index status">
        {status.error ? (
          <p role="alert">{status.error}</p>
        ) : status.data ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>Notes</dt>
            <dd>{status.data.notes}</dd>
            <dt>Chunks</dt>
            <dd>{status.data.chunks}</dd>
            <dt>Last reconcile</dt>
            <dd>
              {status.data.lastIndexedAt
                ? new Date(status.data.lastIndexedAt).toLocaleString()
                : "Never"}
            </dd>
            <dt>Semantic search</dt>
            <dd>{status.data.semanticStatus}</dd>
            <dt>Pending capture jobs</dt>
            <dd>{status.data.captureJobs?.pending ?? 0}</dd>
            <dt>Failed capture jobs</dt>
            <dd>{status.data.captureJobs?.failed ?? 0}</dd>
            <dt>Generation</dt>
            <dd>{status.data.generation}</dd>
          </dl>
        ) : (
          <p>Loading index status…</p>
        )}
        {status.data?.truncated && <p>Index limits were reached; some notes may be omitted.</p>}
        <div className="flex flex-wrap gap-2 py-3">
          <Button
            variant="outline"
            disabled={busy || !canWrite || !settings.path}
            onClick={() => void maintain("reindex")}
          >
            Reindex
          </Button>
          <Button
            variant="outline"
            disabled={busy || !settings.path}
            onClick={() => void maintain("lint")}
          >
            Lint
          </Button>
          <Button
            variant="outline"
            disabled={busy || !canRegenerate || !settings.path}
            onClick={() => void maintain("regenerate")}
          >
            Regenerate INDEX
          </Button>
        </div>
        {busy && <p role="status">Working…</p>}
        {error && <p role="alert">{error}</p>}
        {issues &&
          (issues.length ? (
            <ul className="space-y-1 text-sm">
              {issues.map((issue) => (
                <li key={`${issue.path}:${issue.code}:${issue.line ?? 0}`}>
                  {issue.path}
                  {issue.line ? `:${issue.line}` : ""} — {issue.code}
                </li>
              ))}
            </ul>
          ) : (
            <p>No lint issues found.</p>
          ))}
        {lintTruncated && <p>More issues exist than this report can show.</p>}
      </SettingsSection>
      <ReviewInbox key={settings.path} environmentId={environmentId} />
    </SettingsPageContainer>
  );
}

function SourceLink({
  environmentId,
  threadId,
  messageId,
  quote,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  messageId?: string;
  quote?: string;
}) {
  const citation =
    messageId && quote?.trim()
      ? assistantCitationNavigation({
          version: 1,
          environmentId,
          threadId: ThreadId.make(threadId),
          messageId: MessageId.make(messageId),
          text: quote,
          start: 0,
          end: quote.length,
          prefix: "",
          suffix: "",
        })
      : null;
  return citation ? (
    <Link {...citation} className="text-primary underline">
      Source message
    </Link>
  ) : (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
      className="text-primary underline"
    >
      Source thread
    </Link>
  );
}

function ReviewInbox({ environmentId }: { environmentId: EnvironmentId }) {
  const [state, setState] = useState<BrainProposal["state"]>("pending");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const proposals = useEnvironmentQuery(
    secondBrain.secondBrainProposalsQuery({ environmentId, state, offset, limit: 20 }),
  );
  return (
    <SettingsSection {...searchableSetting("second-brain-inbox")}>
      <div className="flex items-center gap-3 pb-3">
        <Choice
          label="Proposal status"
          value={state}
          values={["pending", "conflict", "accepted", "rejected"]}
          onChange={(next) => {
            setState(next);
            setOffset(0);
            setSelected(null);
          }}
        />
        <Button variant="ghost" onClick={proposals.refresh}>
          Refresh
        </Button>
      </div>
      {proposals.error && <p role="alert">{proposals.error}</p>}
      {proposals.isPending && <p role="status">Loading proposals…</p>}
      {proposals.data?.length === 0 && <p>No {state} proposals.</p>}
      <ul className="divide-y">
        {proposals.data?.map((proposal) => (
          <li key={proposal.id} className="space-y-2 py-3">
            <Button variant="ghost" onClick={() => setSelected(proposal.id)}>
              {proposal.kind}: {proposal.path}
            </Button>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <time dateTime={proposal.createdAt}>
                {formatRelativeTimeLabel(proposal.createdAt, proposals.dataUpdatedAt)}
              </time>
              {proposal.evidence[0] && (
                <SourceLink
                  environmentId={environmentId}
                  threadId={proposal.evidence[0].threadId}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 py-3">
        <Button
          variant="outline"
          disabled={offset === 0}
          onClick={() => {
            setOffset(Math.max(0, offset - 20));
            setSelected(null);
          }}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={(proposals.data?.length ?? 0) < 20}
          onClick={() => {
            setOffset(offset + 20);
            setSelected(null);
          }}
        >
          Next
        </Button>
      </div>
      {selected && <ProposalDetail key={selected} environmentId={environmentId} id={selected} />}
    </SettingsSection>
  );
}

function ProposalDetail({ environmentId, id }: { environmentId: EnvironmentId; id: string }) {
  const detail = useEnvironmentQuery(secondBrain.secondBrainProposalQuery({ environmentId, id }));
  const accept = useAtomCommand(secondBrain.secondBrainAcceptCommand);
  const reject = useAtomCommand(secondBrain.secondBrainRejectCommand);
  const canAccept = useAtomValue(
    secondBrain.secondBrainAcceptCommand.permissionAtom(environmentId),
  );
  const canReject = useAtomValue(
    secondBrain.secondBrainRejectCommand.permissionAtom(environmentId),
  );
  const [edit, setEdit] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = async (action: "accept" | "reject") => {
    if (action === "accept" && !detail.data) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        action === "accept"
          ? await accept({
              environmentId,
              input: {
                id,
                expectedHash: detail.data!.currentHash,
                ...(edit === null ? {} : { contentOverride: edit }),
              },
            })
          : await reject({ environmentId, input: { id, reason: reason.trim() } });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        detail.refresh();
      } else setEdit(null);
    } finally {
      setBusy(false);
    }
  };
  if (!detail.data)
    return (
      <div>
        <p role={detail.error ? "alert" : "status"}>{detail.error ?? "Loading proposal…"}</p>
        <Input
          aria-label="Rejection reason"
          placeholder="Reason for rejection"
          value={reason}
          maxLength={4096}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          variant="outline"
          disabled={!canReject || busy || !reason.trim()}
          onClick={() => void review("reject")}
        >
          Reject
        </Button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const { proposal, conflict, truncated } = detail.data;
  const reviewable = proposal.state === "pending" || proposal.state === "conflict";
  return (
    <article className="space-y-4 border-t py-4">
      <h3 className="font-medium">{proposal.path}</h3>
      <p>{proposal.rationale}</p>
      {conflict && (
        <p role="alert" className="text-destructive">
          The file changed after this proposal was created. Reject it and ask the agent for a new
          proposal.
        </p>
      )}
      {truncated && (
        <p role="alert">
          This preview is incomplete. To accept, supply the full replacement file. You can also
          reject this proposal.
        </p>
      )}
      <pre
        className="max-h-96 overflow-auto rounded border p-3 text-xs whitespace-pre-wrap"
        aria-label="Unified diff"
      >
        {detail.data.diff || "No changes."}
      </pre>
      <h4 className="text-sm font-medium">Evidence</h4>
      {proposal.evidence.length === 0 && <p>No source evidence attached.</p>}
      {proposal.evidence.map((evidence) => (
        <blockquote
          key={`${evidence.threadId}:${evidence.messageId}:${evidence.quote}`}
          className="border-l-2 pl-3 text-sm"
        >
          <p>{evidence.quote}</p>
          <SourceLink
            environmentId={environmentId}
            threadId={evidence.threadId}
            messageId={evidence.messageId}
            quote={evidence.quote}
          />
        </blockquote>
      ))}
      {proposal.possibleDuplicates?.map((duplicate) => (
        <p key={duplicate.path} role="note">
          Possible duplicate: {duplicate.path} — {duplicate.reason}
        </p>
      ))}
      {reviewable && (
        <>
          <Button
            variant="outline"
            disabled={!canAccept || busy || conflict}
            onClick={() =>
              setEdit(edit === null ? (truncated ? "" : detail.data!.proposedContent) : null)
            }
          >
            {edit === null ? "Edit proposed file" : "Discard edit"}
          </Button>
          {edit !== null && (
            <Textarea
              aria-label="Edited proposed file content"
              value={edit}
              rows={14}
              onChange={(event) => setEdit(event.target.value)}
            />
          )}
          <Input
            aria-label="Rejection reason"
            placeholder="Reason for rejection"
            value={reason}
            maxLength={4096}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              disabled={!canAccept || busy || conflict || (truncated && !edit?.trim())}
              onClick={() => void review("accept")}
            >
              Accept{edit === null ? "" : " edited file"}
            </Button>
            <Button
              variant="outline"
              disabled={!canReject || busy || !reason.trim()}
              onClick={() => void review("reject")}
            >
              Reject
            </Button>
          </div>
        </>
      )}
      {!reviewable && (
        <p>
          {proposal.state}
          {proposal.reason ? `: ${proposal.reason}` : ""}
        </p>
      )}
      {busy && <p role="status">Saving review…</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
