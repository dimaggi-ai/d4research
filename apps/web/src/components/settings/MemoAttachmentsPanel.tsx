import type { PreparedConnection } from "@d4research/client-runtime/connection";
import { RefreshCwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteStoredMemoAttachment,
  listStoredMemoAttachments,
  type MemoAttachmentListResult,
  type StoredMemoAttachmentSummary,
} from "../../memoAttachments";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

type LoadState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "success"; readonly result: MemoAttachmentListResult }
  | { readonly status: "error"; readonly message: string };

const storedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function attachmentDetails(attachment: StoredMemoAttachmentSummary): string {
  const details = [
    attachment.project ? `Project: ${attachment.project}` : "No project scope",
    attachment.characterCount === null
      ? null
      : `${attachment.characterCount.toLocaleString()} characters`,
    attachment.chunkCount === null ? null : `${attachment.chunkCount.toLocaleString()} chunks`,
    (() => {
      const date = new Date(attachment.storedAt);
      return Number.isNaN(date.valueOf()) ? attachment.storedAt : storedAtFormatter.format(date);
    })(),
  ];
  return details.filter((detail) => detail !== null).join(" · ");
}

export function MemoAttachmentsPanel({
  enabled,
  preparedConnection,
}: {
  readonly enabled: boolean;
  readonly preparedConnection: PreparedConnection | null;
}) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<StoredMemoAttachmentSummary | null>(null);
  const [deletingToken, setDeletingToken] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || preparedConnection === null) {
      setLoadState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setLoadState({ status: "loading" });
    void listStoredMemoAttachments(preparedConnection).then(
      (result) => {
        if (!cancelled) setLoadState({ status: "success", result });
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not list stored attachments.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, preparedConnection, refreshSequence]);

  const attachments = loadState.status === "success" ? loadState.result.attachments : ([] as const);
  const pendingDeleteName = useMemo(
    () => pendingDelete?.name ?? "this incomplete attachment",
    [pendingDelete],
  );

  const deleteAttachment = useCallback(async () => {
    if (pendingDelete === null || preparedConnection === null || deletingToken !== null) return;
    const attachment = pendingDelete;
    setDeletingToken(attachment.documentToken);
    try {
      const deleted = await deleteStoredMemoAttachment(
        preparedConnection,
        attachment.documentToken,
      );
      setPendingDelete(null);
      setRefreshSequence((sequence) => sequence + 1);
      toastManager.add({
        type: "success",
        title: "Attachment removed from Memo",
        description:
          deleted === 0
            ? "It was already absent. The original chat message remains in the transcript."
            : `Removed ${deleted.toLocaleString()} stored rows. The original chat message remains in the transcript.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete the attachment.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove attachment",
          description: message,
        }),
      );
    } finally {
      setDeletingToken(null);
    }
  }, [deletingToken, pendingDelete, preparedConnection]);

  const description = !enabled
    ? "Enable Local Memo to inspect or remove documents saved by the composer."
    : preparedConnection === null
      ? "Connect to this environment to inspect its stored composer documents."
      : loadState.status === "loading"
        ? "Reading this environment's durable composer documents…"
        : loadState.status === "error"
          ? loadState.message
          : loadState.status === "success" && !loadState.result.supported
            ? "The effective Memo REST backend cannot enumerate or delete attachments here. Manage its data in that service."
            : attachments.length === 0
              ? "No Memo-backed composer documents are stored in this environment."
              : `${attachments.length.toLocaleString()} durable composer document${attachments.length === 1 ? "" : "s"}. Deletion removes Memo rows, never chat history.`;

  return (
    <>
      <SettingsRow
        title="Stored composer documents"
        description={description}
        status={
          loadState.status === "success" ? (
            <span>Effective backend: {loadState.result.backend}</span>
          ) : loadState.status === "error" ? (
            <span className="text-destructive">Try refreshing after checking Local Memo.</span>
          ) : null
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!enabled || preparedConnection === null || loadState.status === "loading"}
            aria-label="Refresh stored Memo attachments"
            onClick={() => setRefreshSequence((sequence) => sequence + 1)}
          >
            {loadState.status === "loading" ? (
              <Spinner className="size-3.5" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Refresh
          </Button>
        }
      >
        {loadState.status === "success" && loadState.result.supported && attachments.length > 0 ? (
          <div className="mt-3 divide-y divide-border/64 overflow-hidden rounded-lg border bg-muted/24">
            {attachments.map((attachment) => (
              <div
                key={`${attachment.documentToken}:${attachment.project ?? ""}`}
                className="flex min-w-0 flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {attachment.name ?? "Incomplete attachment"}
                    </span>
                    {attachment.incomplete ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[11px] font-medium text-warning">
                        <TriangleAlertIcon className="size-3" />
                        Incomplete
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                    {attachmentDetails(attachment)}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="destructive-outline"
                  className="self-start sm:self-auto"
                  disabled={deletingToken !== null}
                  aria-label={`Delete ${attachment.name ?? "incomplete attachment"} from Memo`}
                  onClick={() => setPendingDelete(attachment)}
                >
                  <Trash2Icon className="size-3.5" />
                  Delete
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsRow>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && deletingToken === null) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{pendingDeleteName}” from Memo?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the stored chunks. The original chat message and its preview
              remain in the authoritative transcript, but agents can no longer retrieve the full
              document from Memo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={deletingToken !== null}
              render={<Button variant="outline" disabled={deletingToken !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingDelete === null || deletingToken !== null}
              onClick={() => void deleteAttachment()}
            >
              {deletingToken !== null ? <Spinner className="size-4" /> : null}
              Delete from Memo
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
