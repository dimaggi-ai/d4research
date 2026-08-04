import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { isProviderHandoffCandidate } from "../../providerHandoff";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

export function ProviderHandoffDialog(props: {
  readonly open: boolean;
  readonly sourceInstanceId: ProviderInstanceId;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (selection: ModelSelection) => void;
}) {
  const candidates = useMemo(
    () =>
      props.entries.filter((entry) => isProviderHandoffCandidate(entry, props.sourceInstanceId)),
    [props.entries, props.sourceInstanceId],
  );
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const selectedEntry =
    candidates.find((entry) => entry.instanceId === instanceId) ?? candidates[0];
  const [model, setModel] = useState("");
  const selectedModel = selectedEntry?.models.some((candidate) => candidate.slug === model)
    ? model
    : (selectedEntry?.models.find((candidate) => candidate.isDefault)?.slug ??
      selectedEntry?.models[0]?.slug ??
      "");

  useEffect(() => {
    if (!props.open) return;
    setInstanceId(candidates[0]?.instanceId ?? null);
    setModel(
      candidates[0]?.models.find((candidate) => candidate.isDefault)?.slug ??
        candidates[0]?.models[0]?.slug ??
        "",
    );
  }, [candidates, props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.busy ? undefined : props.onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change provider</DialogTitle>
          <DialogDescription>
            Starts a linked chat in the same project and worktree. This chat and its provider remain
            unchanged.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other ready provider is available.</p>
          ) : (
            <>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Provider</span>
                <Select
                  value={selectedEntry?.instanceId}
                  onValueChange={(value) => {
                    const next = candidates.find((entry) => entry.instanceId === value);
                    if (!next) return;
                    setInstanceId(next.instanceId);
                    setModel(
                      next.models.find((candidate) => candidate.isDefault)?.slug ??
                        next.models[0]?.slug ??
                        "",
                    );
                  }}
                >
                  <SelectTrigger aria-label="Handoff provider" className="w-full">
                    <SelectValue>{selectedEntry?.displayName ?? "Select provider"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {candidates.map((entry) => (
                      <SelectItem key={entry.instanceId} value={entry.instanceId}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Model</span>
                <Select
                  value={selectedModel}
                  onValueChange={(value) => {
                    if (value !== null) setModel(value);
                  }}
                >
                  <SelectTrigger aria-label="Handoff model" className="w-full">
                    <SelectValue>
                      {selectedEntry?.models.find((candidate) => candidate.slug === selectedModel)
                        ?.name ?? selectedModel}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {selectedEntry?.models.map((candidate) => (
                      <SelectItem key={candidate.slug} value={candidate.slug}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <p className="text-xs text-muted-foreground">
                Local Gemma creates a listening-friendly context summary. The receiving agent stores
                it in local Memo before continuing.
              </p>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={props.busy} />}>
            Cancel
          </DialogClose>
          <Button
            disabled={props.busy || !selectedEntry || !selectedModel}
            onClick={() => {
              if (!selectedEntry || !selectedModel) return;
              props.onConfirm({ instanceId: selectedEntry.instanceId, model: selectedModel });
            }}
          >
            {props.busy ? (
              <>
                <Spinner className="size-3.5" /> Creating handoff…
              </>
            ) : (
              "Create handoff"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
