import { extractTrailingEnabledSkillsContext } from "./enabledSkillsContext.ts";

export type UserMessageTransportKind = "pasted" | "terminal" | "element" | "preview";

export interface UserMessageTransportSummary {
  readonly kind: UserMessageTransportKind;
  readonly label: string;
}

export interface StrippedUserMessageTransport {
  readonly promptText: string;
  readonly skills: ReadonlyArray<string>;
  readonly globalSkills: ReadonlyArray<string>;
  readonly sessionSkills: ReadonlyArray<string>;
  readonly contexts: ReadonlyArray<UserMessageTransportSummary>;
}

const trailingBlock = (tag: string) =>
  new RegExp(`\\n*<${tag}(?: version="2")?>\\n([\\s\\S]*?)\\n</${tag}>\\s*$`, "u");

const PREVIEW_PATTERN = trailingBlock("preview_annotation");
const ELEMENT_PATTERN = trailingBlock("element_context");
const TERMINAL_PATTERN = trailingBlock("terminal_context");
const PASTED_PATTERN = trailingBlock("pasted_context");

function headers(block: string): Array<string> {
  return block.split("\n").flatMap((line) => {
    const match = /^- (.+):$/u.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
}

function pastedNames(block: string): Array<string> | null {
  const names: string[] = [];
  let cursor = 0;
  while (cursor < block.length) {
    const headerEnd = block.indexOf("\n", cursor);
    if (headerEnd < 0) return null;
    let header: unknown;
    try {
      header = JSON.parse(block.slice(cursor, headerEnd));
    } catch {
      return null;
    }
    if (
      typeof header !== "object" ||
      header === null ||
      !("name" in header) ||
      typeof header.name !== "string" ||
      !("contentLength" in header) ||
      !Number.isSafeInteger(header.contentLength) ||
      (header.contentLength as number) < 0
    ) {
      return null;
    }
    const bodyEnd = headerEnd + 1 + (header.contentLength as number);
    if (bodyEnd > block.length) return null;
    names.push(header.name);
    cursor = bodyEnd;
    if (cursor === block.length) break;
    if (block[cursor] !== "\n") return null;
    cursor += 1;
  }
  return names;
}

function stripRepeatedPreview(
  prompt: string,
  contexts: Array<UserMessageTransportSummary>,
): string {
  let remaining = prompt;
  while (true) {
    const match = PREVIEW_PATTERN.exec(remaining);
    if (!match) return remaining;
    const page = (match[1] ?? "")
      .split("\n")
      .find((line) => line.startsWith("Page: "))
      ?.slice("Page: ".length)
      .trim();
    contexts.unshift({ kind: "preview", label: page || "Preview annotation" });
    remaining = remaining.slice(0, match.index).replace(/\n+$/u, "");
  }
}

function stripHeaderBlock(
  prompt: string,
  pattern: RegExp,
  kind: "terminal" | "element",
  contexts: Array<UserMessageTransportSummary>,
): string {
  const match = pattern.exec(prompt);
  if (!match) return prompt;
  const labels = headers(match[1] ?? "");
  contexts.unshift(
    ...labels.map((label) => ({ kind, label }) satisfies UserMessageTransportSummary),
  );
  return prompt.slice(0, match.index).replace(/\n+$/u, "");
}

/**
 * Remove every anchored composer transport block in reverse send order.
 * Mobile uses the summaries instead of rendering raw XML from web-authored turns.
 */
export function stripUserMessageTransport(prompt: string): StrippedUserMessageTransport {
  const enabled = extractTrailingEnabledSkillsContext(prompt);
  const contexts: Array<UserMessageTransportSummary> = [];
  let remaining = stripRepeatedPreview(enabled.promptText, contexts);
  remaining = stripHeaderBlock(remaining, ELEMENT_PATTERN, "element", contexts);
  remaining = stripHeaderBlock(remaining, TERMINAL_PATTERN, "terminal", contexts);

  const pasted = PASTED_PATTERN.exec(remaining);
  if (pasted) {
    const names = pastedNames(pasted[1] ?? "");
    if (names !== null) {
      contexts.unshift(...names.map((label) => ({ kind: "pasted" as const, label })));
      remaining = remaining.slice(0, pasted.index).replace(/\n+$/u, "");
    }
  }

  return {
    promptText: remaining,
    skills: enabled.skills,
    globalSkills: enabled.globalSkills,
    sessionSkills: enabled.sessionSkills,
    contexts,
  };
}
