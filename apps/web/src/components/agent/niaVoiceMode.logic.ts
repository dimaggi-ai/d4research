import type { ChatAttachment, D4AgentTranscriptEntry, ThreadId } from "@d4research/contracts";

export type NiaVoiceArtifact =
  | { readonly kind: "attachment"; readonly key: string; readonly attachment: ChatAttachment }
  | { readonly kind: "thread"; readonly key: string; readonly threadId: ThreadId; label: string }
  | {
      readonly kind: "artifact" | "link";
      readonly key: string;
      readonly href: string;
      label: string;
    }
  | { readonly kind: "file"; readonly key: string; readonly path: string; readonly label: string };

const MAX_ARTIFACTS = 8;
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

function trimUrl(url: string): string {
  return url.replace(/[).,;:!?'"\]]+$/, "");
}

function linkLabel(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/\/$/, "");
    return path && path !== "/" ? `${url.host}${path}` : url.host;
  } catch {
    return href;
  }
}

function basename(path: string): string {
  return (
    path
      .replace(/:\d+(?::\d+)?$/, "")
      .split("/")
      .findLast(Boolean) ?? path
  );
}

function isFilePath(value: string): boolean {
  const path = value.replace(/:\d+(?::\d+)?$/, "");
  return (
    /^(?:~|\/)[^\s`]*$/.test(path) &&
    !path.startsWith("//") &&
    path.split("/").filter(Boolean).length >= 2 &&
    FILE_EXTENSION.test(path)
  );
}

/**
 * The things in a Nia reply worth a card in voice mode: attachments, linked
 * threads, URLs (claude.ai artifacts singled out), and absolute file paths.
 * Code blocks are skipped so a shell snippet's paths do not become cards.
 */
export function niaVoiceArtifacts(entry: D4AgentTranscriptEntry): NiaVoiceArtifact[] {
  const artifacts: NiaVoiceArtifact[] = [];
  const seen = new Set<string>();
  const add = (artifact: NiaVoiceArtifact) => {
    if (seen.has(artifact.key) || artifacts.length >= MAX_ARTIFACTS) return;
    seen.add(artifact.key);
    artifacts.push(artifact);
  };
  for (const attachment of entry.attachments ?? []) {
    add({ kind: "attachment", key: `attachment:${attachment.id}`, attachment });
  }
  for (const link of entry.links) {
    if (link.threadId) {
      add({
        kind: "thread",
        key: `thread:${link.threadId}`,
        threadId: link.threadId,
        label: link.label,
      });
    }
  }
  const prose = entry.text.replace(/```[\s\S]*?```/g, " ");
  const addHref = (href: string, label: string | null) => {
    const url = trimUrl(href);
    if (!/^https?:\/\//.test(url)) return;
    const artifact = /^https:\/\/claude\.ai\/(?:code\/)?artifact\//.test(url);
    add({
      kind: artifact ? "artifact" : "link",
      key: `url:${url}`,
      href: url,
      label: label?.trim() || linkLabel(url),
    });
  };
  for (const match of prose.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const [, label = "", target = ""] = match;
    if (isFilePath(target)) {
      add({ kind: "file", key: `file:${target}`, path: target, label: label || basename(target) });
    } else {
      addHref(target, label);
    }
  }
  const withoutMarkdownLinks = prose.replace(/\[[^\]\n]+\]\([^)\s]+\)/g, " ");
  for (const match of withoutMarkdownLinks.matchAll(/https?:\/\/[^\s<>`]+/g)) {
    addHref(match[0], null);
  }
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]?.trim() ?? "";
    if (isFilePath(candidate)) {
      add({ kind: "file", key: `file:${candidate}`, path: candidate, label: basename(candidate) });
    }
  }
  return artifacts;
}

/** Copy for the voice stage; Nia replaces the generic chat wording. */
export const niaVoiceStatusCopy = {
  idle: { label: "Voice mode", detail: "Starting…" },
  listening: { label: "Listening", detail: "Speak naturally, then pause" },
  transcribing: { label: "Transcribing", detail: "Turning your voice into text locally" },
  waiting: { label: "Thinking", detail: "Nia is working on it" },
  summarizing: { label: "Summarizing", detail: "Condensing a long reply for speech" },
  speaking: { label: "Speaking", detail: "Tap End to stop the conversation" },
} as const;
