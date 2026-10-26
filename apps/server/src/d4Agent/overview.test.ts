import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_D4_AGENT_SETTINGS } from "@d4research/contracts";
import {
  ingestOverview,
  overviewDue,
  overviewIdentity,
  overviewMessageId,
  overviewMetadata,
  overviewRevision,
  overviewText,
  OVERVIEW_POST_LIMIT,
  pendingOverview,
  updateOverview,
  type OverviewInput,
  type OverviewItem,
  type OverviewSnapshot,
} from "./overview.ts";

const now = Date.parse("2026-10-26T19:00:00Z");
const day = 86_400_000;
const settings = { ...DEFAULT_D4_AGENT_SETTINGS, enabled: true, heartbeatMinutes: 15 as const };
const input = (key: string, overrides: Partial<OverviewInput> = {}): OverviewInput => ({
  key,
  severity: "info",
  title: `Item ${key}`,
  ...overrides,
});
const snapshot = (
  items: ReadonlyArray<OverviewInput>,
  overrides: Partial<OverviewSnapshot> = {},
): OverviewSnapshot => ({
  context: "Global",
  source: "system",
  items,
  ...overrides,
});
const initial = (items: ReadonlyArray<OverviewInput>) =>
  ingestOverview([], snapshot(items), now, true);
const delivered = (items: ReadonlyArray<OverviewItem>) =>
  items.map((item) => ({
    ...item,
    deliveredRevision: item.revision,
    deliveredAt: now,
  }));

