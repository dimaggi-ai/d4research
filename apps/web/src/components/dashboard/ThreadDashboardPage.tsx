import styles from "./threadDashboard.module.css";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

import { Link } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  CheckIcon,
  CircleAlertIcon,
  GitBranchIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LaptopIcon,
  SearchIcon,
  Settings2Icon,
} from "lucide-react";
import { scopeThreadRef } from "@d4research/client-runtime/environment";
import { useClientSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useSidebarProjectScope } from "../../hooks/useSidebarProjectScope";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironments, useEnvironmentProviders } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { isElectron } from "../../env";
import { ProjectFavicon } from "../ProjectFavicon";
import { RelativeTime } from "../RelativeTime";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { useSidebarProjectGroups } from "../sidebar/useSidebarProjectGroups";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import {
  collectDashboardItems,
  filterDashboardItems,
  type DashboardItem,
  type DashboardStatus,
} from "./dashboard.logic";

const Filters = Schema.Struct({
  environment: Schema.String,
  project: Schema.String,
  query: Schema.String,
  reviewed: Schema.Boolean,
});
const DEFAULT_FILTERS = { environment: "all", project: "all", query: "", reviewed: false };
const STATES = ["working", "monitoring", "ready"] as const;
const LABELS = {
  working: "Working",
  monitoring: "Monitoring",
  ready: "Ready",
  reviewed: "Reviewed",
};
const NOTES = {
  working: "Active turns and threads needing input",
  monitoring: "Background work or a watch is active",
  ready: "Finished · result not read yet",
};

function Status({ status }: { status: DashboardStatus }) {
  return (
    <span className={cn(styles["dashboard-status"], styles[`dashboard-status-${status}`])}>
      {status === "reviewed" ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <span className={styles["dashboard-status-dot"]} />
      )}
      {LABELS[status]}
    </span>
  );
}

