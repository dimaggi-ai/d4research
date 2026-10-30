/** Install only on mobile. Reserve the outermost edge for the browser's back gesture. */
export function installSidebarSwipe(
  target: Document,
  options: { open: boolean; onOpenChange: (open: boolean) => void },
): () => void {
  let gesture: { id: number; x: number; y: number; startedAt: number } | null = null;
  const cancel = () => {
    gesture = null;
  };
  const start = (event: TouchEvent) => {
    cancel();
    const touch = event.touches[0];
    if (event.defaultPrevented || event.touches.length !== 1 || !touch) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    const sidebar = element.closest('[data-sidebar="sidebar"][data-mobile="true"]');
    if (options.open ? !sidebar : touch.clientX < 16 || touch.clientX > 56) return;
    if (
      element.closest(
        'input, textarea, select, button, a, [contenteditable="true"], [role="slider"], [data-thread-item], .xterm',
      )
    )
      return;
    if (!sidebar && element.closest('[role="dialog"], [role="alertdialog"]')) return;
    // Horizontal code/table/file views retain their own pan gesture.
    for (
      let node: Element | null = element;
      node && node !== target.body;
      node = node.parentElement
    ) {
      if (
        node.scrollWidth > node.clientWidth + 1 &&
        /auto|scroll/.test(getComputedStyle(node).overflowX)
      )
        return;
    }
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      startedAt: event.timeStamp,
    };
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    const touch = Array.from(event.touches).find((touch) => touch.identifier === gesture?.id);
    if (!touch || event.touches.length !== 1) return cancel();
    const dx = (touch.clientX - gesture.x) * (options.open ? -1 : 1);
    const dy = Math.abs(touch.clientY - gesture.y);
    if (dx < -12 || (dy > 12 && dy > dx)) return cancel();
    if (dx > 12 && dx > dy * 1.5 && event.cancelable) event.preventDefault();
  };
  const end = (event: TouchEvent) => {
    const initial = gesture;
    cancel();
    if (!initial) return;
    const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === initial.id);
    if (!touch || event.touches.length > 0) return;
    const dx = (touch.clientX - initial.x) * (options.open ? -1 : 1);
    const dy = Math.abs(touch.clientY - initial.y);
    if (dx >= 64 && dx > dy * 1.5 && event.timeStamp - initial.startedAt <= 700) {
      options.onOpenChange(!options.open);
    }
  };
  target.addEventListener("touchstart", start, { passive: true });
  target.addEventListener("touchmove", move, { passive: false });
  target.addEventListener("touchend", end);
  target.addEventListener("touchcancel", cancel);
  return () => {
    target.removeEventListener("touchstart", start);
    target.removeEventListener("touchmove", move);
    target.removeEventListener("touchend", end);
    target.removeEventListener("touchcancel", cancel);
  };
}
