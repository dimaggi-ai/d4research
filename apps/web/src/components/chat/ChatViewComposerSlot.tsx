import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ChatViewComposerSlot({
  composer,
  children,
}: {
  composer: ReactNode;
  children: (slot: ReactNode) => ReactNode;
}) {
  const [container] = useState(() => document.createElement("div"));
  // The portal keeps draft state alive while a new thread's shell has no layout to host it.
  return (
    <>
      {children(<ComposerMount container={container} />)}
      {createPortal(composer, container)}
    </>
  );
}

function ComposerMount({ container }: { container: HTMLDivElement }) {
  const host = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attach the persistent composer DOM to the current timeline host without resetting its draft.
  useLayoutEffect(() => {
    host.current?.appendChild(container);
    return () => container.remove();
  }, [container]);
  return <div ref={host} />;
}
