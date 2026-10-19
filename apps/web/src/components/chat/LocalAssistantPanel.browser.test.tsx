import "../../index.css";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import type { DesktopBridge } from "@d4research/contracts";
import { LocalAssistantPanel } from "./LocalAssistantPanel";
vi.mock("../../state/threads", () => ({ useEnvironmentThread: () => ({ data: Option.none() }) }));
let root: Root;
let container: HTMLDivElement;
let draft = "";
let changeDraft: (value: string) => void;
let previousBridge: DesktopBridge | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  previousBridge = window.desktopBridge;
  window.desktopBridge = {
    localAssistantStatus: async () => ({ available: true }),
    localAssistantGenerate: async () => ({ available: true, text: "Fix this" }),
    localAssistantCancel: async () => {},
  } as unknown as DesktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (previousBridge) window.desktopBridge = previousBridge;
  else delete window.desktopBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Harness() {
  const [value, setValue] = useState("Please please fix this");
  useEffect(() => {
    draft = value;
    changeDraft = setValue;
  }, [value]);
  return <LocalAssistantPanel draft={value} onChange={setValue} threadRef={null} />;
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
it("previews locally, applies only on request, and supports undo", async () => {
  await act(async () => root.render(<Harness />));
  await click("Shorten");
  expect(draft).toBe("Please please fix this");
  expect(document.body.textContent).toContain("Fix this");
  await click("Replace draft");
  expect(draft).toBe("Fix this");
  await click("Undo draft change");
  expect(draft).toBe("Please please fix this");
});
it("does not overwrite a draft edited after generation", async () => {
  await act(async () => root.render(<Harness />));
  await click("Shorten");
  await act(async () => changeDraft("New instructions"));
  await click("Replace draft");
  expect(draft).toBe("New instructions");
  expect(document.body.textContent).toContain("Your draft changed");
});

it("keeps text tools available without offering rewrites of an empty draft", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => changeDraft(""));
  expect(container.textContent).not.toContain("Fix typos");
  expect(container.textContent).not.toContain("Shorten");
  const generate = vi.spyOn(window.desktopBridge!, "localAssistantGenerate");
  await click("More text tools");
  expect(document.body.textContent).toContain("Summarize");
  expect(generate).not.toHaveBeenCalled();
});
it("explains unavailable Apple Intelligence without generating", async () => {
  vi.spyOn(window.desktopBridge!, "localAssistantStatus").mockResolvedValue({ available: false });
  const generate = vi.spyOn(window.desktopBridge!, "localAssistantGenerate");
  await act(async () => root.render(<Harness />));
  await click("Fix typos");
  expect(document.body.textContent).toContain("Apple Intelligence is unavailable");
  expect(generate).not.toHaveBeenCalled();
});
