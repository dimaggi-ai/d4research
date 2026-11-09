import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@d4research/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  AuthMcpClientAccess,
  type EnvironmentId,
  managedCapabilityDenial,
  managedRuntimeModeDenial,
  mcpClientScopes,
  sessionGrantsScope,
} from "@d4research/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide";
import { Atom } from "effect/reactivity";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import { type ReactNode, useState } from "react";
import { environmentMcpUrl } from "@d4research/client-runtime/connection";

import { isElectron } from "~/env";
import { useCopyToClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowSecond } from "~/hooks/useNowSecond";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { type EnvironmentPresentation, useEnvironmentIdentities } from "~/state/environments";
import { useManagedPolicy } from "~/state/managedPolicy";
import { mintMcpApprovalCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import {
  usePreparedConnection,
  useEnvironmentScope,
  useEnvironmentSessionState,
} from "~/state/session";
import { CommandBlock } from "../CommandBlock";
import { MorphIcon } from "../MorphIcon";
import { AccessOption, accessConfig } from "../auth/ConnectAgentSurface";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { MCP_APPS, type McpApp, mcpHandoffAction, OTHER_MCP_APP_STEPS } from "./mcpApps";

const requestAtom = Atom.make<{ readonly environmentId: EnvironmentId | null } | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mcp:use-in-another-app"),
);

/** Opens the wizard for `environmentId`, or for the one Sharing & access picks when null. */
export function openUseInAnotherApp(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(requestAtom, { environmentId });
}

const close = () => appAtomRegistry.set(requestAtom, null);

/** Hosted once at the root, so Cmd-K and Settings can open it from anywhere. */
export function UseInAnotherAppDialogHost() {
  const request = useAtomValue(requestAtom);
  return request === null ? null : <UseInAnotherAppDialog requested={request.environmentId} />;
}

