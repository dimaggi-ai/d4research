import type {
  D4AgentSettings,
  D4BrainContext,
  ProjectId,
  ScheduledTaskSchedule,
} from "@d4research/contracts";

export function routineInContext(
  projectId: ProjectId,
  context: D4BrainContext,
  mappings: D4AgentSettings["projectContexts"],
): boolean {
  return context === "Global" || mappings[projectId] === context;
}

export function routineScheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") return `Every ${schedule.everyMs / 1000} seconds`;
  const days = schedule.weekdays?.length
    ? schedule.weekdays
        .map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day])
        .join(", ")
    : "Daily";
  return `${days} at ${schedule.timeOfDay} (server time)`;
}
