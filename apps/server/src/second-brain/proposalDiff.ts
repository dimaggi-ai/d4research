// One replacement hunk keeps diff generation linear even for unrelated large notes.
export function proposalDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const lines = (text: string) => (text === "" ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []));
  const oldLines = lines(before);
  const newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++;
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]
  )
    end++;
  const oldCount = oldLines.length - start - end;
  const newCount = newLines.length - start - end;
  const render = (prefix: string, line: string) =>
    `${prefix}${line.endsWith("\n") ? line : `${line}\n\\ No newline at end of file\n`}`;
  return (
    `--- a/${path}\n+++ b/${path}\n@@ -${oldCount === 0 ? start : start + 1},${oldCount} +${newCount === 0 ? start : start + 1},${newCount} @@\n` +
    oldLines
      .slice(start, oldLines.length - end)
      .map((line) => render("-", line))
      .join("") +
    newLines
      .slice(start, newLines.length - end)
      .map((line) => render("+", line))
      .join("")
  );
}
