import { describe, expect, it } from "@effect/vitest";

import { parseBrowse, parseRead, parseRecall, parseSearch } from "./AlmanacText.ts";

const ID = "7e36da31-f6d0-4ffe-b13c-47151534d90b";
const OTHER = "11111111-2222-4333-8444-555555555555";

describe("Almanac reply parsing", () => {
  it("reads browse replies from old and new gateways", () => {
    expect(parseBrowse("empty")).toEqual({
      categories: [],
      memories: [],
      passages: [],
      nextOffset: null,
      total: null,
    });
    expect(
      parseBrowse(
        [
          "/work/ (3)",
          `${ID}@0-160 /storm-gate # Storm Gate test`,
          `${ID}@5-9 2026-11-06 /notes body text`,
          `${OTHER} 2026-11-01 Likes short replies`,
          `${OTHER} no date here`,
          "more: offset=4 of 9",
        ].join("\n"),
      ),
    ).toEqual({
      categories: [{ path: "/work", items: 3 }],
      passages: [
        {
          sourceId: ID,
          start: 0,
          end: 160,
          date: null,
          title: "/storm-gate",
          text: "# Storm Gate test",
        },
        { sourceId: ID, start: 5, end: 9, date: "2026-11-06", title: "/notes", text: "body text" },
      ],
      memories: [
        {
          id: OTHER,
          date: "2026-11-01",
          text: "Likes short replies",
          category: null,
          replacedBy: null,
        },
        { id: OTHER, date: null, text: "no date here", category: null, replacedBy: null },
      ],
      nextOffset: 4,
      total: 9,
    });
  });

  it("refuses a browse line it cannot place", () => {
    expect(parseBrowse("HTTP 500 upstream")).toBeNull();
  });

  it("pairs search hits with their snippets", () => {
    expect(parseSearch("no hits")).toEqual({ passages: [], indexingIncomplete: false });
    expect(parseSearch(`${ID}@0-160 unknown /page\n# Heading text\nindexing incomplete`)).toEqual({
      passages: [
        { sourceId: ID, start: 0, end: 160, date: null, title: "/page", text: "# Heading text" },
      ],
      indexingIncomplete: true,
    });
    expect(parseSearch(`${ID}@0-160 /page`)).toBeNull();
  });

  it("separates categories from replacements in recall replies", () => {
    expect(parseRecall("no memories")).toEqual({ memories: [] });
    expect(
      parseRecall(
        [
          `${ID} 2026-11-02 event 2026-10-01 [/prefs] Prefers tea [draft]`,
          `${OTHER} 2026-11-03 [replaced by ${ID}] Prefers coffee`,
        ].join("\n"),
      ),
    ).toEqual({
      memories: [
        {
          id: ID,
          date: "2026-11-02",
          text: "Prefers tea [draft]",
          category: "/prefs",
          replacedBy: null,
        },
        {
          id: OTHER,
          date: "2026-11-03",
          text: "Prefers coffee",
          category: null,
          replacedBy: ID,
        },
      ],
    });
  });

  it("keeps line breaks in a read window", () => {
    expect(parseRead("page://a 10-20/90\nfirst\n\nsecond")).toEqual({
      uri: "page://a",
      start: 10,
      end: 20,
      total: 90,
      content: "first\n\nsecond",
    });
    expect(parseRead("not a header\nbody")).toBeNull();
  });
});
