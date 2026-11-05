import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import "../../index.css";
import { MarkdownTable } from "./MarkdownTable";

it.each([320, 800])(
  "wraps table prose, headers, and long tokens within a %ipx lane",
  async (width) => {
    const container = document.createElement("div");
    container.className = "chat-markdown";
    container.style.width = `${width}px`;
    await using screen = await render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>A detailed heading that needs several lines in a narrow column</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{"Readable prose should wrap at word boundaries. ".repeat(12)}</td>
            <td>
              <code>{"long_identifier_".repeat(16)}</code>
            </td>
          </tr>
        </tbody>
      </MarkdownTable>,
      { container, router: false },
    );
    const table = screen.container.querySelector("table")!;
    expect(table.getBoundingClientRect().width).toBeLessThanOrEqual(width + 1);
    for (const cell of table.querySelectorAll("td, th:first-child")) {
      const range = document.createRange();
      range.selectNodeContents(cell.querySelector("code") ?? cell);
      const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
      expect(lines.size).toBeGreaterThan(1);
      for (const rect of range.getClientRects()) {
        expect(rect.right).toBeLessThanOrEqual(cell.getBoundingClientRect().right + 1);
      }
    }
  },
);
