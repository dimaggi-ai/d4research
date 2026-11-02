// @effect-diagnostics globalTimers:off - Display timing for React hooks, outside an Effect runtime.

const STATUS_SHOW_DELAY_MS = 400;
const STATUS_MIN_VISIBLE_MS = 400;

/**
 * A status shows only after it has stayed set for a moment, then stays shown
 * for a minimum time so a quick flicker never flashes on screen.
 * `deadlinePassed` tells whether `delayedStatusDeadline(state)` has been reached.
 */
export type DelayedStatusState<A> =
  | { readonly phase: "idle"; readonly key: string }
  | { readonly phase: "pending"; readonly key: string; readonly showAt: number }
  | {
      readonly phase: "shown";
      readonly key: string;
      readonly value: A;
      readonly holdUntil: number;
    };

export interface DelayedStatusInput<A> {
  readonly key: string;
  /** Compared by identity, so use strings or other stable values. */
  readonly value: A | null;
  readonly deadlinePassed: boolean;
  readonly showDelayMs?: number | undefined;
}

/**
 * Returns `state` itself when nothing changes, so it can run on every render.
 * `now` is read only to stamp a new deadline; it is a function so a memoizing
 * caller (the React Compiler) cannot cache a stale clock reading.
 */
export function stepDelayedStatus<A>(
  state: DelayedStatusState<A> | null,
  { key, value, deadlinePassed, showDelayMs = STATUS_SHOW_DELAY_MS }: DelayedStatusInput<A>,
  now: () => number,
): DelayedStatusState<A> {
  const idle = (): DelayedStatusState<A> => ({ phase: "idle", key });
  const pending = (): DelayedStatusState<A> => ({
    phase: "pending",
    key,
    showAt: now() + showDelayMs,
  });
  const shown = (shownValue: A): DelayedStatusState<A> => ({
    phase: "shown",
    key,
    value: shownValue,
    holdUntil: now() + STATUS_MIN_VISIBLE_MS,
  });

  if (state === null || state.key !== key) return value === null ? idle() : pending();
  switch (state.phase) {
    case "idle":
      return value === null ? state : pending();
    case "pending":
      if (value === null) return idle();
      return deadlinePassed ? shown(value) : state;
    case "shown":
      if (value === null) return deadlinePassed ? idle() : state;
      return value === state.value ? state : shown(value);
  }
}

export function delayedStatusDeadline<A>(state: DelayedStatusState<A>): number | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "pending":
      return state.showAt;
    case "shown":
      return state.holdUntil;
  }
}

export function shownDelayedStatus<A>(state: DelayedStatusState<A>, key: string): A | null {
  return state.phase === "shown" && state.key === key ? state.value : null;
}

/**
 * Values compare by identity, so use strings or other stable values.
 */
export function createDelayedStatus<A>(
  onChange: (shown: ShownStatus<A> | null) => void,
): DelayedStatus<A> {
  let key = "";
  let latest: A | null = null;
  let shown: A | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const hide = () => {
    shown = null;
    onChange(null);
  };
  const show = (value: A) => {
    shown = value;
    onChange({ key, value });
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      if (latest === null) hide();
    }, STATUS_MIN_VISIBLE_MS);
  };

  return {
    update: (nextKey, value) => {
      if (nextKey !== key) {
        key = nextKey;
        clearTimer();
        if (shown !== null) hide();
      }
      latest = value;

      if (shown === null) {
        if (value === null) {
          clearTimer();
        } else if (timer === undefined) {
          timer = setTimeout(() => {
            timer = undefined;
            if (latest !== null) show(latest);
          }, STATUS_SHOW_DELAY_MS);
        }
        return;
      }

      if (value !== null) {
        if (value !== shown) show(value);
      } else if (timer === undefined) {
        hide();
      }
    },
    dispose: clearTimer,
  };
}

export interface ShownStatus<A> {
  readonly key: string;
  readonly value: A;
}

export interface DelayedStatus<A> {
  readonly update: (key: string, value: A | null) => void;
  readonly dispose: () => void;
}
