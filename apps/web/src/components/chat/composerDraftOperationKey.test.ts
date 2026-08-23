import { scopeThreadRef } from "@d4research/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { newDraftId } from "../../lib/utils";
import { composerDraftOperationKey } from "./composerDraftOperationKey";

describe("composerDraftOperationKey", () => {
  it("never aliases pending attachment work across threads or drafts", () => {
    const environment = EnvironmentId.make("remote-environment");
    const first = scopeThreadRef(environment, ThreadId.make("thread-a"));
    const second = scopeThreadRef(environment, ThreadId.make("thread-b"));
    const draft = newDraftId();

    const keys = [
      composerDraftOperationKey(first),
      composerDraftOperationKey(second),
      composerDraftOperationKey(draft),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain("[object Object]");
  });
});