function UseInAnotherAppDialog({ requested }: { readonly requested: EnvironmentId | null }) {
  const { environment, label } = useAccessEnvironment(requested);
  const title = `Use d4research in another app (MCP) · ${label ?? "d4research"}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <WizardPopup>
        {environment !== null ? (
          <Wizard key={environment.environmentId} environment={environment} title={title} />
        ) : (
          <>
            <WizardHeader title={title} />
            <WizardPanel>
              <GateMessage title="Connect to an environment first." />
            </WizardPanel>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}

const STEPS = ["App", "Access", "Connect"] as const;
type Step = 0 | 1 | 2;
type Choice = McpApp | "other";

function Wizard({
  environment,
  title,
}: {
  readonly environment: EnvironmentPresentation;
  readonly title: string;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(environment.environmentId));
  const mcpUrl = environmentMcpUrl({
    entry: environment.entry,
    connectedTarget: prepared?.target,
  });
  const gateTitle =
    environment.connection.phase !== "connected"
      ? `Connect to ${environment.label} first.`
      : environment.serverConfig?.environment.capabilities.mcpApprovalCodes !== true
        ? `Update d4research on ${environment.label}`
        : "Connect using a direct address to use MCP.";
  const open =
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.mcpApprovalCodes === true &&
    mcpUrl !== null;
  const levels = useGrantableLevels(environment);
  const [step, setStep] = useState<Step>(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [picked, setPicked] = useState<AuthMcpClientAccess | null>(null);
  const access = picked ?? DEFAULT_LEVELS.find((level) => levels.get(level) === undefined) ?? null;
  const appName = choice === null || choice === "other" ? "the app" : choice.name;
  return (
    <>
      <WizardHeader title={title}>
        {open ? (
          <WizardSteps
            steps={STEPS}
            currentStep={step}
            isStepDisabled={(index) => index > step}
            onStepChange={(index) => setStep(index as Step)}
          />
        ) : null}
      </WizardHeader>
      <WizardPanel>
        {!open ? (
          <GateMessage title={gateTitle} />
        ) : step === 0 ? (
          <AppStep choice={choice} onChoose={setChoice} />
        ) : step === 1 ? (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">What can {appName} do?</h3>
            <RadioGroup
              aria-label={`What can ${appName} do?`}
              value={access}
              onValueChange={(value) => setPicked(value as AuthMcpClientAccess)}
            >
              {AuthMcpClientAccess.literals.map((level) => (
                <AccessOption
                  key={level}
                  access={level}
                  selected={level === access}
                  disabledReason={levels.get(level)}
                  description={
                    level === "full-access" ? "Runs commands and edits files without asking" : null
                  }
                />
              ))}
            </RadioGroup>
          </section>
        ) : choice !== null && access !== null && mcpUrl !== null ? (
          <ConnectStep environment={environment} mcpUrl={mcpUrl} choice={choice} access={access} />
        ) : null}
      </WizardPanel>
      {open ? (
        <WizardFooter
          leading={step === 2 ? <ManageAccessButton environment={environment} /> : undefined}
        >
          {step === 1 ? (
            <Button variant="outline" onClick={() => setStep(0)}>
              Back
            </Button>
          ) : null}
          {step === 2 ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <Button
              disabled={step === 0 ? choice === null : access === null}
              onClick={() => setStep(step === 0 ? 1 : 2)}
            >
              Next
            </Button>
          )}
        </WizardFooter>
      ) : null}
    </>
  );
}

/** The level the Access step starts at: Auto, else the next one down that can be granted. */
const DEFAULT_LEVELS: readonly AuthMcpClientAccess[] = [
  "auto",
  "auto-accept-edits",
  "approval-required",
  "read-only",
];

/** Why each level cannot be granted on this environment; absent when it can. */
function useGrantableLevels(environment: EnvironmentPresentation) {
  const environmentId = environment.environmentId;
  const session = useEnvironmentSessionState(environmentId).data;
  const canMint = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const policy = useManagedPolicy(environmentId);
  // The server refuses codes for any level when its policy keeps remote clients out.
  const remoteDenial = managedCapabilityDenial(policy, "remoteClients");
  return new Map(
    AuthMcpClientAccess.literals.flatMap((level) => {
      const reason =
        remoteDenial ??
        (!canMint
          ? `This device needs the Manage access permission on ${environment.label}.`
          : session === null ||
              !mcpClientScopes(level).every((scope) => sessionGrantsScope(session, scope))
            ? `This device cannot grant this on ${environment.label}.`
            : level === "read-only"
              ? undefined
              : managedRuntimeModeDenial(policy, level));
      return reason === undefined ? [] : [[level, reason] as const];
    }),
  );
}

function GateMessage({
  title,
  lines = [],
  children,
}: {
  readonly title: string;
  readonly lines?: readonly string[];
  readonly children?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium">{title}</h3>
      {lines.length > 0 ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function AppStep({
  choice,
  onChoose,
}: {
  readonly choice: Choice | null;
  readonly onChoose: (choice: Choice) => void;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Which app?</h3>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {MCP_APPS.filter((app) => !app.hidden).map((app) => (
          <button
            key={app.id}
            type="button"
            aria-pressed={choice === app}
            onClick={() => onChoose(app)}
            className="flex min-w-0 flex-col items-center gap-2 rounded-lg border border-transparent px-1 py-3 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary/8"
          >
            <img
              src={app.logo}
              alt=""
              className="size-10 rounded-lg ring-1 ring-black/10 dark:ring-white/12"
            />
            <span className="max-w-full truncate whitespace-nowrap text-xs font-medium">
              {app.name}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={choice === "other"}
        onClick={() => onChoose("other")}
        className="w-full rounded-lg border border-border px-3 py-2.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary/8"
      >
        Something else…
      </button>
    </section>
  );
}

function ConnectStep({
  environment,
  mcpUrl,
  choice,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly mcpUrl: string;
  readonly choice: Choice;
  readonly access: AuthMcpClientAccess;
}) {
  const [anotherWay, setAnotherWay] = useState(choice === "other");
  const app = choice === "other" ? null : choice;
  const code = (
    <ApprovalCode
      key={access}
      environmentId={environment.environmentId}
      name={environment.label}
      access={access}
    />
  );
  if (anotherWay || app === null) {
    const message = app?.handoff.kind === "copy-message" ? app.handoff.message(mcpUrl) : null;
    return (
      <section className="space-y-4">
        <CopyRow label="URL" value={mcpUrl} />
        {message ? <CopyRow label="Message" value={message} /> : null}
        <ol className="list-decimal space-y-1 ps-5 text-sm">
          {(app?.steps ?? OTHER_MCP_APP_STEPS).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {app === null ? (
          <p className="text-xs text-muted-foreground">
            Apps that require their own client ID cannot connect.
          </p>
        ) : app.docs ? (
          <TextButton onClick={() => openLink(app.docs ?? "")}>{app.name} help</TextButton>
        ) : null}
        {code}
        {app === null ? null : (
          <TextButton onClick={() => setAnotherWay(false)}>
            {app.handoff.kind === "commands" ? "Back to commands" : "Back to one click"}
          </TextButton>
        )}
        <LinkedLine environment={environment} access={access} />
      </section>
    );
  }
  return (
    <section className="space-y-4">
      <PrimaryAction app={app} mcpUrl={mcpUrl} />
      <CopyRow label="URL" value={mcpUrl} />
      {code}
      <TextButton onClick={() => setAnotherWay(true)}>Set up another way</TextButton>
      <LinkedLine environment={environment} access={access} />
    </section>
  );
}

function TextButton({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
    >
      {children}
    </button>
  );
}

function openLink(url: string) {
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not open the link",
        description: error instanceof Error ? error.message : url,
      }),
    );
}

function PrimaryAction({ app, mcpUrl }: { readonly app: McpApp; readonly mcpUrl: string }) {
  const action = mcpHandoffAction(app, mcpUrl);
  const note = app.note ? <p className="text-xs text-muted-foreground">{app.note}</p> : null;
  if (action === null) {
    return (
      <div className="space-y-2">
        {app.handoff.kind === "commands"
          ? app.handoff
              .commands(mcpUrl)
              .map((command) => <CommandBlock key={command} command={command} />)
          : null}
        <p className="text-xs text-muted-foreground">Run these where {app.name} runs.</p>
        {note}
      </div>
    );
  }
  const { copy, link } = action;
  const handOff = async () => {
    if (copy !== null) {
      // The app opens only once the copy lands, so it never gets an older clipboard.
      const copied = await writeTextToClipboard(copy.text, copy.title).catch(() => false);
      if (!copied) {
        toastManager.add({
          type: "error",
          title: "Could not copy",
          description: "Use Set up another way.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: copy.title,
        // A browser can block an open that follows the copy; this keeps a way through.
        ...(isElectron
          ? {}
          : { actionProps: { children: `Open ${app.name}`, onClick: () => openLink(link) } }),
      });
    }
    openLink(link);
  };
  return (
    <div className="space-y-2">
      <Button className="w-full" onClick={() => void handOff()}>
        {action.label}
      </Button>
      {note}
    </div>
  );
}

/** "Get code" mints on click; the code is never copied or sent anywhere by itself. */
function ApprovalCode({
  environmentId,
  name,
  access,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly access: AuthMcpClientAccess;
}) {
  const [code, setCode] = useState<{
    readonly credential: string;
    readonly expiresAt: number;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNowSecond();
  const live = code !== null && now < code.expiresAt;
  const mint = async () => {
    setPending(true);
    setError(null);
    const result = await mintMcpApprovalCodeOn(environmentId, access);
    setPending(false);
    if (Result.isSuccess(result)) {
      setCode({
        credential: result.success.credential,
        expiresAt: result.success.expiresAt.epochMilliseconds,
      });
    } else {
      setError(`Could not get a code from ${name}. Try again.`);
    }
  };
  const left = code === null ? 0 : Math.max(0, Math.floor((code.expiresAt - now) / 1000));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          Code to approve <span className="font-medium">{accessConfig[access].label}</span>
        </span>
        {live ? null : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void mint()}>
            {pending ? "Getting code…" : code === null ? "Get code" : "New code"}
          </Button>
        )}
      </div>
      {code !== null ? (
        live ? (
          <>
            <CopyRow label="Code" value={code.credential} />
            <p className="text-xs text-muted-foreground">
              Expires {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} · one use
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">The code expired.</p>
        )
      ) : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

function CopyRow({ label, value }: { readonly label: string; readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: label });
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{value}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => copyToClipboard(value, undefined)}
      >
        <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
      </Button>
    </div>
  );
}

const levelRank = (level: AuthMcpClientAccess) => AuthMcpClientAccess.literals.indexOf(level);

/** Machines this environment links to, at the level a call forwarded there gets. */
function LinkedLine({
  environment,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: AuthMcpClientAccess;
}) {
  const offered = offersLinkedEnvironments(environment.serverConfig);
  const links = useEnvironmentQuery(
    offered
      ? peerLinkEnvironment.list({ environmentId: environment.environmentId, input: {} })
      : null,
  ).data?.links;
  const identities = useEnvironmentIdentities();
  if (!offered || links === undefined || links.length === 0) return null;
  const named = links.map((link) => {
    const name =
      identities.find((identity) => identity.environmentId === link.environmentId)?.label ??
      link.label;
    // A forwarded call keeps the lower of the app's level and the link's own.
    const level = levelRank(link.access) < levelRank(access) ? link.access : access;
    return `${name} · ${link.status === "expired" ? "Expired" : accessConfig[level].label}`;
  });
  return <p className="text-xs text-muted-foreground">Linked: {named.join(", ")}</p>;
}

/** Opens Sharing & access on this environment. */
function ManageAccessButton({
  environment,
  label = "Manage access",
}: {
  readonly environment: EnvironmentPresentation;
  readonly label?: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      onClick={() => {
        close();
        void navigate({ to: "/settings/access", search: { machine: environment.environmentId } });
      }}
    >
      {label}
    </Button>
  );
}
