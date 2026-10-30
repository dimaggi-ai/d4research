import { FolderPlusIcon } from "lucide-react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProjectMemorySettings } from "./ProjectMemorySettings";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { AuthOrchestrationOperateScope } from "@d4research/contracts";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@d4research/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@d4research/client-runtime/environment";
import { planProjectRemoval } from "@d4research/client-runtime/state/projects";
import { AsyncResult } from "effect/reactivity";
import {
  type ProjectWorkspace,
  type EnvironmentId,
  type ProjectIconOverride,
} from "@d4research/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { InfoIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useOpenDirectoryCommandPalette } from "../../commandPaletteContext";
import { cn } from "../../lib/utils";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { useClientSettings } from "../../hooks/useSettings";
import { linkProjects } from "../../projectLinks";
import { projectEnvironment } from "../../state/projects";
import { ProjectFavicon } from "../ProjectFavicon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
function pathIsPrimary(path: string, primaryPath: string): boolean {
  return path === primaryPath;
}
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";
import { useAccentColorStore } from "../../accentColorStore";
import { ACCENT_COLOR_OPTIONS, accentColorLabel, resolveAccentHex } from "../../lib/accentColors";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

export type ProjectSettingsCategory = "general" | "source-control" | "project";

interface ProjectSelection {
  readonly key: string;
  readonly environmentId: EnvironmentId | null;
  readonly checkoutKey: string | null;
  readonly memberKeys: ReadonlyArray<string>;
}

