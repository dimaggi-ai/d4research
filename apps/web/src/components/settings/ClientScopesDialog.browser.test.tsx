import { act, render } from "../../../test/render";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { AuthGrantScope, type AuthEnvironmentScope } from "@d4research/contracts";
import { ClientScopesDialog } from "./ClientScopesDialog";

function button(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => b.textContent?.trim() === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

describe("editing authorized client permissions", () => {
  it("saves all available permissions and reopens with the saved grant", async () => {
    function Settings() {
      const [scopes, save] = useState<ReadonlyArray<AuthEnvironmentScope>>(["orchestration:read"]);
      return (
        <>
          <p data-current-grant>{scopes.join(", ")}</p>
          <ClientScopesDialog
            label="iPhone Safari"
            scopes={scopes}
            delegatableScopes={AuthGrantScope.literals}
            onSave={async (next) => {
              save(next);
            }}
          />
        </>
      );
    }
    // These dialog fixtures do not navigate.
    await using screen = await render(<Settings />, { router: false });
    await click("Edit permissions");
    await click("All available");
    await click("Save permissions");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("[data-current-grant]")?.textContent).toContain("relay:read");
    expect(document.querySelector("[data-current-grant]")?.textContent).toContain("access:write");
    await click("Edit permissions");
    await click("Read only");
    await click("Save permissions");
    expect(document.querySelector("[data-current-grant]")?.textContent).toContain(
      "filesystem:read",
    );
    expect(document.querySelector("[data-current-grant]")?.textContent).not.toContain(
      "filesystem:write",
    );
  });
  it("keeps edits open on save failure and leaves saved permissions unchanged when cancelled", async () => {
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <ClientScopesDialog
        label="iPhone Safari"
        scopes={["orchestration:read"]}
        delegatableScopes={AuthGrantScope.literals}
        onSave={async () => {
          throw new Error("Connection lost. Try again.");
        }}
      />,
      { router: false },
    );
    await click("Edit permissions");
    await click("All available");
    await click("Save permissions");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    await click("Cancel");
    await click("Edit permissions");
    const selected = [...document.querySelectorAll('[role="checkbox"][aria-checked="true"]')];
    expect(selected).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it("lets a limited manager remove higher permissions without granting unavailable ones", async () => {
    let saved: ReadonlyArray<AuthGrantScope> = [];
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <ClientScopesDialog
        label="Phone"
        scopes={["orchestration:read", "filesystem:write"]}
        delegatableScopes={["orchestration:read", "access:write"]}
        onSave={async (next) => {
          saved = next;
        }}
      />,
      { router: false },
    );
    await click("Edit permissions");
    expect(button("Save permissions").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "only grant permissions",
    );
    await click("All available");
    await click("Save permissions");
    expect(saved).toEqual(["orchestration:read", "access:write"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
