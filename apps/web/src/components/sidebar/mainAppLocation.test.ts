import { expect, it } from "vite-plus/test";
import { isSidebarUtilityPage } from "./mainAppLocation";

it("keeps the dashboard out of the remembered thread destination used by Back", () => {
  expect(isSidebarUtilityPage("/dashboard")).toBe(true);
  expect(isSidebarUtilityPage("/settings/appearance")).toBe(true);
  expect(isSidebarUtilityPage("/local/thread-1")).toBe(false);
});
