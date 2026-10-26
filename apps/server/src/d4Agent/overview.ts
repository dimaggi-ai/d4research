import { D4BrainContext, type D4AgentSettings } from "@d4research/contracts";
import { sha256Hex } from "@d4research/shared/hash";
import * as Schema from "effect/Schema";
import { heartbeatWindowOpen, isQuietHour } from "./policy.ts";

export const OverviewItem = Schema.Struct({
  context: D4BrainContext,
  source: Schema.String,
  key: Schema.String,
  revision: Schema.String,
  severity: Schema.Literals(["info", "attention", "critical"]),
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  recommendation: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  firstSeenAt: Schema.Number,
  lastSeenAt: Schema.Number,
  revisedAt: Schema.optionalKey(Schema.Number),
  deliveredRevision: Schema.NullOr(Schema.String),
  deliveredAt: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["open", "acknowledged", "snoozed"]),
  snoozedUntil: Schema.NullOr(Schema.Number),
  expiresAt: Schema.optionalKey(Schema.String),
  resolvedAt: Schema.NullOr(Schema.Number),
});
export type OverviewItem = typeof OverviewItem.Type;
export type OverviewInput = Pick<
  OverviewItem,
  "key" | "severity" | "title" | "body" | "recommendation" | "ref" | "expiresAt"
> & { readonly observedAt?: number };
export type OverviewSnapshot = {
  readonly context: D4BrainContext;
  readonly source: string;
  readonly items: ReadonlyArray<OverviewInput>;
};
export const overviewIdentity = (item: Pick<OverviewItem, "context" | "source" | "key">) =>
  JSON.stringify([item.context, item.source, item.key]);
export const overviewRevision = (item: OverviewInput) =>
  sha256Hex(
    JSON.stringify([item.severity, item.title, item.body ?? null, item.recommendation ?? null]),
  );
export const cleanOverviewText = (text: string, limit = 200) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\[\[|\]\]/g, "")
    .slice(0, limit);
const order = { critical: 0, attention: 1, info: 2 };
export const sortOverview = (items: ReadonlyArray<OverviewItem>) =>
  items.toSorted(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (b.revisedAt ?? b.firstSeenAt) - (a.revisedAt ?? a.firstSeenAt) ||
      overviewIdentity(a).localeCompare(overviewIdentity(b)),
  );

export function ingestOverview(
  previous: ReadonlyArray<OverviewItem>,
  snapshot: OverviewSnapshot,
  now: number,
  initialized: boolean,
): ReadonlyArray<OverviewItem> {
  const old = new Map(previous.map((item) => [overviewIdentity(item), item]));
  const incoming = new Set(snapshot.items.map((item) => item.key));
  // A producer may add a namespace to its keys ("<id>" becomes "mail:<id>"). An item it already
  // sent under the bare key, with unchanged content, is not new. Identical content under an
  // unrelated key still is.
  const renamedFrom = (key: string, revision: string) => {
    const bare = key.slice(key.indexOf(":") + 1);
    if (bare === key || incoming.has(bare)) return undefined;
    const item = old.get(overviewIdentity({ ...snapshot, key: bare }));
    return item?.revision === revision && item.deliveredRevision === revision ? item : undefined;
  };
  const next = previous
    .filter((item) => item.context !== snapshot.context || item.source !== snapshot.source)
    .concat(
      previous
        .filter(
          (item) =>
            item.context === snapshot.context &&
            item.source === snapshot.source &&
            !incoming.has(item.key),
        )
        .map((item) => ({ ...item, resolvedAt: item.resolvedAt ?? now })),
      snapshot.items.map((raw) => {
        const { observedAt, ...input } = raw;
        const existing = old.get(overviewIdentity({ ...snapshot, key: input.key }));
        const revision = overviewRevision(input);
        const changed = existing?.revision !== revision;
        const seen = existing === undefined ? renamedFrom(input.key, revision) : undefined;
        if (seen !== undefined)
          return {
            ...input,
            context: snapshot.context,
            source: snapshot.source,
            revision,
            firstSeenAt: seen.firstSeenAt,
            lastSeenAt: now,
            revisedAt: seen.revisedAt ?? seen.firstSeenAt,
            deliveredRevision: revision,
            deliveredAt: seen.deliveredAt,
            status: seen.status,
            snoozedUntil: seen.snoozedUntil,
            resolvedAt: null,
          };
        return {
          ...input,
          context: snapshot.context,
          source: snapshot.source,
          revision,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
          revisedAt: changed ? (observedAt ?? now) : (existing.revisedAt ?? existing.firstSeenAt),
          deliveredRevision: existing?.deliveredRevision ?? null,
          deliveredAt: existing?.deliveredAt ?? null,
          status: changed ? ("open" as const) : existing.status,
          snoozedUntil: changed ? null : existing.snoozedUntil,
          resolvedAt: null,
        };
      }),
    )
    .filter((item) => item.resolvedAt === null || now - item.resolvedAt < 7 * 86_400_000);
  if (initialized) return next;
  const first = sortOverview(
    next.filter(
      (item) =>
        item.context === snapshot.context &&
        item.source === snapshot.source &&
        item.resolvedAt === null &&
        (item.expiresAt === undefined || Date.parse(item.expiresAt) > now),
    ),
  );
  const silent = new Set(first.slice(5).map(overviewIdentity));
  return next.map((item) =>
    silent.has(overviewIdentity(item))
      ? { ...item, deliveredRevision: item.revision, deliveredAt: now }
      : item,
  );
}
// Global is the single overview chat: it carries every context's items, while a work context
// sees only its own.
export const overviewVisible = (item: Pick<OverviewItem, "context">, context: D4BrainContext) =>
  context === "Global" || item.context === context;
