const SKIPPED_TAGS = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE"]);
const SKIPPED_CLASS_NAMES = ["select-none", "sr-only"];
const SANITIZED_HTML_SELECTOR = [
  "button",
  "input",
  "script",
  "style",
  "svg",
  '[aria-hidden="true"]',
  ...SKIPPED_CLASS_NAMES.map((className) => `.${className}`),
].join(", ");

export interface MarkdownClipboardPayload {
  text: string;
  html: string;
}

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName) || element.localName === "svg") return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  return SKIPPED_CLASS_NAMES.some((className) => element.classList.contains(className));
}

function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? "";
  if (!core) return content;
  return `${match?.[1] ?? ""}${marker}${core}${marker}${match?.[3] ?? ""}`;
}

// Highlighter spans or newlines identify block code even when its pre wrapper was not copied.
function isBlockCodeElement(element: Element, content: string): boolean {
  if (content.includes("\n")) return true;
  for (const child of element.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).classList.contains("line")) {
      return true;
    }
  }
  return false;
}

function wrapInlineCode(code: string): string {
  const longestRun = [...(code.match(/`+/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(1, longestRun + (longestRun > 0 ? 1 : 0)));
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function codeFenceFor(code: string): string {
  const longestRun = [...(code.match(/`{3,}/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function resolveCodeBlockLanguage(pre: Element): string | null {
  const declared =
    pre.closest("[data-language]")?.getAttribute("data-language") ??
    /(?:^|\s)language-(\S+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ??
    null;
  return declared && declared !== "text" ? declared : null;
}

export function serializeCodeBlockToMarkdown(source: string, language: string | null): string {
  const code = source.replace(/\n$/, "");
  const fence = codeFenceFor(code);
  return `${fence}${language ?? ""}\n${code}\n${fence}\n\n`;
}

function serializeCodeBlock(pre: Element): string {
  return serializeCodeBlockToMarkdown(pre.textContent ?? "", resolveCodeBlockLanguage(pre));
}

function serializeTableCell(cell: Element): string {
  return serializeChildren(cell).replace(/\n+/g, " ").trim().replaceAll("|", "\\|");
}

function tableSeparatorFor(headerCells: Element[]): string {
  const markers = headerCells.map((cell) => {
    const align = (cell as HTMLElement).style?.textAlign ?? cell.getAttribute("align") ?? "";
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  return `| ${markers.join(" | ")} |`;
}

function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];
  if (rows.length === 0) return "";
  const lines: string[] = [];
  let emittedSeparator = false;
  for (const row of table.querySelectorAll(
    ":scope > thead > tr, :scope > tbody > tr, :scope > tr",
  )) {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    if (cells.length === 0) continue;
    lines.push(`| ${cells.map((cell) => serializeTableCell(cell)).join(" | ")} |`);
    if (!emittedSeparator) {
      lines.push(tableSeparatorFor(cells));
      emittedSeparator = true;
    }
  }
  return `${lines.join("\n")}\n\n`;
}

function serializeListItem(item: Element, ordered: boolean, index: number): string {
  const checkbox = item.querySelector(
    ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
  );
  const task = checkbox ? `[${(checkbox as HTMLInputElement).checked ? "x" : " "}] ` : "";
  const bullet = ordered ? `${index}. ` : "- ";
  const marker = `${bullet}${task}`;
  let content = serializeChildren(item)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!item.querySelector(":scope > p")) {
    content = content.replace(/\n{2,}/g, "\n");
  }
  // Continuations align after the bullet; task boxes belong to the item text.
  const continuationIndent = " ".repeat(bullet.length);
  const [first = "", ...rest] = content.split("\n");
  return [
    `${marker}${first}`,
    ...rest.map((line) => (line.length > 0 ? `${continuationIndent}${line}` : line)),
  ].join("\n");
}

function serializeList(list: Element, ordered: boolean): string {
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const items = [...list.children].filter((child) => child.tagName === "LI");
  if (items.length === 0) return "";
  return `${items.map((item, index) => serializeListItem(item, ordered, start + index)).join("\n")}\n\n`;
}

function serializeBlockquote(quote: Element): string {
  const content = serializeChildren(quote)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!content) return "";
  const quoted = content
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

function serializeDetails(details: Element): string {
  const summary =
    details.querySelector(":scope > [data-markdown-details-summary]")?.textContent?.trim() ??
    "Details";
  const contentNode = details.querySelector(":scope > * [data-markdown-details-content]");
  const content = contentNode ? serializeChildren(contentNode).trim() : "";
  const open = details.getAttribute("data-markdown-details-open") === "true" ? " open" : "";
  return `<details${open}>\n<summary>${summary}</summary>${content ? `\n\n${content}` : ""}\n</details>\n\n`;
}

function serializeAnchor(anchor: Element): string {
  const markdownCopy = anchor.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return markdownCopy;
  const content = serializeChildren(anchor);
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return "";
  if (label === href) return href;
  return `[${label}](${href})`;
}

function serializeChildren(node: Node): string {
  let out = "";
  for (const child of node.childNodes) {
    out += serializeNode(child);
  }
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text.includes("\n") && text.trim().length === 0) return "\n";
    return text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.hasAttribute("data-markdown-details")) {
    return serializeDetails(element);
  }
  const markdownCopy = element.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return markdownCopy;
  if (isSkippedElement(element)) return "";

  const headingLevel = /^H([1-6])$/.exec(element.tagName)?.[1];
  if (headingLevel) {
    return `${"#".repeat(Number(headingLevel))} ${serializeChildren(element).trim()}\n\n`;
  }

  switch (element.tagName) {
    case "BR":
      return "\n";
    case "HR":
      return "---\n\n";
    case "P":
      return `${serializeChildren(element).trim()}\n\n`;
    case "PRE":
      return serializeCodeBlock(element);
    case "CODE": {
      const content = element.textContent ?? "";
      return isBlockCodeElement(element, content) ? content : wrapInlineCode(content);
    }
    case "STRONG":
    case "B":
      return wrapInlineMarker(serializeChildren(element), "**");
    case "EM":
    case "I":
      return wrapInlineMarker(serializeChildren(element), "*");
    case "DEL":
    case "S":
      return wrapInlineMarker(serializeChildren(element), "~~");
    case "A":
      return serializeAnchor(element);
    case "IMG": {
      const alt = element.getAttribute("alt") ?? "";
      const src = element.getAttribute("src") ?? "";
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "UL":
      return serializeList(element, false);
    case "OL":
      return serializeList(element, true);
    case "BLOCKQUOTE":
      return serializeBlockquote(element);
    case "TABLE":
      return serializeTable(element);
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const content = serializeChildren(element);
      return content && !content.endsWith("\n") ? `${content}\n` : content;
    }
    default:
      return serializeChildren(element);
  }
}

interface SoleCodeBlockScan {
  pre: Element | null;
  other: boolean;
}

function scanForSoleCodeBlock(node: Node, scan: SoleCodeBlockScan): void {
  for (const child of node.childNodes) {
    if (scan.other) return;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim().length > 0) scan.other = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    // Explicit markdown still counts on skipped tags such as file-chip buttons.
    if (element.hasAttribute("data-markdown-details")) {
      scan.other = true;
      continue;
    }
    const markdownCopy = element.getAttribute("data-markdown-copy");
    if (markdownCopy !== null) {
      if (markdownCopy.trim().length > 0) scan.other = true;
      continue;
    }
    if (isSkippedElement(element)) continue;
    if (element.tagName === "PRE") {
      if (scan.pre) scan.other = true;
      else scan.pre = element;
      continue;
    }
    if (element.tagName === "IMG" || element.tagName === "HR") {
      scan.other = true;
      continue;
    }
    if (element.tagName === "LI") {
      const preBeforeItem = scan.pre;
      scanForSoleCodeBlock(element, scan);
      if (!scan.other && scan.pre === preBeforeItem) scan.other = true;
      continue;
    }
    scanForSoleCodeBlock(element, scan);
  }
}

// Selecting a block's final newline pulls in its closing pre even when only code was highlighted.
function soleCodeBlock(container: Node): Element | null {
  const scan: SoleCodeBlockScan = { pre: null, other: false };
  scanForSoleCodeBlock(container, scan);
  return scan.other ? null : scan.pre;
}

function tidyMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/[ \t]+(?=\n)/g, "").replace(/\n{3,}/g, "\n\n"),
    )
    .join("")
    .trim();
}

