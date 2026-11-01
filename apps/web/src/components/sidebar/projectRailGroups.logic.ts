export const RAIL_GROUP_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;
export type RailGroupColor = (typeof RAIL_GROUP_COLORS)[number];

export interface RailGroup {
  readonly id: string;
  readonly name: string;
  readonly color: RailGroupColor;
  readonly collapsed: boolean;
  /** Logical project keys, in rail order. */
  readonly members: ReadonlyArray<string>;
}

export type RailEntry =
  | { readonly kind: "project"; readonly key: string }
  | { readonly kind: "group"; readonly group: RailGroup; readonly members: ReadonlyArray<string> };

/** Top-level rail tokens: `p:<projectKey>` or `g:<groupId>`. */
export interface RailModel {
  readonly order: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<RailGroup>;
}

const RAIL_GROUP_SCOPE_PREFIX = "rail-group:";

export function railGroupScopeKey(groupId: string): string {
  return `${RAIL_GROUP_SCOPE_PREFIX}${groupId}`;
}

export function railGroupIdFromScopeKey(key: string | null): string | null {
  return key?.startsWith(RAIL_GROUP_SCOPE_PREFIX)
    ? key.slice(RAIL_GROUP_SCOPE_PREFIX.length)
    : null;
}

function isRailGroupColor(value: unknown): value is RailGroupColor {
  return typeof value === "string" && (RAIL_GROUP_COLORS as ReadonlyArray<string>).includes(value);
}

export function sanitizeRailGroups(value: unknown): RailGroup[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const claimed = new Set<string>();
  const groups: RailGroup[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    const id = candidate.id;
    if (typeof id !== "string" || id.length === 0 || seenIds.has(id)) continue;
    const members = Array.isArray(candidate.members)
      ? candidate.members.filter(
          (member): member is string =>
            typeof member === "string" && member.length > 0 && !claimed.has(member),
        )
      : [];
    const uniqueMembers = [...new Set(members)];
    if (uniqueMembers.length === 0) continue;
    for (const member of uniqueMembers) claimed.add(member);
    seenIds.add(id);
    groups.push({
      id,
      name: typeof candidate.name === "string" ? candidate.name.slice(0, 80) : "",
      color: isRailGroupColor(candidate.color) ? candidate.color : "gray",
      collapsed: candidate.collapsed === true,
      members: uniqueMembers,
    });
  }
  return groups;
}

export function railGroupName(group: Pick<RailGroup, "name">): string {
  return group.name.trim() || "Unnamed group";
}

