// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const sources = [baseEnv, localEnv, rootEnv] as const;
  const clerkPublishableKey = firstNonEmpty(
    sources,
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );
  const clerkJwtTemplate = firstNonEmpty(
    sources,
    "T3CODE_CLERK_JWT_TEMPLATE",
    "VITE_CLERK_JWT_TEMPLATE",
    "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  );
  const clerkCliOAuthClientId = firstNonEmpty(
    sources,
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
  );
  const mobileOtlpTracesUrl = firstNonEmpty(
    sources,
    "T3CODE_MOBILE_OTLP_TRACES_URL",
    "EXPO_PUBLIC_OTLP_TRACES_URL",
  );
  const mobileOtlpTracesDataset = firstNonEmpty(
    sources,
    "T3CODE_MOBILE_OTLP_TRACES_DATASET",
    "EXPO_PUBLIC_OTLP_TRACES_DATASET",
  );
  const mobileOtlpTracesToken = firstNonEmpty(
    sources,
    "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
    "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
  );

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(clerkPublishableKey
      ? {
          T3CODE_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
        }
      : {}),
    ...(clerkJwtTemplate
      ? {
          T3CODE_CLERK_JWT_TEMPLATE: clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: clerkJwtTemplate,
        }
      : {}),
    ...(clerkCliOAuthClientId
      ? {
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: clerkCliOAuthClientId,
        }
      : {}),
    ...(mobileOtlpTracesUrl
      ? {
          T3CODE_MOBILE_OTLP_TRACES_URL: mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: mobileOtlpTracesUrl,
        }
      : {}),
    ...(mobileOtlpTracesDataset
      ? {
          T3CODE_MOBILE_OTLP_TRACES_DATASET: mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: mobileOtlpTracesDataset,
        }
      : {}),
    ...(mobileOtlpTracesToken
      ? {
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: mobileOtlpTracesToken,
        }
      : {}),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
