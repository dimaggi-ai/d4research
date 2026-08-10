import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  DEFAULT_RESEARCH_DELEGATE_TIMEOUT_MILLIS,
  resolveResearchDelegateMcpTimeoutSeconds,
  resolveResearchDelegateTimeoutMillis,
} from "./researchDelegateTiming.ts";

describe("research delegate timing", () => {
  it("keeps the MCP caller alive beyond the default delegated-turn deadline", () => {
    NodeAssert.equal(resolveResearchDelegateTimeoutMillis({}), 1_800_000);
    NodeAssert.equal(resolveResearchDelegateMcpTimeoutSeconds({}), 1_860);
  });

  it("derives the caller timeout from an operator deadline override", () => {
    const environment = { T3_RESEARCH_DELEGATE_TIMEOUT_MS: "600001" };

    NodeAssert.equal(resolveResearchDelegateTimeoutMillis(environment), 600_001);
    NodeAssert.equal(resolveResearchDelegateMcpTimeoutSeconds(environment), 661);
  });

  it("does not let invalid overrides remove the bounded default", () => {
    for (const value of ["", "0", "-1", "not-a-number"]) {
      NodeAssert.equal(
        resolveResearchDelegateTimeoutMillis({ T3_RESEARCH_DELEGATE_TIMEOUT_MS: value }),
        DEFAULT_RESEARCH_DELEGATE_TIMEOUT_MILLIS,
      );
    }
  });
});
