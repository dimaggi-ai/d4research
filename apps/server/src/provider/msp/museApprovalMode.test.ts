import { describe, expect, it } from "vite-plus/test";
import { approval } from "./mspTestUtils.ts";
import {
  approvalModeForRuntimeMode,
  approvalOptionsFromChoices,
  requestTypeForSubject,
  selectChoiceForDecision,
  shouldAutoDecide,
} from "./museApprovalMode.ts";

describe("Muse approval policy", () => {
  it("maps runtime modes and honors explicit overrides", () => {
    expect(approvalModeForRuntimeMode("full-access")).toBe("allowAll");
    expect(approvalModeForRuntimeMode("auto")).toBe("promptUnmatched");
    expect(approvalModeForRuntimeMode("auto-accept-edits")).toBe("promptUnmatched");
    expect(approvalModeForRuntimeMode("approval-required")).toBe("onRequest");
    expect(approvalModeForRuntimeMode("full-access", "denyUnmatched")).toBe("denyUnmatched");
  });
  it("maps choices and preserves persistent-rule warnings", () => {
    expect(approvalOptionsFromChoices(approval.availableChoices).map((o) => o.decision)).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
    ]);
    expect(approvalOptionsFromChoices(approval.availableChoices)[2]?.warning).toBe("Allow shell");
    expect(
      approvalOptionsFromChoices([{ ...approval.availableChoices[0]!, decision: "timedOut" }]),
    ).toEqual([]);
  });
  it("does not reinterpret unknown approval scopes", () => {
    expect(
      approvalOptionsFromChoices([{ ...approval.availableChoices[0]!, scope: "futureScope" }]),
    ).toEqual([]);
  });
  it("uses only offered choices when falling back", () => {
    expect(
      selectChoiceForDecision(approval.availableChoices.slice(0, 1), "acceptAlways")?.choiceId,
    ).toBe("once");
    expect(selectChoiceForDecision(approval.availableChoices, "cancel")?.choiceId).toBe("deny");
    expect(selectChoiceForDecision([], "accept")).toBeUndefined();
  });
  it("never auto-approves unknown subjects or protected writes", () => {
    expect(shouldAutoDecide("full-access", approval)).toBe(true);
    expect(shouldAutoDecide("full-access", { ...approval, protectedWrite: true })).toBe(false);
    expect(shouldAutoDecide("full-access", { ...approval, judgeEscalated: true })).toBe(false);
    expect(shouldAutoDecide("full-access", { ...approval, subject: { kind: "future" } })).toBe(
      false,
    );
    expect(shouldAutoDecide("auto-accept-edits", approval)).toBe(false);
    expect(
      shouldAutoDecide("auto-accept-edits", { ...approval, subject: { kind: "fileAccess" } }),
    ).toBe(true);
  });
  it("distinguishes file reads, writes, and unknown subjects", () => {
    expect(requestTypeForSubject({ kind: "fileAccess", access: "read" }, false)).toBe(
      "file_read_approval",
    );
    expect(requestTypeForSubject({ kind: "fileAccess", access: "write" }, false)).toBe(
      "file_change_approval",
    );
    expect(requestTypeForSubject({ kind: "fileAccess", access: "read" }, true)).toBe(
      "file_change_approval",
    );
    expect(requestTypeForSubject({ kind: "future" }, false)).toBe("unknown");
  });
});
