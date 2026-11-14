import { useEffect, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ChatViewComposerSlot } from "./ChatViewComposerSlot";

it("preserves a draft and its resources while the timeline host is unavailable", async () => {
  const releaseAttachments = vi.fn();
  function Composer() {
    const [draft, setDraft] = useState("");
    useEffect(() => releaseAttachments, []);
    return (
      <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    );
  }
  const view = (ready: boolean) => (
    <ChatViewComposerSlot composer={<Composer />}>
      {(slot) => (ready ? <section>{slot}</section> : <div>Loading</div>)}
    </ChatViewComposerSlot>
  );
  await using screen = await render(view(true));
  await screen.getByRole("textbox", { name: "Draft" }).fill("Unsent draft");
  const input = screen.container.querySelector("input");
  await screen.rerender(view(false));
  expect(input?.isConnected).toBe(false);
  expect(releaseAttachments).not.toHaveBeenCalled();
  await screen.rerender(view(true));
  expect(screen.container.querySelector("input")).toBe(input);
  expect(input?.value).toBe("Unsent draft");
  expect(releaseAttachments).not.toHaveBeenCalled();
  await screen.unmount();
  expect(releaseAttachments).toHaveBeenCalledOnce();
});