describe("overview ingestion and delivery", () => {
  it("deduplicates delivered revisions, retains acknowledgements, and reopens changed items", () => {
    const original = input("updates");
    const first = initial([original]);
    const acknowledged = updateOverview(delivered(first), "Global", "updates", "ack", now);
    const repeated = ingestOverview(acknowledged, snapshot([original]), now + 1000, true);
    assert.lengthOf(repeated, 1);
    assert.equal(repeated[0]?.status, "acknowledged");
    assert.isEmpty(pendingOverview(repeated, "Global", now + 1000));
    const changed = ingestOverview(
      repeated,
      snapshot([input("updates", { title: "New updates" })]),
      now + 2000,
      true,
    );
    assert.equal(changed[0]?.status, "open");
    assert.equal(changed[0]?.firstSeenAt, now);
    assert.notEqual(changed[0]?.revision, first[0]?.revision);
    assert.lengthOf(pendingOverview(changed, "Global", now + 2000), 1);
    assert.isEmpty(pendingOverview(delivered(changed), "Global", now + 2000));
  });

  it("does not re-report delivered content that its source re-keyed", () => {
    const shown = delivered(initial([input("a", { title: "Invoice" })]));
    const rekeyed = ingestOverview(
      shown,
      snapshot([input("mail:a", { title: "Invoice" }), input("mail:b", { title: "New" })]),
      now + 1000,
      true,
    );
    assert.deepEqual(
      pendingOverview(rekeyed, "Global", now + 1000).map((item) => item.key),
      ["mail:b"],
    );
    assert.equal(rekeyed.find((item) => item.key === "mail:a")?.firstSeenAt, now);
  });

  it("reports a new item whose content matches one already delivered under another key", () => {
    const shown = delivered(initial([input("a", { title: "Invoice" })]));
    const next = ingestOverview(
      shown,
      snapshot([input("a", { title: "Invoice" }), input("b", { title: "Invoice" })]),
      now + 1000,
      true,
    );
    assert.deepEqual(
      pendingOverview(next, "Global", now + 1000).map((item) => item.key),
      ["b"],
    );
  });

  it("refreshes lastSeenAt on every current snapshot without changing firstSeenAt or revision", () => {
    const first = initial([input("seen")]);
    const repeated = ingestOverview(first, snapshot([input("seen")]), now + 1000, true);
    assert.equal(repeated[0]?.lastSeenAt, now + 1000);
    assert.equal(repeated[0]?.firstSeenAt, now);
    assert.equal(repeated[0]?.revision, first[0]?.revision);
  });

  it("includes severity, title, body and recommendation in the revision, but excludes ref and expiry", () => {
    const original = input("revision", { body: "body", recommendation: "recommendation" });
    const revision = overviewRevision(original);
    for (const changed of [
      { severity: "attention" as const },
      { title: "Changed" },
      { body: "Changed" },
      { recommendation: "Changed" },
    ])
      assert.notEqual(overviewRevision({ ...original, ...changed }), revision);
    assert.equal(
      overviewRevision({ ...original, ref: "reference", expiresAt: "2026-10-27T00:00:00Z" }),
      revision,
    );
  });

  it("silently marks all but the top five delivered on first source ingestion", () => {
    const inputs = Array.from({ length: 8 }, (_, index) =>
      input(String(index), index === 7 ? { severity: "critical" } : {}),
    );
    const first = ingestOverview([], snapshot(inputs), now, false);
    const pending = pendingOverview(first, "Global", now);
    assert.lengthOf(first, 8);
    assert.lengthOf(pending, 5);
    assert.equal(pending[0]?.key, "7");
    assert.lengthOf(
      first.filter((item) => item.deliveredRevision === item.revision),
      3,
    );
    const repeated = ingestOverview(first, snapshot(inputs), now + 1000, true);
    assert.lengthOf(pendingOverview(repeated, "Global", now + 1000), 5);
  });

  it("resolves missing items only in that context and source, then drops them after seven days", () => {
    const first = initial([input("missing")]);
    const personal = ingestOverview(
      first,
      snapshot([input("private")], { context: "Personal" }),
      now,
      true,
    );
    const anotherSource = ingestOverview(
      personal,
      snapshot([input("other")], { source: "threads" }),
      now,
      true,
    );
    const resolved = ingestOverview(anotherSource, snapshot([]), now + 1000, true);
    assert.equal(resolved.find((item) => item.key === "missing")?.resolvedAt, now + 1000);
    assert.isEmpty(
      pendingOverview(
        resolved.filter((item) => item.source === "system" && item.context === "Global"),
        "Global",
        now + 1000,
      ),
    );
    assert.equal(resolved.find((item) => item.key === "private")?.resolvedAt, null);
    assert.equal(resolved.find((item) => item.key === "other")?.resolvedAt, null);
    const beforeExpiry = ingestOverview(resolved, snapshot([]), now + 7 * day, true);
    assert.isTrue(beforeExpiry.some((item) => item.key === "missing"));
    const expired = ingestOverview(beforeExpiry, snapshot([]), now + 7 * day + 1000, true);
    assert.isFalse(expired.some((item) => item.key === "missing"));
    assert.lengthOf(expired, 2);
  });

  it("holds delivery at 22:00 and 06:59 Pacific and releases it at 07:00", () => {
    const pending = initial([input("quiet")]);
    for (const timestamp of ["2026-10-27T05:00:00Z", "2026-10-27T13:59:00Z"]) {
      const at = Date.parse(timestamp);
      assert.isFalse(overviewDue(settings, pending, at, at - day, false));
    }
    const at = Date.parse("2026-10-27T14:00:00Z");
    assert.isTrue(overviewDue(settings, pending, at, at - day, false));
  });

  it("critical bypasses the heartbeat interval but respects quiet hours, activity, and disabled settings", () => {
    const ordinary = initial([input("ordinary")]);
    const critical = initial([input("critical", { severity: "critical" })]);
    assert.isFalse(overviewDue(settings, ordinary, now, now - 60_000, false));
    assert.isTrue(overviewDue(settings, critical, now, now - 60_000, false));
    const quiet = Date.parse("2026-10-27T05:00:00Z");
    assert.isFalse(overviewDue(settings, critical, quiet, quiet - day, false));
    assert.isFalse(overviewDue(settings, critical, now, now - day, true));
    assert.isFalse(overviewDue({ ...settings, enabled: false }, critical, now, now - day, false));
    assert.isFalse(
      overviewDue({ ...settings, heartbeatMinutes: null }, critical, now, now - day, false),
    );
  });

  it("message IDs remain stable across retries and ordering, but change for revision, context, or count changes", () => {
    const first = initial([input("a"), input("b")]);
    const id = overviewMessageId("Global", first, ["Personal: 2 new items"]);
    assert.equal(overviewMessageId("Global", first.toReversed(), ["Personal: 2 new items"]), id);
    const repeated = ingestOverview(first, snapshot([input("a"), input("b")]), now + 1000, true);
    assert.equal(overviewMessageId("Global", repeated, ["Personal: 2 new items"]), id);
    const changed = ingestOverview(
      repeated,
      snapshot([input("a", { title: "Changed" }), input("b")]),
      now + 2000,
      true,
    );
    assert.notEqual(overviewMessageId("Global", changed, ["Personal: 2 new items"]), id);
    assert.equal(
      overviewMessageId("Global", changed, ["Personal: 2 new items"]),
      overviewMessageId("Global", changed.toReversed(), ["Personal: 2 new items"]),
    );
    assert.notEqual(overviewMessageId("Personal", first, ["Personal: 2 new items"]), id);
    assert.notEqual(overviewMessageId("Global", first, ["Personal: 3 new items"]), id);
  });

  it("supports snooze expiry, explicit reopen, and acknowledgement round trips", () => {
    const first = initial([input("controls")]);
    const snoozed = updateOverview(first, "Global", "controls", "snooze", now, 30);
    assert.equal(snoozed[0]?.status, "snoozed");
    assert.isEmpty(pendingOverview(snoozed, "Global", now + 29 * 60_000));
    assert.lengthOf(pendingOverview(snoozed, "Global", now + 30 * 60_000), 1);
    const reopened = updateOverview(
      delivered(snoozed),
      "Global",
      overviewIdentity(first[0]!),
      "reopen",
      now + 1000,
    );
    assert.equal(reopened[0]?.status, "open");
    assert.equal(reopened[0]?.snoozedUntil, null);
    assert.equal(reopened[0]?.deliveredAt, null);
    assert.lengthOf(pendingOverview(reopened, "Global", now + 1000), 1);
    const acknowledged = updateOverview(reopened, "Global", "controls", "ack", now + 2000);
    assert.isEmpty(pendingOverview(acknowledged, "Global", now + 2000));
    assert.lengthOf(
      pendingOverview(
        updateOverview(acknowledged, "Global", "controls", "reopen", now + 3000),
        "Global",
        now + 3000,
      ),
      1,
    );
  });

  it("Global carries every context as metadata while work contexts see only their own", () => {
    const first = initial([
      input("public", { title: "Global title", recommendation: "Global recommendation" }),
    ]);
    const mixed = ingestOverview(
      first,
      snapshot(
        [
          input("private", {
            title: "Private title",
            body: "Private body",
            recommendation: "Private recommendation",
          }),
        ],
        { context: "Personal" },
      ),
      now,
      true,
    );
    const global = pendingOverview(mixed, "Global", now);
    const personal = pendingOverview(mixed, "Personal", now);
    assert.lengthOf(global, 2);
    assert.deepEqual(
      personal.map((item) => item.key),
      ["private"],
    );
    assert.equal(
      overviewText(global.toSorted((a, b) => a.key.localeCompare(b.key))),
      "• Personal: Private title — Private recommendation\n• Global title — Global recommendation",
    );
    assert.isUndefined(
      overviewMetadata(
        global.find((item) => item.key === "private")!,
        "Global",
      ).body,
    );
    assert.equal(overviewMetadata(personal[0]!, "Personal").body, "Private body");
    assert.equal(updateOverview(mixed, "Personal", "public", "ack", now), mixed);
    assert.equal(
      pendingOverview(updateOverview(mixed, "Global", "private", "ack", now), "Global", now)[0]
        ?.key,
      "public",
    );
  });

  it("renders thread refs as link tokens that cannot be broken by their titles", () => {
    const [item] = initial([input("t", { title: "Fix [x]|y", ref: "thread:abc" })]);
    assert.equal(overviewText([item!]), "• [[thread:abc|Fix xy]]");
  });

  it("renders up to the post limit with an overflow count and excludes expired pending items", () => {
    const items = initial(
      Array.from({ length: OVERVIEW_POST_LIMIT + 2 }, (_, index) => input(String(index))),
    );
    const lines = overviewText(items, []).split("\n");
    assert.lengthOf(lines, OVERVIEW_POST_LIMIT + 1);
    assert.equal(lines[OVERVIEW_POST_LIMIT], "+2 more");
    const expired = initial([input("expired", { expiresAt: "2026-10-26T14:00:00.000Z" })]);
    assert.isEmpty(pendingOverview(expired, "Global", now));
  });
});

