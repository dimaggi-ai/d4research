export const PWA_BUILD_ID_PLACEHOLDER = "__T3CODE_BUILD_ID__";

export function stampPwaServiceWorker(source: string, buildId: string): string {
  const normalizedBuildId = buildId.trim();
  if (!normalizedBuildId) {
    throw new Error("PWA service worker build id must not be empty.");
  }
  if (!source.includes(PWA_BUILD_ID_PLACEHOLDER)) {
    throw new Error("PWA service worker build-id placeholder was not found.");
  }
  return source.replaceAll(PWA_BUILD_ID_PLACEHOLDER, normalizedBuildId);
}