export function ThreadDashboardPage() {
  const threads = useQuietThreadShells();
  const { projectGroups } = useSidebarProjectGroups();
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const localVisits = useUiStateStore((state) => state.threadLastVisitedAtById);
  const layout = useClientSettings((settings) => settings.dashboardLayout);
  const [, setProjectScope] = useSidebarProjectScope();
  const { isMobile, setOpenMobile } = useSidebar();
  const now = useNowMinute();
  const [filters, setFilters] = useLocalStorage(
    "t3code:thread-dashboard-filters:v1",
    DEFAULT_FILTERS,
    Filters,
  );
  const labels = new Map<string, string>(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const connected = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const collected = collectDashboardItems({
    threads,
    projects: projectGroups,
    localVisits,
    now: Date.parse(`${now}Z`),
  });
  const items = filterDashboardItems(collected, filters, labels);
  const active = items.filter((item) => item.status !== "reviewed");
  const reviewed = items.filter((item) => item.status === "reviewed");
  const projectItems = new Map<string, DashboardItem[]>();
  for (const item of active) {
    const group = projectItems.get(item.project.projectKey) ?? [];
    group.push(item);
    projectItems.set(item.project.projectKey, group);
  }

  const counts = Object.fromEntries(
    STATES.map((state) => [state, active.filter((item) => item.status === state).length]),
  );
  const selectedProject = projectGroups.find((project) => project.projectKey === filters.project);
  const change = (patch: Partial<typeof DEFAULT_FILTERS>) =>
    setFilters((current) => ({ ...current, ...patch }));

  const prepareNavigation = (event: MouseEvent<HTMLAnchorElement>, item: DashboardItem) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    setProjectScope(item.project.projectKey);
    useThreadSelectionStore.getState().clearSelection();
    if (isMobile) setOpenMobile(false);
  };
  const renderCard = (item: DashboardItem, compact = false) => {
    const thread = item.thread;
    const provider = providers
      .get(thread.environmentId)
      ?.find((entry) => entry.instanceId === thread.modelSelection.instanceId);
    const model = provider?.models.find(
      (candidate) => candidate.slug === thread.modelSelection.model,
    );
    const physicalProject =
      item.project.memberProjects.find(
        (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
      ) ?? item.project;
    return (
      <Link
        key={item.key}
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
        onClick={(event) => prepareNavigation(event, item)}
        className={cn(styles["dashboard-card"], compact && styles["dashboard-card-compact"])}
        data-dashboard-card=""
        data-state={item.status}
        data-attention={item.attention !== null}
        aria-label={`Open ${thread.title}, ${item.project.displayName}, ${labels.get(thread.environmentId) ?? thread.environmentId}`}
      >
        <div className={styles["dashboard-card-top"]}>
          <span className={styles["dashboard-card-project"]}>
            <ProjectFavicon project={physicalProject} />
            <span>{item.project.displayName}</span>
          </span>
          <time dateTime={item.timestamp}>
            <RelativeTime timestamp={item.timestamp} />
          </time>
        </div>
        <h3>{thread.title}</h3>
        <p className={styles["dashboard-card-description"]}>{item.description}</p>
        {item.attention ? (
          <div className={styles["dashboard-card-attention"]}>
            <CircleAlertIcon aria-hidden="true" />
            {item.attention}
          </div>
        ) : item.status === "ready" ? (
          <div className={styles["dashboard-card-unread"]}>
            <CheckIcon aria-hidden="true" />
            Result unread
          </div>
        ) : null}
        {thread.branch ? (
          <div className={styles["dashboard-card-branch"]}>
            <GitBranchIcon aria-hidden="true" />
            <span>{thread.branch}</span>
          </div>
        ) : null}
        <div className={styles["dashboard-card-footer"]}>
          <Tooltip>
            <TooltipTrigger render={<span className={styles["dashboard-environment"]} />}>
              <LaptopIcon aria-hidden="true" />
              <span>{labels.get(thread.environmentId) ?? thread.environmentId}</span>
              {!connected.has(thread.environmentId) ? (
                <span className={styles["dashboard-offline"]}>Offline</span>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {connected.has(thread.environmentId)
                ? "Connected environment"
                : "Disconnected · showing last known activity"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span className={styles["dashboard-card-model"]} />}>
              {provider ? (
                <ProviderInstanceIcon
                  driverKind={provider.driver}
                  displayName={provider.displayName ?? provider.instanceId}
                  accentColor={provider.accentColor}
                  size="compact"
                />
              ) : null}
              <span>
                {model?.name ?? thread.modelSelection.model}
                {provider ? ` · ${provider.displayName ?? provider.instanceId}` : ""}
              </span>
            </TooltipTrigger>
            <TooltipPopup>
              {model?.name ?? thread.modelSelection.model}
              {provider ? ` · ${provider.displayName ?? provider.instanceId}` : ""}
            </TooltipPopup>
          </Tooltip>
        </div>
        <ArrowRightIcon aria-hidden="true" className={styles["dashboard-card-open"]} />
      </Link>
    );
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LayoutDashboardIcon className="size-4" />
            Dashboard
          </div>
          <div className="ml-auto no-drag">
            <Button
              variant="ghost"
              size="sm"
              render={<Link to="/settings/appearance" hash="dashboard-layout" />}
            >
              <Settings2Icon />
              Appearance
            </Button>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            <div className={styles["thread-dashboard"]} data-layout={layout}>
              <header className={styles["dashboard-heading"]}>
                <div>
                  <h1>On deck</h1>
                  <p>Running work and unread results, across every project.</p>
                </div>
                <span className={styles["dashboard-connection-summary"]}>
                  {connected.size} of {environments.length} environments connected
                </span>
              </header>
              <div className={styles["dashboard-counts"]} aria-label="Thread counts">
                {STATES.map((state) => (
                  <div key={state}>
                    <strong>{counts[state]}</strong>
                    <Status status={state} />
                  </div>
                ))}
              </div>
              <div className={styles["dashboard-filters"]}>
                <div className={styles["dashboard-filter"]}>
                  <Select
                    value={filters.environment}
                    onValueChange={(value) => value && change({ environment: value })}
                  >
                    <SelectTrigger size="compact" aria-label="Environment filter">
                      <SelectValue>
                        <span className={styles["dashboard-picker-value"]}>
                          <LaptopIcon />
                          <span>
                            {filters.environment === "all"
                              ? "All environments"
                              : (labels.get(filters.environment) ?? "Unavailable environment")}
                          </span>
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="all">
                        <span className={styles["dashboard-picker-value"]}>
                          <LayersIcon />
                          All environments
                        </span>
                      </SelectItem>
                      {environments.map((environment) => (
                        <SelectItem
                          key={environment.environmentId}
                          value={environment.environmentId}
                        >
                          <span className={styles["dashboard-picker-value"]}>
                            <LaptopIcon />
                            {environment.label}
                            {environment.connection.phase !== "connected" ? " · Offline" : ""}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className={styles["dashboard-filter"]}>
                  <Select
                    value={filters.project}
                    onValueChange={(value) => value && change({ project: value })}
                  >
                    <SelectTrigger size="compact" aria-label="Project filter">
                      <SelectValue>
                        <span className={styles["dashboard-picker-value"]}>
                          {selectedProject ? (
                            <ProjectFavicon project={selectedProject} />
                          ) : (
                            <LayersIcon />
                          )}
                          <span>
                            {filters.project === "all"
                              ? "All projects"
                              : (selectedProject?.displayName ?? "Unavailable project")}
                          </span>
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="all">
                        <span className={styles["dashboard-picker-value"]}>
                          <LayersIcon />
                          All projects
                        </span>
                      </SelectItem>
                      {projectGroups.map((project) => (
                        <SelectItem key={project.projectKey} value={project.projectKey}>
                          <span className={styles["dashboard-picker-value"]}>
                            <ProjectFavicon project={project} />
                            <span className={styles["dashboard-picker-label"]}>
                              <span>{project.displayName}</span>
                              <small>
                                {[
                                  ...new Set(
                                    project.memberProjects.map(
                                      (member) =>
                                        labels.get(member.environmentId) ?? member.environmentId,
                                    ),
                                  ),
                                ].join(" · ")}
                              </small>
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <label className={styles["dashboard-reviewed-toggle"]}>
                  <Checkbox
                    checked={filters.reviewed}
                    onCheckedChange={(value) => change({ reviewed: value })}
                  />
                  Recently reviewed
                </label>
                <div className={styles["dashboard-search"]}>
                  <SearchIcon aria-hidden="true" />
                  <Input
                    type="search"
                    aria-label="Find a thread"
                    placeholder="Find a thread…"
                    value={filters.query}
                    onChange={(event) => change({ query: event.target.value })}
                  />
                </div>
                {filters.environment !== "all" || filters.project !== "all" || filters.query ? (
                  <Button variant="ghost" size="xs" onClick={() => setFilters(DEFAULT_FILTERS)}>
                    Clear filters
                  </Button>
                ) : null}
              </div>
              {environments.some((environment) => environment.connection.phase !== "connected") ? (
                <p className={styles["dashboard-offline-note"]}>
                  Disconnected environments show their last known activity.
                </p>
              ) : null}
              {layout === "board" ? (
                <div className={styles["dashboard-board"]}>
                  {STATES.map((state) => (
                    <section key={state} aria-label={`${LABELS[state]} threads`}>
                      <div className={styles["dashboard-column-heading"]}>
                        <Status status={state} />
                        <span>{counts[state]}</span>
                      </div>
                      <p className={styles["dashboard-column-note"]}>{NOTES[state]}</p>
                      <div className={styles["dashboard-cards"]}>
                        {active
                          .filter((item) => item.status === state)
                          .map((item) => renderCard(item))}
                        {!counts[state] ? (
                          <div className={styles["dashboard-empty"]}>
                            {state === "ready"
                              ? "You’re all caught up."
                              : "No threads in this state."}
                          </div>
                        ) : null}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div
                  className={styles["dashboard-project-lanes"]}
                  role="group"
                  aria-label="Projects by status"
                >
                  <div className={styles["dashboard-lanes-heading"]}>Project</div>
                  {STATES.map((state) => (
                    <div key={state} className={styles["dashboard-lanes-heading"]}>
                      <Status status={state} />
                      <span>{counts[state]}</span>
                    </div>
                  ))}
                  {projectGroups
                    .filter((project) => projectItems.has(project.projectKey))
                    .map((project) => (
                      <div className={styles["dashboard-project-lane"]} key={project.projectKey}>
                        <div className={styles["dashboard-lane-project"]}>
                          <ProjectFavicon project={project} className="size-5" />
                          <strong>{project.displayName}</strong>
                          <span>
                            {[
                              ...new Set(
                                (projectItems.get(project.projectKey) ?? []).map(
                                  (item) =>
                                    labels.get(item.thread.environmentId) ??
                                    item.thread.environmentId,
                                ),
                              ),
                            ].join(" · ")}
                          </span>
                        </div>
                        {STATES.map((state) => (
                          <section
                            key={state}
                            className={styles["dashboard-lane-cell"]}
                            aria-label={`${project.displayName} ${LABELS[state]}`}
                          >
                            <div className={styles["dashboard-lane-mobile-label"]}>
                              <Status status={state} />
                            </div>
                            <div className={styles["dashboard-cards"]}>
                              {(projectItems.get(project.projectKey) ?? [])
                                .filter((item) => item.status === state)
                                .map((item) => renderCard(item, true))}
                            </div>
                          </section>
                        ))}
                      </div>
                    ))}
                  {active.length === 0 ? (
                    <div className={cn(styles["dashboard-lanes-empty"], styles["dashboard-empty"])}>
                      No threads match this view.
                    </div>
                  ) : null}
                </div>
              )}
              {filters.reviewed ? (
                <section
                  className={styles["dashboard-reviewed"]}
                  data-dashboard-reviewed=""
                  aria-label="Recently reviewed"
                >
                  <h2>
                    Recently reviewed <span>{reviewed.length}</span>
                  </h2>
                  <p>Completed in the last 24 hours · already reviewed.</p>
                  <div className={styles["dashboard-reviewed-cards"]}>
                    {reviewed.slice(0, 100).map((item) => renderCard(item, true))}
                    {reviewed.length === 0 ? (
                      <div className={styles["dashboard-empty"]}>
                        No reviewed results in this view.
                      </div>
                    ) : null}
                  </div>
                  {reviewed.length > 100 ? (
                    <p>Showing the 100 most recent reviewed threads.</p>
                  ) : null}
                </section>
              ) : null}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
