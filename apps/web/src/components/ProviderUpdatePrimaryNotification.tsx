import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  AuthProvidersManageScope,
  type ServerProvider,
  type ProviderInstanceId,
} from "@d4research/contracts";

import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironment } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  firstFailedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  getProviderUpdateRunningToastView,
  providerUpdateNotificationKey,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useAtomCommand } from "../state/use-atom-command";

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

type ActiveProviderUpdateToast =
  | {
      readonly kind: "prompt";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
      readonly canManageProviders: boolean;
    }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
      readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
      readonly providerCount: number;
    };

function ProviderUpdateToastIcon({ provider }: { provider: ServerProvider }) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <ProviderInstanceIcon
        driverKind={provider.driver}
        displayName={provider.displayName ?? provider.driver}
        acpRegistryIconUrl={provider.iconUrl}
        iconClassName="size-4"
      />
      <span className="absolute -right-1 -bottom-1 z-40 inline-flex size-3 items-center justify-center rounded-full bg-popover">
        <DownloadIcon aria-hidden="true" className="size-2.5 text-success" strokeWidth={2.5} />
      </span>
    </span>
  );
}

function updateProviderUpdateToast(input: {
  readonly toastId: ProviderUpdateToastId;
  readonly view: ProviderUpdateToastView;
  readonly openSettings: () => void;
}) {
  if (input.view.type === "loading" || input.view.type === "success") {
    toastManager.update(input.toastId, {
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      // Base UI merges toast updates with the existing toast. Explicitly clear
      // the prompt action so its guarded Update handler cannot linger as a
      // visible no-op while the update is running (or after it succeeds).
      actionProps: undefined,
      data: {
        hideCopyButton: true,
        ...(input.view.dismissAfterVisibleMs !== undefined
          ? { dismissAfterVisibleMs: input.view.dismissAfterVisibleMs }
          : {}),
      },
    });
    return;
  }

  toastManager.update(
    input.toastId,
    stackedThreadToast({
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: {
        children: "Settings",
        onClick: input.openSettings,
      },
      actionVariant: "outline",
      data: {
        hideCopyButton: true,
      },
    }),
  );
}

function isTerminalProviderUpdateToastView(view: ProviderUpdateToastView) {
  return view.phase === "failed" || view.phase === "unchanged" || view.phase === "succeeded";
}

