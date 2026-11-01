import { useLayoutEffect } from "react";
import { expect, it } from "vite-plus/test";
import { act, render } from "../../test/render";
import { useSidebarProjectScope } from "./useSidebarProjectScope";

it("retains the chosen project across closing and reopening the mobile sheet", async () => {
  localStorage.clear();
  let scope!: ReturnType<typeof useSidebarProjectScope>;
  function Probe() {
    const value = useSidebarProjectScope();
    useLayoutEffect(() => {
      scope = value;
    });
    return null;
  }
  await using first = await render(<Probe />);
  expect(scope[0]).toBeNull();
  await act(async () => scope[1]("environment:my-project"));
  expect(scope[0]).toBe("environment:my-project");
  await first.unmount();
  await using second = await render(<Probe />);
  expect(scope[0]).toBe("environment:my-project");
  await act(async () => scope[1](null));
  await second.unmount();
  await using third = await render(<Probe />);
  expect(scope[0]).toBeNull();
});