function sameProjectSelection(a: ProjectSelection | null, b: ProjectSelection): boolean {
  return (
    a !== null &&
    a.key === b.key &&
    a.environmentId === b.environmentId &&
    a.checkoutKey === b.checkoutKey &&
    a.memberKeys.length === b.memberKeys.length &&
    a.memberKeys.every((key, index) => key === b.memberKeys[index])
  );
}

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
  unavailable,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
  unavailable?: ReactNode;
}) {
  const groups = useSettingsProjectGroups();
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members =
    selected?.memberProjects.filter(
      (member) =>
        (environmentId === null || member.environmentId === environmentId) &&
        (checkoutKey === null || member.physicalProjectKey === checkoutKey),
    ) ?? [];

  // Retain group members so grouping-rule changes can follow the project to its new group.
  const [lastSelection, setLastSelection] = useState<ProjectSelection | null>(null);
  if (selected && members.length > 0) {
    const current: ProjectSelection = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
    if (!sameProjectSelection(lastSelection, current)) setLastSelection(current);
  }

  const successor =
    members.length === 0 &&
    lastSelection?.key === projectKey &&
    lastSelection.environmentId === environmentId &&
    lastSelection.checkoutKey === checkoutKey
      ? groups.find((group) =>
          group.memberProjects.some((member) =>
            lastSelection.memberKeys.includes(member.physicalProjectKey),
          ),
        )
      : undefined;
  if (successor) {
    return (
      <Navigate
        to={pathname}
        search={{
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }}
        replace
        hashScrollIntoView={false}
      />
    );
  }

  if ((!selected || members.length === 0) && unavailable != null) return unavailable;

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(group.memberProjects, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const threads = useThreadShells();
  const allGroups = useSettingsProjectGroups();
  const projectLinks = useClientSettings((settings) => settings.sidebarProjectLinks);
  const attachChoices = allGroups.filter(
    (candidate) => !candidate.isScratch && candidate.projectKey !== group.projectKey,
  );
  const linkedMembers = group.memberProjects.filter(
    (member) => projectLinks[member.physicalProjectKey] !== undefined,
  );
  const reportLinkFailure = (error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Project grouping not saved",
        description: error instanceof Error ? error.message : "Could not save project grouping.",
      }),
    );
  const attachGroupTo = (projectKey: string) => {
    void linkProjects(group.memberProjects, projectKey)
      .then(() =>
        navigate({
          to: "/settings/projects",
          search: { project: projectKey, machine: undefined },
          hashScrollIntoView: false,
        }),
      )
      .catch(reportLinkFailure);
  };
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const projectNameEditedRef = useRef(false);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  // The colour marks every member so a thread in any of them resolves it without knowing the
  // grouping. It stays on this device: it describes the view, not the project.
  const projectAccentKeys = group.memberProjects.map(
    (member) => `${member.environmentId}:${member.id}`,
  );
  const setProjectAccentColor = useAccentColorStore((state) => state.setProjectColor);
  const projectAccentColor = useAccentColorStore(
    (state) => state.projectColors[`${representative.environmentId}:${representative.id}`] ?? null,
  );

  const reportFailure = (title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  const checkProjectAccess = (
    members: ReadonlyArray<SidebarProjectGroupMember>,
    failureTitle: string,
  ) => {
    const denied = members.find(
      (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
    );
    if (!denied) return null;
    const result = AsyncResult.failure<void, Error>(
      Cause.fail(
        new Error(
          `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
        ),
      ),
    );
    reportFailure(failureTitle, result);
    return result;
  };

  const updateAllMembers = async (
    input: Partial<{
      title: string;
      faviconPath: string | null;
      projectIcon: ProjectIconOverride | null;
      workspaceRoots: ReadonlyArray<ProjectWorkspace>;
    }>,
    failureTitle: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    const denied = checkProjectAccess(group.memberProjects, failureTitle);
    if (denied) return denied;
    const unavailable = group.memberProjects.find((member) => {
      const environment = environmentById.get(member.environmentId);
      return environment?.connection.phase !== "connected" || !environment.serverConfig;
    });
    if (unavailable) {
      const error = new Error(
        `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
      );
      const result: AtomCommandResult<void, unknown> = AsyncResult.failure(Cause.fail(error));
      reportFailure(failureTitle, result);
      return result;
    }
    for (const member of group.memberProjects) {
      const revoked = checkProjectAccess([member], failureTitle);
      if (revoked) return revoked;
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, ...input },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportFailure(
          group.memberProjects.length > 1
            ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
            : failureTitle,
          result,
        );
        return result;
      }
    }
    return AsyncResult.success(undefined);
  };

  const renameGroup = async (nextTitle: string, wasEdited: boolean) => {
    const title = nextTitle.trim();
    if (!title) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        group.memberProjects.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return;
    }
    await updateAllMembers({ title }, "Failed to rename project");
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: {
    faviconPath: string | null;
    projectIcon: ProjectIconOverride | null;
  }) => {
    if (savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateAllMembers(input, "Failed to update project icon");
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  const workspaceRoots: ReadonlyArray<ProjectWorkspace> = representative.workspaceRoots?.length
    ? representative.workspaceRoots
    : [{ path: representative.workspaceRoot }];
  const [isAddingWorkspaceRoot, setIsAddingWorkspaceRoot] = useState(false);
  const openDirectoryPicker = useOpenDirectoryCommandPalette();
  const addWorkspaceRoot = () => {
    if (isAddingWorkspaceRoot) return;
    openDirectoryPicker({
      environmentId: representative.environmentId,
      initialPath: representative.workspaceRoot,
      onSelect: async (path) => {
        const normalizedPath = path.replace(/[\\/]+$/, "") || path;
        if (workspaceRoots.some((root) => root.path === normalizedPath)) {
          toastManager.add({ type: "warning", title: "Directory is already in this project" });
          return;
        }
        setIsAddingWorkspaceRoot(true);
        await updateAllMembers(
          { workspaceRoots: [...workspaceRoots, { path: normalizedPath }] },
          "Failed to add project directory",
        );
        setIsAddingWorkspaceRoot(false);
      },
    });
  };
  const removeWorkspaceRoot = (path: string) => {
    if (workspaceRoots.length <= 1 || path === representative.workspaceRoot) return;
    void updateAllMembers(
      { workspaceRoots: workspaceRoots.filter((root) => root.path !== path) },
      "Failed to remove project directory",
    );
  };
  const setWorkspaceRootMode = (
    path: string,
    mode: NonNullable<ProjectWorkspace["defaultThreadEnvMode"]> | null,
  ) => {
    void updateAllMembers(
      {
        workspaceRoots: workspaceRoots.map((root) =>
          root.path === path ? { ...root, defaultThreadEnvMode: mode } : root,
        ),
      },
      "Failed to update directory workspace",
    );
  };

  const hasMultipleCheckouts = group.memberProjects.length > 1;

  const removeMembers = async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
    if (checkProjectAccess(members, "Failed to remove project")) return;
    const api = readLocalApi();
    if (!api) return;

    const { projectThreads, isWholeGroup, confirmationMessage } = planProjectRemoval({
      members,
      groupMemberCount: group.memberProjects.length,
      hasOtherMembers,
      displayName: group.displayName,
      threads,
      unloadedThreadCount: readUnloadedThreadCount(members, threads),
    });
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    if (checkProjectAccess(members, "Failed to remove project")) return;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportFailure(`Failed to remove "${member.title}"`, result);
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    if (isWholeGroup && !hasOtherMembers) {
      void navigate({
        to: "/settings/projects",
        search: ({ machine }) => ({ project: undefined, machine, checkout: undefined }),
        replace: true,
      });
    }
  };

  const checkoutsByEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of group.memberProjects) {
    const members = checkoutsByEnvironment.get(member.environmentId);
    if (members) members.push(member);
    else checkoutsByEnvironment.set(member.environmentId, [member]);
  }
  const checkoutRemoveButton = (member: SidebarProjectGroupMember) => (
    <Button
      size="sm"
      variant="outline"
      disabled={!editableIds.has(member.environmentId)}
      onClick={() => void removeMembers([member])}
      aria-label={`Remove checkout ${member.workspaceRoot}`}
    >
      Remove
    </Button>
  );
  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        if (checkoutsByEnvironment.size === 1) {
          return members.map((member) => (
            <SettingsRow
              key={member.physicalProjectKey}
              title={member.environmentLabel ?? "Environment"}
              description={member.workspaceRoot}
              control={checkoutRemoveButton(member)}
            />
          ));
        }
        const firstMember = members[0]!;
        const hasMultiple = members.length > 1;
        const environment = environmentById.get(environmentId);
        const labels = environment
          ? settingsScopeEnvironmentLabels(environment, environments)
          : { primary: firstMember.environmentLabel ?? "Environment", secondary: environmentId };
        return (
          <SettingsRow
            key={environmentId}
            title={labels.primary}
            description={
              <>
                {labels.secondary ? (
                  <span className="block truncate">{labels.secondary}</span>
                ) : null}
                {!hasMultiple ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate" />}>
                      {firstMember.workspaceRoot}
                    </TooltipTrigger>
                    <TooltipPopup>{firstMember.workspaceRoot}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </>
            }
            control={hasMultiple ? undefined : checkoutRemoveButton(firstMember)}
          >
            {hasMultiple ? (
              <div className="space-y-3 pb-2 pt-1">
                {members.map((member) => (
                  <div
                    key={member.physicalProjectKey}
                    className="flex min-w-0 items-center justify-between gap-3"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 truncate text-xs text-muted-foreground/80" />
                        }
                      >
                        {member.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{member.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                    <div className="shrink-0">{checkoutRemoveButton(member)}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <Alert variant="info">
          <InfoIcon aria-hidden />
          <AlertDescription>
            Can't find a setting? Keep this project picked above and hop to any other settings page.
          </AlertDescription>
        </Alert>
        <SettingsSection id="project-overview" title="Project" hideTitle>
          {!canEditGroup ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
              {group.memberProjects.length > 1
                ? "Shared settings require permission to change every checkout in this group."
                : "This connection cannot change this project."}
            </p>
          ) : null}
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                disabled={!canEditGroup}
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current;
                  projectNameEditedRef.current = false;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Project colour"
            description={
              accentColorLabel(projectAccentColor) ??
              "No colour. A colour washes this project's threads from the right while the sidebar shows every project."
            }
            resetAction={
              projectAccentColor !== null ? (
                <SettingResetButton
                  label="project colour"
                  onClick={() => setProjectAccentColor(projectAccentKeys, null)}
                />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {ACCENT_COLOR_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={projectAccentColor === option.id}
                    className={cn(
                      "size-5 cursor-pointer rounded-full border transition-transform",
                      projectAccentColor === option.id
                        ? "border-foreground scale-110"
                        : "border-border/70 hover:scale-110",
                    )}
                    style={{ backgroundColor: option.hex }}
                    onClick={() => setProjectAccentColor(projectAccentKeys, option.id)}
                  />
                ))}
                <label className="ms-1 inline-flex cursor-pointer items-center gap-1 text-xs text-secondary-label">
                  <input
                    type="color"
                    className="size-5 cursor-pointer rounded-full border border-border/70 bg-transparent p-0"
                    value={resolveAccentHex(projectAccentColor) ?? "#6b7a8f"}
                    aria-label="Custom project colour"
                    onChange={(event) =>
                      setProjectAccentColor(projectAccentKeys, event.target.value)
                    }
                  />
                  Custom
                </label>
              </div>
            }
          />
          <SettingsRow
            title="Project icon"
            description={
              projectIcon?.kind === "lucide"
                ? `${projectIcon.name} · ${projectIcon.color}`
                : projectIcon?.kind === "monogram"
                  ? `${projectIcon.text} · ${projectIcon.color}`
                  : projectIcon?.kind === "emoji"
                    ? projectIcon.emoji
                    : (faviconPath ?? "Automatic")
            }
            resetAction={
              group.memberProjects.some(
                (member) => member.faviconPath != null || member.projectIcon != null,
              ) ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => void setProjectIcon({ faviconPath: null, projectIcon: null })}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={representative} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
        </SettingsSection>
        <ProjectDefaultsSettings category="project" />
        <ProjectActionsSettings />
        {hasMultipleCheckouts ? checkoutChoices : null}
        <SettingsSection
          title="Directories"
          headerAction={
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={isAddingWorkspaceRoot}
              onClick={addWorkspaceRoot}
            >
              <FolderPlusIcon />
              Add directory
            </Button>
          }
        >
          <div className="space-y-1 px-3 py-2 sm:px-4">
            <p className="text-xs text-muted-foreground">
              Directories share this project context. The primary directory remains the default
              checkout for existing threads.
            </p>
            {workspaceRoots.map((root, index) => (
              <div
                key={root.path}
                className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/30 px-2 py-1.5"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {root.label ?? (index === 0 ? "Primary directory" : `Directory ${index + 1}`)}
                  </div>
                  <code className="block truncate text-[11px] text-muted-foreground">
                    {root.path}
                  </code>
                </div>
                <Select
                  value={root.defaultThreadEnvMode ?? "inherit"}
                  onValueChange={(value) => {
                    if (value === "local" || value === "worktree") {
                      setWorkspaceRootMode(root.path, value);
                    } else if (value === "inherit") {
                      setWorkspaceRootMode(root.path, null);
                    }
                  }}
                >
                  <SelectTrigger
                    className="h-7 w-28 text-[11px]"
                    aria-label={`Workspace for ${root.path}`}
                  >
                    <SelectValue>
                      {root.defaultThreadEnvMode
                        ? resolveEnvModeLabel(root.defaultThreadEnvMode)
                        : "Default"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="inherit">Default</SelectItem>
                    <SelectItem value="local">Current checkout</SelectItem>
                    <SelectItem value="worktree">Worktree</SelectItem>
                  </SelectPopup>
                </Select>
                {pathIsPrimary(root.path, representative.workspaceRoot) ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">Primary</span>
                ) : (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${root.path}`}
                    onClick={() => removeWorkspaceRoot(root.path)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </SettingsSection>
        <ProjectMemorySettings
          environmentId={representative.environmentId}
          projectId={representative.id}
        />
        {group.isScratch ? null : (
          <SettingsSection title="Grouping">
            <SettingsRow
              title="Show under another project"
              description="Makes these checkouts part of another project on this device. Use it for folders that have no Git remote to match by. Files and threads stay where they are."
              control={
                attachChoices.length === 0 ? (
                  <span className="text-sm text-secondary-label">No other projects</span>
                ) : (
                  <Select
                    value={null}
                    onValueChange={(value) => {
                      if (typeof value === "string") attachGroupTo(value);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Show under another project">
                      <SelectValue placeholder="Choose a project" />
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {attachChoices.map((candidate) => (
                        <SelectItem key={candidate.projectKey} value={candidate.projectKey}>
                          {candidate.displayName}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )
              }
            />
            {linkedMembers.map((member) => (
              <SettingsRow
                key={member.physicalProjectKey}
                title={`Attached by hand on ${member.environmentLabel ?? "Environment"}`}
                description={member.workspaceRoot}
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void linkProjects([member], null).catch(reportLinkFailure)}
                    aria-label={`Detach ${member.workspaceRoot}`}
                  >
                    Detach
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        )}
        <SettingsSection title="Danger">
          <SettingsRow
            title={
              hasOtherMembers
                ? "Remove checkout"
                : group.memberProjects.length > 1
                  ? "Remove this project everywhere"
                  : "Remove project"
            }
            description={
              hasOtherMembers
                ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
                : group.memberProjects.length > 1
                  ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                  : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!canEditGroup}
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {hasOtherMembers
                  ? "Remove checkout"
                  : group.memberProjects.length > 1
                    ? "Remove all entries"
                    : "Remove project"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditGroup ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={representative.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
