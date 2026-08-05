import { XIcon } from "lucide-react";

import type { QueuedChatRequest } from "../../requestQueueStore";

export function QueuedRequestsBanner(props: {
  readonly requests: ReadonlyArray<QueuedChatRequest>;
  readonly onRemove: (requestId: string) => void;
}) {
  if (props.requests.length === 0) return null;

  return (
    <div className="border-b border-border/50 px-3 py-2" data-chat-request-queue="true">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">
        Queued · {props.requests.length}
      </div>
      <div className="flex flex-col gap-1">
        {props.requests.map((request, index) => (
          <div
            key={request.id}
            className="flex min-w-0 items-center gap-2 rounded-md bg-muted/45 px-2 py-1 text-xs"
          >
            <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
            <span className="min-w-0 flex-1 truncate">{request.text}</span>
            <button
              type="button"
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Remove queued request ${index + 1}`}
              onClick={() => props.onRemove(request.id)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
