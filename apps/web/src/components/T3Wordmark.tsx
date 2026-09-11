import type { SVGProps } from "react";

// Keep the inherited component API; artwork comes from the canonical d4 asset.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <image href="/d4-mark.svg" width="64" height="64" />
    </svg>
  );
}
