import { useState } from "react";
import {
  AuthGrantScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "@d4research/contracts";
import { AUTH_SCOPE_OPTIONS } from "@d4research/shared/authScopeOptions";
import { togglePairingScopeSelection } from "./ConnectionsSettings.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function ClientScopesDialog(props: {
  readonly label: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly disabled?: boolean;
  readonly onSave: (scopes: ReadonlyArray<AuthGrantScope>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" disabled={props.disabled} />}>
        Edit permissions
      </DialogTrigger>
      {/* Canceled edits must unmount even when closed popup content is retained. */}
      {open ? (
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Edit client permissions</DialogTitle>
            <DialogDescription>
              {props.label}. Changes apply to this environment and reconnect the client
              automatically. No new pairing link is needed.
            </DialogDescription>
          </DialogHeader>
          <ScopeEditor {...props} onClose={() => setOpen(false)} />
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

function ScopeEditor(props: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly onSave: (scopes: ReadonlyArray<AuthGrantScope>) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlyArray<AuthGrantScope>>(() =>
    props.scopes.filter((scope): scope is AuthGrantScope =>
      AuthGrantScope.literals.some((grant) => grant === scope),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = AuthGrantScope.literals.filter((scope) =>
    props.delegatableScopes.includes(scope),
  );
  const undelegatable = selected.some((scope) => !available.includes(scope));
  const preset = (scopes: ReadonlyArray<AuthGrantScope>) =>
    setSelected(scopes.filter((scope) => available.includes(scope)));
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving || !selected.length || undelegatable) return;
        setSaving(true);
        setError(null);
        void props.onSave(selected).then(
          () => {
            setSaving(false);
            props.onClose();
          },
          (cause: unknown) => {
            setSaving(false);
            setError(
              cause instanceof Error ? cause.message : "Could not save permissions. Try again.",
            );
          },
        );
      }}
    >
      <DialogPanel>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() =>
              preset([
                AuthOrchestrationReadScope,
                AuthRelayReadScope,
                AuthFilesystemReadScope,
                AuthDiagnosticsReadScope,
                AuthTerminalReadScope,
              ])
            }
          >
            Read only
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => preset(AuthStandardClientScopes)}
          >
            Standard
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => preset(available)}
          >
            All available
          </Button>
        </div>
        <div className="divide-y rounded-lg border">
          {AUTH_SCOPE_OPTIONS.map(({ scope, title, description }) => (
            <label key={scope} className="flex items-start gap-3 p-3">
              <Checkbox
                checked={selected.includes(scope)}
                disabled={saving || (!available.includes(scope) && !selected.includes(scope))}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    togglePairingScopeSelection(current, scope, checked === true),
                  )
                }
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-xs text-muted-foreground">{description}</span>
              </span>
            </label>
          ))}
        </div>
        {undelegatable ? (
          <p role="alert" className="text-sm text-destructive">
            You can only grant permissions that your current client has. Remove the unavailable
            permissions before saving.
          </p>
        ) : null}
        {!selected.length ? (
          <p className="text-sm text-destructive">
            Select at least one permission, or revoke the client to remove access entirely.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !selected.length || undelegatable}>
          {saving ? "Saving…" : "Save permissions"}
        </Button>
      </DialogFooter>
    </form>
  );
}