export function serializeRenderedMarkdownFragment(container: Node): string {
  const codeBlock = soleCodeBlock(container);
  if (codeBlock) return (codeBlock.textContent ?? "").replace(/\n$/, "");
  return tidyMarkdown(serializeChildren(container));
}

export function serializeTableElementToMarkdown(table: Element): string {
  return serializeTable(table).trim();
}

function tableRows(table: Element): string[][] {
  return [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")]
    .map((row) =>
      [...row.children]
        .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
        .map((cell) => csvCellText(cell).replace(/\s+/g, " ").trim()),
    )
    .filter((cells) => cells.length > 0);
}

/**
 * Slack has no native Markdown table syntax. A box-drawn table inside a code
 * block is both legible and retained as a table when it is pasted and sent.
 */
export function serializeTableElementToSlack(table: Element): string {
  const rows = tableRows(table);
  if (rows.length === 0) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...rows.map((row) => [...(row[columnIndex] ?? "")].length)),
  );
  const horizontal = (left: string, middle: string, right: string) =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  const renderRow = (row: string[]) =>
    `│${widths
      .map((width, columnIndex) => ` ${(row[columnIndex] ?? "").padEnd(width)} `)
      .join("│")}│`;
  const [header, ...body] = rows;
  if (!header) return "";
  const lines = [horizontal("┌", "┬", "┐"), renderRow(header)];
  if (rows.length > 1) {
    lines.push(horizontal("├", "┼", "┤"), ...body.map(renderRow));
  }
  lines.push(horizontal("└", "┴", "┘"));
  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

