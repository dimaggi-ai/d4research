import { GitBranchIcon } from "lucide-react";
import { cn } from "../../lib/utils";

const hues = [
  "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:bg-sky-500/20 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 ring-violet-500/30 dark:bg-violet-500/20 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:bg-amber-500/20 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:bg-rose-500/20 dark:text-rose-300",
  "bg-teal-500/15 text-teal-700 ring-teal-500/30 dark:bg-teal-500/20 dark:text-teal-300",
  "bg-fuchsia-500/15 text-fuchsia-700 ring-fuchsia-500/30 dark:bg-fuchsia-500/20 dark:text-fuchsia-300",
  "bg-orange-500/15 text-orange-700 ring-orange-500/30 dark:bg-orange-500/20 dark:text-orange-300",
  "bg-lime-500/15 text-lime-700 ring-lime-500/30 dark:bg-lime-500/20 dark:text-lime-300",
];

function agentHue(id: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++)
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  return hues[((hash ^ (hash >>> 13)) >>> 0) % hues.length]!;
}

/** Hue follows the agent id, so an agent keeps its color across selections and reloads. */
export function AgentCommunicationAvatar(props: {
  readonly id: string;
  readonly label: string;
  readonly coordinator?: boolean;
  readonly size?: "xs" | "sm" | "md";
}) {
  const size = props.size ?? "sm";
  return (
    <span
      aria-hidden
      className={cn(
        agentHue(props.id),
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none",
        "ring-1 ring-inset",
        props.coordinator &&
          "bg-primary/12 text-primary ring-primary/30 dark:bg-primary/20 dark:text-primary",
        size === "xs" && "size-4 text-4xs",
        size === "sm" && "size-6 text-2xs",
        size === "md" && "size-8 text-xs",
      )}
    >
      {props.coordinator ? (
        <GitBranchIcon
          className={size === "md" ? "size-4" : size === "xs" ? "size-2.5" : "size-3"}
        />
      ) : (
        props.label.trim().charAt(0).toLocaleUpperCase() || "?"
      )}
    </span>
  );
}
