import {
  createContext,
  use,
  useImperativeHandle,
  type ReactNode,
  type ComponentProps,
  type Ref,
} from "react";
import { useThreadFind } from "./useThreadFind";
import { ThreadFindBar } from "./ThreadFindBar";
import { ChatCanvas } from "./ChatCanvas";

type Find = ReturnType<typeof useThreadFind>;
export type ThreadFindControls = Pick<Find, "open" | "close">;
export const ThreadFindTimelineContext = createContext<Find["timelineProps"] | null>(null);
const ThreadFindBarContext = createContext<Find["barProps"] | null>(null);

export function ThreadFindCanvas({
  findOptions,
  controlsRef,
  isOpen,
  onOpenChange,
  ...canvasProps
}: ComponentProps<typeof ChatCanvas> & {
  findOptions: Omit<Parameters<typeof useThreadFind>[0], "isOpen" | "onOpenChange">;
  controlsRef: Ref<ThreadFindControls>;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ThreadFindProvider
      {...findOptions}
      controlsRef={controlsRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      <ChatCanvas {...canvasProps} />
    </ThreadFindProvider>
  );
}

/** Owns search updates below the chat view so cycling does not rerender the composer and panels. */
function ThreadFindProvider({
  controlsRef,
  isOpen,
  onOpenChange,
  children,
  ...options
}: Omit<Parameters<typeof useThreadFind>[0], "isOpen" | "onOpenChange"> & {
  controlsRef: Ref<ThreadFindControls>;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const find = useThreadFind({ ...options, isOpen, onOpenChange });
  useImperativeHandle(controlsRef, () => ({ open: find.open, close: find.close }), [
    find.open,
    find.close,
  ]);
  return (
    <ThreadFindBarContext value={find.barProps}>
      <ThreadFindTimelineContext value={find.timelineProps}>{children}</ThreadFindTimelineContext>
    </ThreadFindBarContext>
  );
}

export function ThreadFind({ onClose }: { onClose: () => void }) {
  const bar = use(ThreadFindBarContext);
  if (!bar) return null;
  return (
    <ThreadFindBar
      {...bar}
      onClose={() => {
        bar.onClose();
        onClose();
      }}
    />
  );
}
