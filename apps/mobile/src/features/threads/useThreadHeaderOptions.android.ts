import { useMemo } from "react";
import type { useThreadHeaderOptions as useIosThreadHeaderOptions } from "./useThreadHeaderOptions";

export function useThreadHeaderOptions(
  props: Parameters<typeof useIosThreadHeaderOptions>[0],
): ReturnType<typeof useIosThreadHeaderOptions> {
  return useMemo(
    () => ({
      options: { contentStyle: { backgroundColor: props.headerColor } },
      // Android renders header actions as children, not native item factories.
      optionsVersion: [],
      sidebar: true,
      fallback: null,
    }),
    [props.headerColor],
  );
}
