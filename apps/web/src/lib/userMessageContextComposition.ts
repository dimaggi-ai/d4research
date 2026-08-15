import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { extractTrailingEnabledSkillsContext } from "@t3tools/shared/enabledSkillsContext";
import {
  extractTrailingProviderHandoffContext,
  type ProviderHandoffContext,
} from "@t3tools/shared/providerHandoffPrompt";

import type { ReviewCommentContext } from "../reviewCommentContext";
import { appendReviewCommentsToPrompt } from "../reviewCommentContext";
import {
  appendElementContextsToPrompt,
  type ElementContextSelection,
  type ParsedElementContextEntry,
} from "./elementContext";
import {
  appendPastedContextsToPrompt,
  extractTrailingPastedContexts,
  type ParsedPastedContextEntry,
  type PastedContextDraft,
} from "./pastedContext";
import {
  appendPreviewAnnotationPrompt,
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "./previewAnnotation";
import {
  appendTerminalContextsToPrompt,
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
  type TerminalContextSelection,
} from "./terminalContext";

export interface UserMessageContextInput {
  readonly prompt: string;
  readonly pastedContexts: ReadonlyArray<PastedContextDraft>;
  readonly terminalContexts: ReadonlyArray<TerminalContextSelection>;
  readonly elementContexts: ReadonlyArray<ElementContextSelection>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
}

export interface DisplayedUserMessageContexts {
  readonly visibleText: string;
  readonly copyText: string;
  readonly pastedContexts: ReadonlyArray<ParsedPastedContextEntry>;
  readonly terminalContexts: ReadonlyArray<ParsedTerminalContextEntry>;
  readonly elementContexts: ReadonlyArray<ParsedElementContextEntry>;
  readonly previewAnnotations: ReadonlyArray<ParsedPreviewAnnotation>;
  readonly enabledSkills: ReadonlyArray<string>;
  readonly globalEnabledSkills: ReadonlyArray<string>;
  readonly sessionEnabledSkills: ReadonlyArray<string>;
  /** Carried context when this turn also performed a provider handoff. */
  readonly handoff: ProviderHandoffContext | null;
}

/**
 * Builds the exact wire text for every composer-only context type. The order
 * is a stack: review comments remain in the visible body, while each anchored
 * metadata block is appended from innermost to outermost so display can peel
 * it in the reverse order without leaking raw tags.
 */
export function composeUserMessageContexts(input: UserMessageContextInput): string {
  const withReviews = appendReviewCommentsToPrompt(input.prompt, input.reviewComments);
  const withPastes = appendPastedContextsToPrompt(withReviews, input.pastedContexts);
  const withTerminals = appendTerminalContextsToPrompt(withPastes, input.terminalContexts);
  const withElements = appendElementContextsToPrompt(withTerminals, input.elementContexts);
  return input.previewAnnotations.reduce(
    (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
    withElements,
  );
}

/** Reverse of composeUserMessageContexts, used directly by the transcript. */
export function extractUserMessageContexts(prompt: string): DisplayedUserMessageContexts {
  // The server appends enabled skills after all client-authored context, so it
  // is the outermost layer and must be removed first.
  const enabled = extractTrailingEnabledSkillsContext(prompt);
  // A staged handoff appends its context block after every composer block, so
  // it is the outermost client-authored layer and peels next. Copy text drops
  // it too: what the user wrote is the instruction, not the machine block.
  const handoff = extractTrailingProviderHandoffContext(enabled.promptText);
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let withoutPreviews = handoff.promptText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(withoutPreviews);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    withoutPreviews = extracted.promptText;
  }

  const displayed = deriveDisplayedUserMessageState(withoutPreviews);
  const pasted = extractTrailingPastedContexts(displayed.visibleText);
  return {
    visibleText: pasted.promptText,
    copyText: handoff.promptText,
    pastedContexts: pasted.contexts,
    terminalContexts: displayed.contexts,
    elementContexts: displayed.elementContexts,
    previewAnnotations,
    enabledSkills: enabled.skills,
    globalEnabledSkills: enabled.globalSkills,
    sessionEnabledSkills: enabled.sessionSkills,
    handoff: handoff.handoff,
  };
}