// Other contexts reach Global as metadata only (title, status, links), never their bodies.
export const overviewMetadata = (item: OverviewItem, context: D4BrainContext): OverviewItem => {
  if (item.context === context) return item;
  const { body: _body, ...metadata } = item;
  return metadata;
};
export const pendingOverview = (
  items: ReadonlyArray<OverviewItem>,
  context: D4BrainContext,
  now: number,
) =>
  sortOverview(
    items.filter(
      (item) =>
        overviewVisible(item, context) &&
        item.resolvedAt === null &&
        item.status !== "acknowledged" &&
        (item.status !== "snoozed" || (item.snoozedUntil !== null && item.snoozedUntil <= now)) &&
        (item.expiresAt === undefined || Date.parse(item.expiresAt) > now) &&
        item.deliveredRevision !== item.revision,
    ),
  );
export function overviewDue(
  settings: D4AgentSettings,
  items: ReadonlyArray<OverviewItem>,
  now: number,
  lastAt: number,
  busy: boolean,
) {
  const quiet = settings.quietHours ?? {
    startMinute: 22 * 60,
    endMinute: 7 * 60,
    utcOffsetMinutes: -480,
    timeZone: "America/Los_Angeles",
  };
  return (
    settings.enabled &&
    settings.heartbeatMinutes !== null &&
    !busy &&
    !isQuietHour(now, quiet) &&
    (items.some((item) => item.severity === "critical") ||
      heartbeatWindowOpen({ settings: { ...settings, quietHours: quiet }, now, lastAt, busy }))
  );
}
export const overviewMessageId = (
  context: D4BrainContext,
  items: ReadonlyArray<OverviewItem>,
  counts: ReadonlyArray<string> = [],
) =>
  `d4-overview:${sha256Hex(JSON.stringify([context, items.map((item) => [overviewIdentity(item), item.revision]).sort(), counts]))}`;
// One post carries the whole morning digest; the rest follows on the next heartbeat.
export const OVERVIEW_POST_LIMIT = 30;
const sourceLabels: Record<string, string> = {
  mail: "Mail",
  intel: "Daily intel",
  system: "System",
  threads: "Threads",
  scheduled: "Scheduled runs",
  cto: "CTO",
};
// The daily evolution round writes one source per context (evolution-global, evolution-yb, ...).
const sourceLabel = (source: string) =>
  sourceLabels[source] ?? (source.startsWith("evolution-") ? "Suggestions for Nia" : source);
// Thread refs become [[thread:ID|title]] links, which the server validates before display.
const overviewLine = (item: OverviewItem, context: D4BrainContext) => {
  const thread = item.ref?.startsWith("thread:") ? item.ref.slice("thread:".length) : null;
  const title =
    thread === null || /[|\]]/.test(thread)
      ? item.title
      : `[[thread:${thread}|${item.title.replace(/[[\]|]/g, "")}]]`;
  const label = item.context === context ? "" : `${item.context}: `;
  return `• ${label}${title}${item.recommendation ? ` — ${item.recommendation}` : ""}`;
};
export const overviewText = (
  items: ReadonlyArray<OverviewItem>,
  counts: ReadonlyArray<string> = [],
  context: D4BrainContext = "Global",
) => {
  const shown = items.slice(0, OVERVIEW_POST_LIMIT);
  const sources = [...new Set(shown.map((item) => item.source))];
  const body =
    sources.length < 2
      ? shown.map((item) => overviewLine(item, context))
      : sources.flatMap((source) => [
          `${sourceLabel(source)}:`,
          ...shown
            .filter((item) => item.source === source)
            .map((item) => overviewLine(item, context)),
        ]);
  return [
    ...body,
    ...(items.length > OVERVIEW_POST_LIMIT ? [`+${items.length - OVERVIEW_POST_LIMIT} more`] : []),
    ...counts,
  ].join("\n");
};
export function updateOverview(
  items: ReadonlyArray<OverviewItem>,
  context: D4BrainContext,
  key: string,
  op: "ack" | "snooze" | "reopen",
  now: number,
  minutes = 60,
): ReadonlyArray<OverviewItem> {
  const matching = items.filter(
    (item) =>
      overviewVisible(item, context) && (overviewIdentity(item) === key || item.key === key),
  );
  if (matching.length !== 1 || !Number.isInteger(minutes) || minutes < 1 || minutes > 525600)
    return items;
  return items.map((item) =>
    item !== matching[0]
      ? item
      : {
          ...item,
          status: op === "ack" ? "acknowledged" : op === "snooze" ? "snoozed" : "open",
          snoozedUntil: op === "snooze" ? now + minutes * 60_000 : null,
          ...(op === "reopen" ? { deliveredRevision: null, deliveredAt: null } : {}),
        },
  );
}
