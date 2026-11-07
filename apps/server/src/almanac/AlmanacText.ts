import type {
  AlmanacBrowseResult,
  AlmanacCategory,
  AlmanacMemory,
  AlmanacPassage,
  AlmanacReadResult,
  AlmanacRecallResult,
  AlmanacSearchResult,
} from "@d4research/contracts";

/**
 * Almanac's MCP tools reply with bounded plain text. Deployed gateways differ:
 * older ones omit the date from browse and search lines, so it stays optional.
 */
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DAY = "\\d{4}-\\d{2}-\\d{2}|unknown";
const PASSAGE = new RegExp(`^(${ID})@(\\d+)-(\\d+) (?:(${DAY}) )?(\\S+)(?: (.*))?$`, "s");
const BROWSED_MEMORY = new RegExp(`^(${ID}) (?:(${DAY}) )?(.*)$`, "s");
const RECALLED_MEMORY = new RegExp(
  `^(${ID}) (${DAY}) (?:event (?:${DAY}) )?\\[(.*?)\\] (.*)$`,
  "s",
);
const REPLACED = new RegExp(`^replaced by (${ID})$`);
const CATEGORY = /^(.*)\/ \((\d+)\)$/;
const MORE = /^more: offset=(\d+) of (\d+)$/;
const READ_HEADER = /^(\S+) (\d+)-(\d+)\/(\d+)$/;

const knownDay = (value: string | undefined) => (value && value !== "unknown" ? value : null);

const lines = (reply: string, empty: string) =>
  reply.trim() === empty ? [] : reply.split("\n").filter((line) => line.trim() !== "");

const passage = (line: string, snippet?: string): AlmanacPassage | null => {
  const match = PASSAGE.exec(line);
  if (!match) return null;
  const [, sourceId, start, end, date, title, rest] = match;
  return {
    sourceId: sourceId!,
    start: Number(start),
    end: Number(end),
    date: knownDay(date),
    title: title!,
    text: snippet ?? rest ?? "",
  };
};

export const parseBrowse = (reply: string): AlmanacBrowseResult | null => {
  const categories: AlmanacCategory[] = [];
  const memories: AlmanacMemory[] = [];
  const passages: AlmanacPassage[] = [];
  let nextOffset: number | null = null;
  let total: number | null = null;
  for (const line of lines(reply, "empty")) {
    const found = passage(line);
    if (found) {
      passages.push(found);
      continue;
    }
    const memory = BROWSED_MEMORY.exec(line);
    if (memory) {
      memories.push({
        id: memory[1]!,
        date: knownDay(memory[2]),
        text: memory[3]!,
        category: null,
        replacedBy: null,
      });
      continue;
    }
    const more = MORE.exec(line);
    if (more) {
      nextOffset = Number(more[1]);
      total = Number(more[2]);
      continue;
    }
    const category = CATEGORY.exec(line);
    if (!category) return null;
    categories.push({ path: category[1]!, items: Number(category[2]) });
  }
  return { categories, memories, passages, nextOffset, total };
};

export const parseSearch = (reply: string): AlmanacSearchResult | null => {
  const rows = lines(reply, "no hits");
  const indexingIncomplete = rows.at(-1) === "indexing incomplete";
  if (indexingIncomplete) rows.pop();
  if (rows.length % 2 !== 0) return null;
  const passages: AlmanacPassage[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    const found = passage(rows[index]!, rows[index + 1]!);
    if (!found) return null;
    passages.push(found);
  }
  return { passages, indexingIncomplete };
};

export const parseRecall = (reply: string): AlmanacRecallResult | null => {
  const memories: AlmanacMemory[] = [];
  for (const line of lines(reply, "no memories")) {
    const match = RECALLED_MEMORY.exec(line);
    if (!match) return null;
    const replacedBy = REPLACED.exec(match[3]!)?.[1] ?? null;
    memories.push({
      id: match[1]!,
      date: knownDay(match[2]),
      text: match[4]!,
      category: replacedBy ? null : match[3]!,
      replacedBy,
    });
  }
  return { memories };
};

export const parseRead = (reply: string): AlmanacReadResult | null => {
  const split = reply.indexOf("\n");
  const match = READ_HEADER.exec(split < 0 ? reply : reply.slice(0, split));
  if (!match) return null;
  return {
    uri: match[1]!,
    start: Number(match[2]),
    end: Number(match[3]),
    total: Number(match[4]),
    content: split < 0 ? "" : reply.slice(split + 1),
  };
};
