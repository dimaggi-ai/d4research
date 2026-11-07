import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";

describe("buildHomeListFilterMenuItems", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenuItems({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      selectedEnvironmentId: null,
      selectedProjectKey: "environment-1:project-1",
      onEnvironmentChange: vi.fn(),
      onProjectChange,
    });

    const projectMenu = menu.find((item) => item.id === "project");
    expect(menu.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      items: [
        { title: "All projects", selected: false },
        { title: "Codething", selected: true },
        { title: "Website", selected: false },
      ],
    });
    if (!projectMenu || !("items" in projectMenu)) throw new Error("Expected project submenu");

    const clear = projectMenu.items[0];
    if (clear && "onPress" in clear) clear.onPress();
    const select = projectMenu.items[2];
    if (select && "onPress" in select) select.onPress();
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });
});
