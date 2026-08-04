import { MicIcon, SquareIcon } from "lucide-react";

import {
  type VoiceConversationStatus,
  voiceConversationStatusCopy,
} from "../../hooks/useVoiceConversation";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

type VoiceConversationControlProps = {
  active: boolean;
  status: VoiceConversationStatus;
  hasOriginalReply?: boolean;
  disabled?: boolean;
  onToggle: () => void;
};

export function VoiceConversationButton({
  active,
  disabled,
  onToggle,
}: VoiceConversationControlProps) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={active ? "destructive" : "outline"}
      className="shrink-0 rounded-full"
      aria-label={active ? "Stop voice conversation" : "Start voice conversation"}
      aria-pressed={active}
      data-voice-conversation-button="true"
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      {active ? <SquareIcon className="size-3" /> : <MicIcon className="size-3.5" />}
    </Button>
  );
}

export function VoiceConversationBanner({
  active,
  status,
  hasOriginalReply,
  onToggle,
}: VoiceConversationControlProps) {
  if (!active) return null;
  const copy = voiceConversationStatusCopy[status];
  const detail =
    status === "listening" && hasOriginalReply
      ? "Speak, or say “read the original” to hear the full reply"
      : copy.detail;

  return (
    <div
      role="status"
      aria-live="polite"
      data-voice-conversation-status={status}
      className="mx-2.5 mb-2 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 sm:mx-3"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          status === "listening" ? "bg-emerald-500" : "bg-primary",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{copy.label}</div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      </div>
      <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={onToggle}>
        Stop
      </Button>
    </div>
  );
}
