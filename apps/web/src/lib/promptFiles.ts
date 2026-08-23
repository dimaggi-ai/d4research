import type { ResearchPromptFile } from "@d4research/contracts";
import {
  RESEARCH_PROMPT_FILE_MAX_CHARS,
  RESEARCH_PROMPT_FILE_MAX_COUNT,
} from "@d4research/contracts";

export const ACCEPTED_PROMPT_FILE_SUFFIXES = [".md", ".markdown", ".txt"] as const;

interface ReadablePromptFile {
  readonly name: string;
  readonly text: () => Promise<string>;
}

export interface MergePromptFilesResult {
  readonly promptFiles: ReadonlyArray<ResearchPromptFile>;
  readonly errors: ReadonlyArray<string>;
}

function isAcceptedPromptFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_PROMPT_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Read each selected file independently. Existing names may be replaced even
 * at capacity; unreadable or oversized files never reject the whole batch.
 */
export async function mergePromptFiles(
  existingFiles: ReadonlyArray<ResearchPromptFile>,
  selectedFiles: ReadonlyArray<ReadablePromptFile>,
): Promise<MergePromptFilesResult> {
  const promptFiles = [...existingFiles];
  const errors: string[] = [];
  for (const file of selectedFiles) {
    if (!isAcceptedPromptFileName(file.name)) {
      errors.push(
        `"${file.name}" skipped — only ${ACCEPTED_PROMPT_FILE_SUFFIXES.join(", ")} files.`,
      );
      continue;
    }
    const existingIndex = promptFiles.findIndex((candidate) => candidate.name === file.name);
    if (existingIndex < 0 && promptFiles.length >= RESEARCH_PROMPT_FILE_MAX_COUNT) {
      errors.push(
        `"${file.name}" skipped — at most ${RESEARCH_PROMPT_FILE_MAX_COUNT} prompt files.`,
      );
      continue;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      errors.push(`"${file.name}" skipped — the browser could not read it.`);
      continue;
    }
    if (content.length > RESEARCH_PROMPT_FILE_MAX_CHARS) {
      errors.push(
        `"${file.name}" skipped — over ${Math.floor(RESEARCH_PROMPT_FILE_MAX_CHARS / 1000)}k characters.`,
      );
      continue;
    }
    const value = { name: file.name, content };
    if (existingIndex >= 0) promptFiles[existingIndex] = value;
    else promptFiles.push(value);
  }
  return { promptFiles, errors };
}