it("groups a digest from several sources under source headings", () => {
  const mail = ingestOverview(
    [],
    snapshot([input("m", { title: "Bill due" })], { source: "mail" }),
    now,
    true,
  );
  const intel = ingestOverview(
    mail,
    snapshot([input("i", { title: "Radar", recommendation: "Read: https://x/#yb" })], {
      source: "intel",
    }),
    now,
    true,
  );
  assert.equal(
    overviewText(intel, []),
    "Mail:\n• Bill due\nDaily intel:\n• Radar — Read: https://x/#yb",
  );
});

it("shows another context's evolution suggestion in Global under one heading, without its body", () => {
  const mail = ingestOverview(
    [],
    snapshot([input("m", { title: "Bill due" })], { source: "mail" }),
    now,
    true,
  );
  const items = ingestOverview(
    mail,
    snapshot(
      [
        input("e", {
          title: "Use case: status digests",
          body: "Evidence from a YB thread",
          recommendation: "Approve the playbook note.",
        }),
      ],
      { source: "evolution-yb", context: "YB" },
    ),
    now,
    true,
  );
  const global = pendingOverview(items, "Global", now).map((item) =>
    overviewMetadata(item, "Global"),
  );
  assert.equal(
    overviewText(global, []),
    "Mail:\n• Bill due\nSuggestions for Nia:\n• YB: Use case: status digests — Approve the playbook note.",
  );
  assert.notInclude(JSON.stringify(global), "Evidence from a YB thread");
});

it("first ingestion ignores expired items when selecting the five current notices", () => {
  const expired = Array.from({ length: 5 }, (_, index) =>
    input(`expired${index}`, { severity: "critical", expiresAt: "2026-10-25T00:00:00Z" }),
  );
  const items = ingestOverview([], snapshot([...expired, input("current")]), now, false);
  assert.deepEqual(
    pendingOverview(items, "Global", now).map((item) => item.key),
    ["current"],
  );
});
it("repeated snapshots preserve arrival ordering while refreshing lastSeenAt", () => {
  const first = initial([input("older")]);
  const next = ingestOverview(first, snapshot([input("older"), input("newer")]), now + 1000, true);
  const repeated = ingestOverview(
    next,
    snapshot([input("older"), input("newer")]),
    now + 2000,
    true,
  );
  assert.deepEqual(
    pendingOverview(repeated, "Global", now + 2000).map((item) => item.key),
    ["newer", "older"],
  );
  assert.equal(repeated.find((item) => item.key === "older")?.lastSeenAt, now + 2000);
});