// The wrapper MarkdownMath puts on every formula it renders. The sanitizer drops
// the attribute from authored HTML.
const MATH_SELECTOR = "[data-markdown-math]";

export function mathWrapperOf(element: Element | null): Element | null {
  return element?.closest(MATH_SELECTOR) ?? null;
}

/** A cell's text, with each formula as its TeX. */
function csvCellText(cell: Element): string {
  if (!cell.querySelector(MATH_SELECTOR)) return cell.textContent ?? "";
  const copy = cell.cloneNode(true) as Element;
  for (const wrapper of copy.querySelectorAll(MATH_SELECTOR)) {
    wrapper.replaceWith(wrapper.getAttribute("data-markdown-copy")?.trim() ?? "");
  }
  return copy.textContent ?? "";
}

function csvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

export function serializeTableElementToCsv(table: Element): string {
  const lines: string[] = [];
  for (const row of table.querySelectorAll(
    ":scope > thead > tr, :scope > tbody > tr, :scope > tr",
  )) {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    if (cells.length === 0) continue;
    lines.push(cells.map((cell) => csvCell(csvCellText(cell))).join(","));
  }
  return lines.join("\n");
}

function mermaidSourceHtml(source: string) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source.trim();
  pre.appendChild(code);
  return pre;
}

function mathSourceElement(wrapper: Element): Element {
  const code = document.createElement("code");
  code.textContent = wrapper.getAttribute("data-markdown-copy")?.trim() ?? "";
  if (wrapper.getAttribute("data-markdown-math") !== "display") return code;
  const pre = document.createElement("pre");
  pre.append(code);
  return pre;
}

function sanitizedHtmlFrom(container: Element): string {
  for (const diagram of container.querySelectorAll("[data-markdown-mermaid]")) {
    const source = diagram.getAttribute("data-markdown-copy");
    if (source !== null) diagram.replaceChildren(mermaidSourceHtml(source));
  }
  for (const wrapper of container.querySelectorAll(MATH_SELECTOR)) {
    wrapper.replaceWith(mathSourceElement(wrapper));
  }
  for (const node of container.querySelectorAll(SANITIZED_HTML_SELECTOR)) {
    if (
      node.classList.contains("chat-markdown-file-link") ||
      node.closest(".chat-markdown-file-link")
    ) {
      if (node.getAttribute("aria-hidden") === "true" || node.localName === "svg") {
        node.remove();
      }
      continue;
    }
    node.remove();
  }
  return `<meta charset="utf-8">${container.innerHTML}`;
}

export function chatMarkdownClipboardPayload(
  selection: Selection,
): MarkdownClipboardPayload | null {
  const texts: string[] = [];
  const htmls: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    // A selection inside a code block copies verbatim. Running it through the markdown serializer
    // would wrap a partial selection in fences it never had.
    const ancestor = range.commonAncestorContainer;
    const ancestorElement =
      ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
    const diagramSource = ancestorElement
      ?.closest("[data-markdown-mermaid]")
      ?.getAttribute("data-markdown-copy");
    if (diagramSource != null) {
      const text = diagramSource.trim();
      if (!text) continue;
      texts.push(text);
      container.replaceChildren(mermaidSourceHtml(diagramSource));
      htmls.push(sanitizedHtmlFrom(container));
      continue;
    }
    // A range inside a formula would clone only KaTeX's glyphs, not the wrapper holding the TeX.
    const math = mathWrapperOf(ancestorElement);
    if (math) {
      texts.push(math.getAttribute("data-markdown-copy")?.trim() ?? "");
      htmls.push(`<meta charset="utf-8">${mathSourceElement(math).outerHTML}`);
      continue;
    }
    if (ancestorElement?.closest("pre")) {
      const codeText = range.toString();
      if (codeText) {
        texts.push(codeText);
        htmls.push(sanitizedHtmlFrom(container));
      }
      continue;
    }
    // Slack ignores Markdown tables. Replace each selected rendered table with
    // a code-block table before the normal rich-copy serializer runs, so a
    // regular Cmd/Ctrl+C produces the same usable format as “Copy for Slack”.
    for (const table of container.querySelectorAll("table")) {
      table.replaceWith(document.createTextNode(`\n\n${serializeTableElementToSlack(table)}\n\n`));
    }
    const text = serializeRenderedMarkdownFragment(container);
    if (!text) continue;
    texts.push(text);
    htmls.push(sanitizedHtmlFrom(container));
  }
  if (texts.length === 0) return null;
  return { text: texts.join("\n\n"), html: htmls.join("") };
}
