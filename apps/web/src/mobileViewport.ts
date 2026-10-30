/** Keep the phone workspace inside Safari's visible, potentially panned viewport. */
export function installMobileViewport(target: Window): () => void {
  const viewport = target.visualViewport;
  if (!viewport) return () => {};
  const root = target.document.documentElement;
  const properties = ["--app-viewport-height", "--app-viewport-top", "--app-safe-area-bottom"];
  const previous = properties.map((property) => root.style.getPropertyValue(property));
  let frame: number | null = null;
  const update = () => {
    frame = null;
    // Ignore pinch zoom: resizing the workspace would fight browser magnification.
    if (viewport.scale !== 1 || viewport.height <= 0) return;
    root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
    root.style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
    root.style.setProperty(
      "--app-safe-area-bottom",
      target.innerHeight - viewport.height > 150 ? "0px" : "env(safe-area-inset-bottom)",
    );
  };
  const schedule = () => {
    if (frame === null) frame = target.requestAnimationFrame(update);
  };
  update();
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  target.addEventListener("resize", schedule);
  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    target.removeEventListener("resize", schedule);
    if (frame !== null) target.cancelAnimationFrame(frame);
    properties.forEach((property, index) => {
      const value = previous[index];
      if (value) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    });
  };
}
