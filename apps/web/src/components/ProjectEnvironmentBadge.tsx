import type { EnvironmentId, EnvironmentMachineKind } from "@d4research/contracts";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ProjectEnvironmentBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  const members = props.group.memberProjects
    .map((member) => ({
      ...member,
      environmentLabel:
        member.environmentLabel ??
        (member.environmentId === props.primaryEnvironmentId ? "This machine" : "Remote"),
    }))
    .sort((a, b) => a.environmentLabel.localeCompare(b.environmentLabel));
  const first =
    members.find((member) => member.environmentId === props.primaryEnvironmentId) ?? members[0];
  if (!first) return null;
  const labels = members
    .map((member) => member.environmentLabel)
    .filter((label, index, all) => all.indexOf(label) === index)
    .join(", ");
  const description = `On ${labels}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={description}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
          />
        }
      >
        <EnvironmentMachineIcon
          aria-hidden
          kind={props.machineByEnvironmentId.get(first.environmentId) ?? "server"}
          className="size-3.5"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