/** The label that fits a 46px chip in the short rail. */
export function railGroupShortLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Group";
  const words = trimmed.split(/\s+/);
  if (words.length === 1) return trimmed.length <= 7 ? trimmed : trimmed.slice(0, 5);
  if (trimmed.length <= 6) return trimmed;
  const first = words[0]!;
  if (first.length <= 5) return first;
  return words
    .map((word) => word[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

export function nextRailGroupColor(groups: ReadonlyArray<RailGroup>): RailGroupColor {
  const used = new Set(groups.map((group) => group.color));
  return RAIL_GROUP_COLORS.find((color) => color !== "gray" && !used.has(color)) ?? "gray";
}

/**
 * Lays the rail out from the manual project order. A group sits where its
 * first member does, and members a project list no longer has stay stored but
 * are not shown, so a disconnected environment does not empty a group.
 */
export function buildRailLayout(
  projectKeys: ReadonlyArray<string>,
  groups: ReadonlyArray<RailGroup>,
  settledProjectKeys: ReadonlySet<string> = new Set(),
): RailEntry[] {
  const known = new Set(projectKeys.filter((key) => !settledProjectKeys.has(key)));
  const owner = new Map<string, RailGroup>();
  for (const group of groups) {
    for (const member of group.members) if (!owner.has(member)) owner.set(member, group);
  }
  const emitted = new Set<string>();
  const entries: RailEntry[] = [];
  for (const key of projectKeys) {
    if (!known.has(key)) continue;
    const group = owner.get(key);
    if (!group) {
      entries.push({ kind: "project", key });
      continue;
    }
    if (emitted.has(group.id)) continue;
    emitted.add(group.id);
    entries.push({
      kind: "group",
      group,
      members: group.members.filter((member) => known.has(member) && owner.get(member) === group),
    });
  }
  return entries;
}

export function railModelFromLayout(
  entries: ReadonlyArray<RailEntry>,
  groups: ReadonlyArray<RailGroup>,
): RailModel {
  return {
    order: entries.map((entry) =>
      entry.kind === "project" ? `p:${entry.key}` : `g:${entry.group.id}`,
    ),
    groups,
  };
}

export function flattenRailModel(model: RailModel, known: ReadonlySet<string>): string[] {
  const byId = new Map(model.groups.map((group) => [group.id, group] as const));
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (known.has(key) && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  };
  for (const token of model.order) {
    if (token.startsWith("p:")) push(token.slice(2));
    else for (const member of byId.get(token.slice(2))?.members ?? []) push(member);
  }
  return keys;
}

function withGroups(model: RailModel, groups: ReadonlyArray<RailGroup>): RailModel {
  const live = groups.filter((group) => group.members.length > 0);
  const liveIds = new Set(live.map((group) => group.id));
  return {
    order: model.order.filter((token) => !token.startsWith("g:") || liveIds.has(token.slice(2))),
    groups: live,
  };
}

function updateGroup(
  model: RailModel,
  groupId: string,
  update: (group: RailGroup) => RailGroup,
): RailModel {
  return {
    ...model,
    groups: model.groups.map((group) => (group.id === groupId ? update(group) : group)),
  };
}

export function findRailGroupOf(model: RailModel, projectKey: string): RailGroup | null {
  return model.groups.find((group) => group.members.includes(projectKey)) ?? null;
}

function topIndexOf(model: RailModel, projectKey: string): number {
  const group = findRailGroupOf(model, projectKey);
  return model.order.indexOf(group ? `g:${group.id}` : `p:${projectKey}`);
}

/** Takes a project out of the rail entirely, dropping a group it leaves empty. */
function detach(model: RailModel, projectKey: string): RailModel {
  return withGroups(
    { ...model, order: model.order.filter((token) => token !== `p:${projectKey}`) },
    model.groups.map((group) =>
      group.members.includes(projectKey)
        ? { ...group, members: group.members.filter((member) => member !== projectKey) }
        : group,
    ),
  );
}

export function setRailGroupCollapsed(
  model: RailModel,
  groupId: string,
  collapsed: boolean,
): RailModel {
  return updateGroup(model, groupId, (group) => ({ ...group, collapsed }));
}

export function setAllRailGroupsCollapsed(
  model: RailModel,
  collapsed: boolean,
  exceptGroupId?: string,
): RailModel {
  return {
    ...model,
    groups: model.groups.map((group) =>
      group.id === exceptGroupId ? group : { ...group, collapsed },
    ),
  };
}

export function renameRailGroup(model: RailModel, groupId: string, name: string): RailModel {
  return updateGroup(model, groupId, (group) => ({ ...group, name: name.trim().slice(0, 80) }));
}

export function recolorRailGroup(
  model: RailModel,
  groupId: string,
  color: RailGroupColor,
): RailModel {
  return updateGroup(model, groupId, (group) => ({ ...group, color }));
}

export function createRailGroup(
  model: RailModel,
  projectKeys: ReadonlyArray<string>,
  group: { readonly id: string; readonly name: string; readonly color: RailGroupColor },
): RailModel {
  const unique = [...new Set(projectKeys)];
  if (unique.length === 0 || model.groups.some((existing) => existing.id === group.id)) {
    return model;
  }
  const positions = unique.map((key) => topIndexOf(model, key)).filter((index) => index >= 0);
  const anchor = positions.length > 0 ? Math.min(...positions) : model.order.length;
  const anchorToken = model.order[anchor];
  let next = model;
  for (const key of unique) next = detach(next, key);
  // Detaching can remove tokens before the anchor, so find the anchor again.
  let insertAt = anchorToken === undefined ? -1 : next.order.indexOf(anchorToken);
  if (insertAt < 0) {
    const before = model.order.slice(0, anchor).filter((token) => next.order.includes(token));
    insertAt = before.length;
  }
  const order = [...next.order];
  order.splice(insertAt, 0, `g:${group.id}`);
  return {
    order,
    groups: [...next.groups, { ...group, collapsed: false, members: unique }],
  };
}

export function addToRailGroup(
  model: RailModel,
  projectKey: string,
  groupId: string,
  index?: number,
): RailModel {
  if (!model.groups.some((group) => group.id === groupId)) return model;
  const next = detach(model, projectKey);
  // Detaching the only member of the target group drops the group itself.
  if (!next.groups.some((group) => group.id === groupId)) return model;
  return updateGroup(next, groupId, (group) => {
    const members = [...group.members];
    const at = index === undefined ? members.length : Math.max(0, Math.min(index, members.length));
    members.splice(at, 0, projectKey);
    return { ...group, members, collapsed: false };
  });
}

export function removeFromRailGroup(model: RailModel, projectKey: string): RailModel {
  const group = findRailGroupOf(model, projectKey);
  if (!group) return model;
  const at = model.order.indexOf(`g:${group.id}`);
  const order = [...model.order];
  order.splice(at < 0 ? order.length : at + 1, 0, `p:${projectKey}`);
  return withGroups(
    { ...model, order },
    model.groups.map((candidate) =>
      candidate.id === group.id
        ? { ...candidate, members: candidate.members.filter((member) => member !== projectKey) }
        : candidate,
    ),
  );
}

export function ungroupRailGroup(model: RailModel, groupId: string): RailModel {
  const group = model.groups.find((candidate) => candidate.id === groupId);
  if (!group) return model;
  const order = model.order.flatMap((token) =>
    token === `g:${groupId}` ? group.members.map((member) => `p:${member}`) : [token],
  );
  return { order, groups: model.groups.filter((candidate) => candidate.id !== groupId) };
}

function swap<T>(items: ReadonlyArray<T>, index: number, direction: -1 | 1): T[] | null {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return null;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function canMoveRailProject(
  model: RailModel,
  projectKey: string,
  direction: -1 | 1,
): boolean {
  const group = findRailGroupOf(model, projectKey);
  const items = group ? group.members : model.order;
  const index = items.indexOf(group ? projectKey : `p:${projectKey}`);
  return index >= 0 && index + direction >= 0 && index + direction < items.length;
}

export function moveRailProject(
  model: RailModel,
  projectKey: string,
  direction: -1 | 1,
): RailModel {
  const group = findRailGroupOf(model, projectKey);
  if (group) {
    const members = swap(group.members, group.members.indexOf(projectKey), direction);
    return members ? updateGroup(model, group.id, (current) => ({ ...current, members })) : model;
  }
  const order = swap(model.order, model.order.indexOf(`p:${projectKey}`), direction);
  return order ? { ...model, order } : model;
}

export function canMoveRailGroup(model: RailModel, groupId: string, direction: -1 | 1): boolean {
  const index = model.order.indexOf(`g:${groupId}`);
  return index >= 0 && index + direction >= 0 && index + direction < model.order.length;
}

export function moveRailGroup(model: RailModel, groupId: string, direction: -1 | 1): RailModel {
  const order = swap(model.order, model.order.indexOf(`g:${groupId}`), direction);
  return order ? { ...model, order } : model;
}

/** Puts a project before or after another, joining the target's group if it has one. */
export function placeRailProject(
  model: RailModel,
  projectKey: string,
  targetKey: string,
  after: boolean,
): RailModel {
  if (projectKey === targetKey) return model;
  const next = detach(model, projectKey);
  const group = findRailGroupOf(next, targetKey);
  if (group) {
    return updateGroup(next, group.id, (current) => {
      const members = [...current.members];
      members.splice(members.indexOf(targetKey) + (after ? 1 : 0), 0, projectKey);
      return { ...current, members };
    });
  }
  const targetIndex = next.order.indexOf(`p:${targetKey}`);
  if (targetIndex < 0) return model;
  const order = [...next.order];
  order.splice(targetIndex + (after ? 1 : 0), 0, `p:${projectKey}`);
  return { ...next, order };
}

export function placeRailToken(
  model: RailModel,
  token: string,
  targetToken: string,
  after: boolean,
): RailModel {
  if (token === targetToken) return model;
  let next = model;
  if (token.startsWith("p:")) {
    const key = token.slice(2);
    if (findRailGroupOf(model, key)) next = detach(model, key);
  }
  const order = next.order.filter((candidate) => candidate !== token);
  const targetIndex = order.indexOf(targetToken);
  if (targetIndex < 0) return model;
  order.splice(targetIndex + (after ? 1 : 0), 0, token);
  return { ...next, order };
}

function moveRailProjectToEnd(model: RailModel, projectKey: string): RailModel {
  const next = detach(model, projectKey);
  return { ...next, order: [...next.order, `p:${projectKey}`] };
}

export function railTopTokenOf(model: RailModel, projectKey: string): string {
  const group = findRailGroupOf(model, projectKey);
  return group ? `g:${group.id}` : `p:${projectKey}`;
}

export function moveRailTokenToEnd(model: RailModel, token: string): RailModel {
  if (token.startsWith("p:")) return moveRailProjectToEnd(model, token.slice(2));
  if (!model.order.includes(token)) return model;
  return { ...model, order: [...model.order.filter((candidate) => candidate !== token), token] };
}
