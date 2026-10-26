import { cn } from "../../lib/utils";

export type NiaPresence = "working" | "watching" | "error" | "off";

/**
 * Nia's mark: an open eye, with a dot that says whether it is working or watching.
 * Decorative: the activity line under the chat says the same in text.
 */
export function NiaAvatar({
  presence,
  className,
}: {
  presence?: NiaPresence | undefined;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-6 shrink-0", className)}>
      <svg viewBox="0 0 24 24" className="size-full">
        <circle cx="12" cy="12" r="12" className="fill-primary" />
        <path
          d="M4.5 12c1.9-3.2 4.4-4.8 7.5-4.8s5.6 1.6 7.5 4.8c-1.9 3.2-4.4 4.8-7.5 4.8S6.4 15.2 4.5 12Z"
          className="fill-primary-foreground"
        />
        <circle cx="12" cy="12" r="2.6" className="fill-primary" />
        <circle cx="13" cy="11" r="0.8" className="fill-primary-foreground" />
      </svg>
      {presence ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
            presence === "working" && "bg-amber-500",
            presence === "watching" && "bg-emerald-500",
            presence === "error" && "bg-destructive",
            presence === "off" && "bg-muted-foreground/60",
          )}
        />
      ) : null}
    </span>
  );
}
