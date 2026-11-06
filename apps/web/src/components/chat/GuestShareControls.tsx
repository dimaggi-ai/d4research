import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";
import { type ScopedThreadRef, type ThreadGuestShare } from "@d4research/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { serverEnvironment } from "~/state/server";

import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

import { guestShareDialogThreadAtom } from "./guestShareDialogState";

function useThreadGuestShare(threadRef: ScopedThreadRef | null): ThreadGuestShare | null {
  return useQuietThreadProjection(threadRef)?.projection.thread.guestShare ?? null;
}

export function GuestShareDialogHost() {
  const threadRef = useAtomValue(guestShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <GuestShareDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(guestShareDialogThreadAtom, null)}
    />
  );
}

type CreateState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "created"; readonly url: string }
  | { readonly status: "failed"; readonly message: string };

function GuestShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const activeShare = useThreadGuestShare(threadRef);
  const canCreate = useAtomValue(
    serverEnvironment.createGuestShare.permissionAtom(threadRef.environmentId),
  );
  const createGuestShare = useAtomCommand(serverEnvironment.createGuestShare, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "guest link" });
  const [state, setState] = useState<CreateState>({ status: "idle" });

  const create = async () => {
    setState({ status: "creating" });
    const result = await createGuestShare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Success") {
      setState({ status: "created", url: result.value.url });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : "Could not create a guest link.",
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "creating") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share with guest</DialogTitle>
          <DialogDescription>
            The guest sees the thread as you do, including command output and the agent&apos;s
            reasoning. Each message they send waits for you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state.status === "created" ? (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="Guest link"
                value={state.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(state.url)}>
                {isCopied ? <CheckIcon /> : <CopyIcon />}
                {isCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {activeShare !== null
                ? "A new link ends the current one."
                : "The link works once and expires in 24 hours."}
            </p>
          )}
          {state.status === "failed" ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {state.status === "created" ? (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={state.status === "creating"}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void create()}
                disabled={!canCreate || state.status === "creating"}
              >
                {state.status === "creating" ? "Creating..." : "Create link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
