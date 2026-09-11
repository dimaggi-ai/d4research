export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex flex-col items-center justify-center gap-3"
        aria-label="d4research splash screen"
      >
        <img alt="d4" className="size-16 object-contain" src="/d4-mark.svg" />
        <span className="text-sm text-muted-foreground">[Research]</span>
      </div>
    </div>
  );
}
