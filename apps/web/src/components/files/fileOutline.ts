export type OutlineKind =
  | "class"
  | "interface"
  | "enum"
  | "struct"
  | "trait"
  | "type"
  | "function"
  | "method"
  | "variable"
  | "constant";

export interface OutlineSymbol {
  readonly name: string;
  readonly kind: OutlineKind;
  readonly lineNumber: number;
  readonly depth: number;
}

interface RawSymbol {
  readonly name: string;
  readonly kind: OutlineKind;
  readonly lineNumber: number;
  readonly indent: number;
}

const MAX_OUTLINE_SYMBOLS = 2000;

function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex === -1 ? "" : name.slice(dotIndex + 1).toLowerCase();
}

function leadingIndent(line: string): number {
  let count = 0;
  for (const character of line) {
    if (character === " " || character === "\t") count += 1;
    else break;
  }
  return count;
}

function matchPython(line: string): Omit<RawSymbol, "lineNumber" | "indent"> | null {
  const cls = line.match(/^\s*class\s+([A-Za-z_]\w*)/u);
  if (cls) return { name: cls[1]!, kind: "class" };
  const def = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/u);
  if (def) return { name: def[2]!, kind: def[1]!.length > 0 ? "method" : "function" };
  const assign = line.match(/^[A-Za-z_]\w*\s*(?::[^=]+)?=/u);
  if (assign && leadingIndent(line) === 0) {
    const name = line.match(/^([A-Za-z_]\w*)/u)?.[1];
    if (name) return { name, kind: /^[A-Z0-9_]+$/u.test(name) ? "constant" : "variable" };
  }
  return null;
}

function matchTypeScript(line: string): Omit<RawSymbol, "lineNumber" | "indent"> | null {
  const cls = line.match(
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/u,
  );
  if (cls) return { name: cls[1]!, kind: "class" };
  const iface = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u);
  if (iface) return { name: iface[1]!, kind: "interface" };
  const en = line.match(/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/u);
  if (en) return { name: en[1]!, kind: "enum" };
  const ty = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/u);
  if (ty) return { name: ty[1]!, kind: "type" };
  const fn = line.match(
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u,
  );
  if (fn) return { name: fn[1]!, kind: "function" };
  const arrow = line.match(
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=>]+)?=>|[A-Za-z_$][\w$]*\s*=>)/u,
  );
  if (arrow) return { name: arrow[1]!, kind: "function" };
  // Class member methods: indented `name(args) {` or `name(args): Type {`.
  const method = line.match(
    /^\s+(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={;]+)?\{/u,
  );
  if (method) {
    const name = method[1]!;
    if (!/^(?:if|for|while|switch|catch|return|function)$/u.test(name)) {
      return { name, kind: "method" };
    }
  }
  return null;
}

function matchGeneric(line: string): Omit<RawSymbol, "lineNumber" | "indent"> | null {
  const cls = line.match(
    /^\s*(?:[\w]+\s+)*(?:class|struct|record|trait|interface|enum)\s+([A-Za-z_]\w*)/u,
  );
  if (cls) {
    const keyword = line.match(/\b(class|struct|record|trait|interface|enum)\b/u)?.[1];
    const kind: OutlineKind =
      keyword === "struct"
        ? "struct"
        : keyword === "trait"
          ? "trait"
          : keyword === "interface"
            ? "interface"
            : keyword === "enum"
              ? "enum"
              : "class";
    return { name: cls[1]!, kind };
  }
  const fn = line.match(/^\s*(?:[\w<>,*&\s]+\s+)?(?:func|fn|def|function)\s+([A-Za-z_]\w*)/u);
  if (fn) return { name: fn[1]!, kind: "function" };
  return null;
}

/**
 * Extract a JetBrains-style structure outline (classes, methods, functions, …) directly from file
 * text. Nesting depth is derived from relative indentation of the declaration lines, which is robust
 * across tab/space widths and indentation-based languages like Python.
 */
export function parseFileOutline(contents: string, relativePath: string): OutlineSymbol[] {
  const extension = fileExtension(relativePath);
  const matcher =
    extension === "py" || extension === "pyi"
      ? matchPython
      : ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].includes(extension)
        ? matchTypeScript
        : matchGeneric;

  const lines = contents.split("\n");
  const raw: RawSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trimStart();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }
    const match = matcher(line);
    if (match) {
      raw.push({ ...match, lineNumber: index + 1, indent: leadingIndent(line) });
      if (raw.length >= MAX_OUTLINE_SYMBOLS) break;
    }
  }

  const indentStack: number[] = [];
  return raw.map((symbol) => {
    while (indentStack.length > 0 && indentStack[indentStack.length - 1]! >= symbol.indent) {
      indentStack.pop();
    }
    const depth = indentStack.length;
    indentStack.push(symbol.indent);
    return { name: symbol.name, kind: symbol.kind, lineNumber: symbol.lineNumber, depth };
  });
}
