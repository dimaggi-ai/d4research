import type { Root, RootContent } from "mdast";

/** Compact reasoning keeps formulas while flattening other Markdown into label text. */
export function remarkThoughtPreview(fallback: string) {
  return (tree: Root) => {
    const children: RootContent[] = [];
    const append = (value: string) => {
      const last = children.at(-1);
      const text = value.replace(/\s+/g, " ");
      if (last?.type === "text") last.value = (last.value + text).replace(/\s+/g, " ");
      else children.push({ type: "text", value: text });
    };
    const visit = (node: Root | RootContent) => {
      if (node.type === "html" || node.type === "definition") return;
      if (node.type === "math" || node.type === "inlineMath") {
        children.push({
          type: "inlineMath",
          value: node.value,
          position: node.position,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [{ type: "text", value: node.value }],
          },
        });
      } else if ("alt" in node) append(node.alt ?? "");
      else if ("value" in node) append(node.value);
      else if ("children" in node) {
        node.children.forEach((child, index) => {
          if (
            index &&
            ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type)
          )
            append(" ");
          visit(child);
        });
      } else if (node.type === "break") append(" ");
    };
    visit(tree);
    const first = children[0];
    const last = children.at(-1);
    if (first?.type === "text") first.value = first.value.trimStart();
    if (last?.type === "text") last.value = last.value.trimEnd();
    tree.children = children.some((child) => child.type !== "text" || child.value)
      ? children
      : [{ type: "text", value: fallback }];
  };
}