export function ProviderUpdatePrimaryNotification() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const canManageProviders = useEnvironmentScope(
    primaryEnvironment?.environmentId ?? null,
    AuthProvidersManageScope,
  );
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  useEffect(() => {
    return () => {
      const activeToast = activeToastRef.current;
      if (activeToast) {
        toastManager.close(activeToast.toastId);
        activeToastRef.current = null;
      }
    };
  }, []);

  const updateProviders = collectProviderUpdateCandidates(providers);
  const notificationKey = providerUpdateNotificationKey(updateProviders);
  const oneClickProviders = updateProviders.filter((provider) =>
    canOneClickUpdateProviderCandidate(provider, providers),
  );

  const openProviderSettings = (toastId?: ProviderUpdateToastId) => {
    const activeToast = activeToastRef.current;
    if (toastId !== undefined) {
      toastManager.close(toastId);
    } else if (activeToast?.kind === "prompt") {
      toastManager.close(activeToast.toastId);
    }
    if (
      activeToast &&
      (toastId === undefined || (activeToast.kind === "prompt" && activeToast.toastId === toastId))
    ) {
      activeToastRef.current = null;
    }
    void navigate({ to: "/settings/providers" });
  };

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind !== "update") {
      return;
    }

    const activeProviders = providers.filter((provider) =>
      activeToast.providerInstanceIds.has(provider.instanceId),
    );
    const view = getProviderUpdateProgressToastView({
      providers: activeProviders,
      providerCount: activeToast.providerCount,
    });
    updateProviderUpdateToast({
      toastId: activeToast.toastId,
      view,
      openSettings: () => openProviderSettings(activeToast.toastId),
    });

    if (isTerminalProviderUpdateToastView(view)) {
      activeToastRef.current = null;
    }
  }, [providers, openProviderSettings]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    const updateExistingPrompt =
      activeToast?.kind === "prompt" &&
      activeToast.key === notificationKey &&
      activeToast.canManageProviders !== canManageProviders;
    if (
      !notificationKey ||
      dismissedNotificationKeys.has(notificationKey) ||
      (seenProviderUpdateNotificationKeys.has(notificationKey) && !updateExistingPrompt) ||
      (activeToastRef.current && !updateExistingPrompt)
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);

    const initialView = getProviderUpdateInitialToastView({ updateProviders, oneClickProviders });

    let toastId!: ProviderUpdateToastId;
    let updateStarted = false;
    const openSettings = () => openProviderSettings(toastId);
    const dismissPrompt = () => {
      dismissNotificationKey(notificationKey);
    };

    const runUpdates = () => {
      if (
        updateStarted ||
        oneClickProviders.length === 0 ||
        !primaryEnvironment ||
        !readEnvironmentScope(primaryEnvironment.environmentId, AuthProvidersManageScope)
      ) {
        return;
      }
      updateStarted = true;

      const providerCount = oneClickProviders.length;
      const providerInstanceIds = new Set(oneClickProviders.map((provider) => provider.instanceId));
      activeToastRef.current = {
        kind: "update",
        key: notificationKey,
        toastId,
        providerInstanceIds,
        providerCount,
      };

      updateProviderUpdateToast({
        toastId,
        view: getProviderUpdateRunningToastView(providerCount),
        openSettings,
      });

      void (async () => {
        const results = [];
        for (const provider of oneClickProviders) {
          if (!readEnvironmentScope(primaryEnvironment.environmentId, AuthProvidersManageScope)) {
            if (activeToastRef.current?.key === notificationKey) {
              updateProviderUpdateToast({
                toastId,
                view: getProviderUpdateRejectedToastView(
                  providerCount,
                  "This connection cannot manage provider accounts.",
                ),
                openSettings: openProviderSettings,
              });
              activeToastRef.current = null;
            }
            return;
          }
          results.push(
            await updateProvider({
              environmentId: primaryEnvironment.environmentId,
              input: {
                provider: provider.driver,
                instanceId: provider.instanceId,
              },
            }),
          );
        }

        const activeUpdateToast = activeToastRef.current;
        if (activeUpdateToast?.kind !== "update" || activeUpdateToast.toastId !== toastId) {
          return;
        }

        const failedMessage = firstFailedProviderUpdateMessage(results);
        if (failedMessage) {
          updateProviderUpdateToast({
            toastId,
            view: getProviderUpdateRejectedToastView(providerCount, failedMessage),
            openSettings,
          });
          activeToastRef.current = null;
          return;
        }

        const updatedProviderSnapshots = collectUpdatedProviderSnapshots({
          results,
          providerInstanceIds,
        });
        const view = getProviderUpdateProgressToastView({
          providers: updatedProviderSnapshots,
          providerCount,
        });
        updateProviderUpdateToast({
          toastId,
          view,
          openSettings,
        });

        if (isTerminalProviderUpdateToastView(view)) {
          activeToastRef.current = null;
        }
      })();
    };

    const toastOptions = stackedThreadToast({
      type: initialView.type,
      title: initialView.title,
      description: canManageProviders
        ? initialView.description
        : "This connection cannot manage provider accounts. View provider settings for update details.",
      timeout: 0,
      actionProps:
        oneClickProviders.length > 0
          ? {
              children: "Update",
              disabled: !canManageProviders,
              onClick: runUpdates,
            }
          : {
              children: "Settings",
              onClick: openSettings,
            },
      actionVariant: "outline",
      data: {
        leadingIcon:
          updateProviders.length === 1 ? (
            <ProviderUpdateToastIcon provider={updateProviders[0]!} />
          ) : undefined,
        hideCopyButton: true,
        onClose: dismissPrompt,
        ...(oneClickProviders.length > 0
          ? {
              secondaryActionProps: {
                children: "Settings",
                onClick: openSettings,
              },
              secondaryActionVariant: "outline" as const,
            }
          : {}),
      },
    });
    if (updateExistingPrompt && activeToast?.kind === "prompt") {
      toastId = activeToast.toastId;
      toastManager.update(toastId, toastOptions);
    } else {
      toastId = toastManager.add(toastOptions);
    }
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId, canManageProviders };
  }, [
    canManageProviders,
    updateProvider,
    dismissNotificationKey,
    dismissedNotificationKeys,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    primaryEnvironment,
    updateProviders,
  ]);

  return null;
}
