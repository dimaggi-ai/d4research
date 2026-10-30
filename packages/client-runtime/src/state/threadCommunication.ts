import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThread } from "./models.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";
import { deriveProviderSubagentStatus, deriveReportedModelSelection } from "./threadExecution.ts";

export interface CommunicationParticipant {
  readonly id: string;
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: ThreadId | null;
  readonly parentId: string | null;
  readonly status: string;
  readonly model: string | null;
  readonly lastActivityAt?: string;
}

export interface CommunicationMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly summary: string | null;
  readonly at: string;
  readonly kind: "message" | "delegation" | "response";
  readonly state: "sent" | "received" | "pending" | "failed" | "recorded";
}

export interface ThreadCommunication {
  readonly rootId: string;
  readonly participants: ReadonlyArray<CommunicationParticipant>;
  readonly messages: ReadonlyArray<CommunicationMessage>;
}

/** Semantic status colors shared by both communication viewers. */
export function communicationStatusTone(status: string) {
  switch (status) {
    case "working":
    case "running":
    case "in_progress":
    case "preparing":
    case "starting":
    case "queued":
    case "pending":
    case "sent":
      return "working";
    case "waiting":
    case "monitoring":
    case "blocked":
    case "recorded":
      return "monitoring";
    case "completed":
    case "received":
    case "resolved_native":
    case "resolved_portable":
    case "consumed":
      return "done";
    case "failed":
    case "error":
      return "failed";
    case "input":
    case "awaiting_input":
      return "input";
    case "approval":
    case "awaiting_approval":
    case "limited":
    case "cancelled":
    case "interrupted":
    case "rolled_back":
    case "superseded":
      return "attention";
    default:
      return "neutral";
  }
}

export function communicationStatusLabel(status: string): string {
  if (status === "unknown") return "Status unavailable";
  const words = status.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function communicationThreadKey(ref: ScopedThreadRef): string {
  return `${ref.environmentId}:${ref.threadId}`;
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function outputObject(value: unknown): Record<string, unknown> | null {
  const data = object(value);
  if (data === null) return null;
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      const parsed = object(object(block)?.text);
      if (parsed !== null) return parsed;
    }
  }
  return object(data.structuredContent) ?? object(data.result) ?? data;
}

/** Reads existing projections; opening the viewer never dispatches an agent turn. */
export function deriveThreadCommunication(input: {
  readonly root: ScopedThreadRef;
  readonly threads: ReadonlyArray<EnvironmentThread>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
}): ThreadCommunication {
  const participants = new Map<string, CommunicationParticipant>();
  const messages = new Map<string, CommunicationMessage>();
  const textsByRoute = new Map<string, Set<string>>();
  // Native task IDs are scoped to the owning conversation, not globally unique.
  const aliases = new Map<string, string>();
  const rootId = communicationThreadKey(input.root);
  const environmentLabel = (id: EnvironmentId) =>
    input.environmentLabels.get(id) ?? "Other environment";
  const ensure = (ref: ScopedThreadRef, label?: string, parentId: string | null = null) => {
    const id = communicationThreadKey(ref);
    if (!participants.has(id))
      participants.set(id, {
        id,
        label: label ?? "Agent thread",
        environmentId: ref.environmentId,
        environmentLabel: environmentLabel(ref.environmentId),
        threadId: ref.threadId,
        parentId,
        status: "unknown",
        model: null,
      });
    return id;
  };
  ensure(input.root, "Parent agent");
  for (const { environmentId, projection } of input.threads) {
    const thread = projection.thread;
    const id = ensure({ environmentId, threadId: thread.id });
    const parent =
      thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId !== null
        ? ensure({ environmentId, threadId: thread.lineage.parentThreadId }, "Parent agent")
        : null;
    participants.set(id, {
      id,
      label: formatSubagentDisplayTitle(thread.title),
      environmentId,
      environmentLabel: environmentLabel(environmentId),
      threadId: thread.id,
      parentId: parent ?? participants.get(id)?.parentId ?? null,
      lastActivityAt: DateTime.formatIso(thread.updatedAt),
      status:
        projection.runs.at(-1)?.status ??
        deriveProviderSubagentStatus(projection)?.status ??
        (participants.get(id)?.status !== "unknown" ? participants.get(id)?.status : null) ??
        "idle",
      model:
        deriveReportedModelSelection(projection)?.model ??
        participants.get(id)?.model ??
        thread.modelSelection.model,
    });
    for (const agent of projection.subagents) {
      const native = agent.nativeTaskRef?.nativeId ?? agent.id;
      const childId =
        agent.childThreadId === null
          ? `native:${id}:${native}`
          : ensure({ environmentId, threadId: agent.childThreadId });
      const label = formatSubagentDisplayTitle(
        agent.title ?? agent.prompt.split("\n")[0] ?? "Subagent",
      );
      participants.set(childId, {
        id: childId,
        label,
        environmentId,
        environmentLabel: environmentLabel(environmentId),
        threadId: agent.childThreadId,
        parentId: id,
        status: agent.status,
        model: agent.model,
        lastActivityAt: DateTime.formatIso(agent.updatedAt),
      });
      for (const alias of [native, agent.id, agent.childThreadId, agent.title]) {
        if (alias !== null) aliases.set(`${id}:${alias}`, childId);
      }
    }
  }
  const nativeRecipient = (owner: string, environmentId: EnvironmentId, name: string) => {
    const parent = participants.get(owner)?.parentId ?? owner;
    if (["parent", "team-lead", "leader"].includes(name)) return parent;
    const known = aliases.get(`${owner}:${name}`) ?? aliases.get(`${parent}:${name}`);
    if (known !== undefined) return known;
    const direct = participants.get(`${environmentId}:${name}`);
    if (direct !== undefined) return direct.id;
    const id = `native:${parent}:${name}`;
    if (!participants.has(id))
      participants.set(id, {
        id,
        label: name,
        environmentId,
        environmentLabel: environmentLabel(environmentId),
        threadId: null,
        parentId: parent,
        status: "unknown",
        model: null,
      });
    return id;
  };
  const add = (message: CommunicationMessage) => {
    if (!message.text.trim()) return;
    const previous = messages.get(message.id);
    if (previous?.state === "received" && message.state !== "received") return;
    messages.set(message.id, message);
    const route = `${message.from}\0${message.to}`;
    const texts = textsByRoute.get(route) ?? new Set<string>();
    texts.add(message.text);
    textsByRoute.set(route, texts);
  };
  for (const { environmentId, projection } of input.threads) {
    const owner = communicationThreadKey({ environmentId, threadId: projection.thread.id });
    for (const agent of projection.subagents) {
      const child = nativeRecipient(
        owner,
        environmentId,
        agent.nativeTaskRef?.nativeId ?? agent.id,
      );
      if (agent.prompt)
        add({
          id: `delegation:${environmentId}:${agent.id}`,
          from: owner,
          to: child,
          text: agent.prompt,
          summary: "Task assigned",
          at: DateTime.formatIso(agent.startedAt ?? agent.updatedAt),
          kind: "delegation",
          state: "sent",
        });
      if (agent.result)
        add({
          id: `result:${environmentId}:${agent.id}`,
          from: child,
          to: owner,
          text: agent.result,
          summary: "Task result",
          at: DateTime.formatIso(agent.completedAt ?? agent.updatedAt),
          kind: "response",
          state: "received",
        });
    }
    for (const item of projection.turnItems) {
      if (item.type !== "dynamic_tool" || item.toolName === null) continue;
      const name = item.toolName.split("__").at(-1)?.split(".").at(-1)?.toLowerCase();
      const data = object(item.input);
      if (data === null) continue;
      const at = DateTime.formatIso(item.startedAt ?? item.updatedAt);
      const state =
        item.status === "failed" ? "failed" : item.status === "completed" ? "sent" : "pending";
      if (name === "t3_peer_thread_send") {
        const env = string(data.environmentId),
          thread = string(data.threadId),
          text = string(data.message);
        if (env === null || thread === null || text === null) continue;
        const to = ensure({
          environmentId: EnvironmentId.make(env),
          threadId: ThreadId.make(thread),
        });
        const messageId = string(outputObject(item.output)?.messageId);
        add({
          id:
            messageId === null
              ? `tool:${environmentId}:${item.id}`
              : `delivery:${env}:${messageId}`,
          from: owner,
          to,
          text,
          summary: null,
          at,
          kind: "message",
          state,
        });
      } else if (name === "sendmessage" || name === "send_input" || name === "t3_thread_send") {
        const recipient =
          data.type === "broadcast"
            ? "all"
            : (string(data.to) ??
              string(data.recipient) ??
              string(data.id) ??
              string(data.threadId));
        const text = string(data.message) ?? string(data.content);
        if (recipient === null || text === null) continue;
        const targets =
          data.type === "broadcast" || recipient === "all"
            ? [...participants.values()]
                .filter((p) => p.parentId === owner && p.id !== owner)
                .map((p) => p.id)
            : [nativeRecipient(owner, environmentId, recipient)];
        for (const to of targets)
          add({
            id: `tool:${environmentId}:${item.id}:${to}`,
            from: owner,
            to,
            text,
            summary: string(data.summary),
            at,
            kind: "message",
            state,
          });
      }
    }
    const requestsByRun = new Map(
      projection.messages
        .filter(
          (message) =>
            message.role === "user" &&
            message.runId !== null &&
            (message.senderThreadId !== undefined || message.createdBy === "agent"),
        )
        .map((message) => [message.runId, message]),
    );
    for (const message of projection.messages) {
      if (message.role === "assistant") {
        let parent = participants.get(owner)?.parentId;
        const request = message.runId === null ? undefined : requestsByRun.get(message.runId);
        if (request?.senderThreadId !== undefined)
          parent = ensure({ environmentId, threadId: request.senderThreadId });
        else if (request !== undefined) {
          const header =
            /^Agent message from (.+)\nSource environment: ([^\n]+)\nSource thread: ([^\n]+)\n\n/u.exec(
              request.text,
            );
          if (header !== null)
            parent = ensure(
              {
                environmentId: EnvironmentId.make(header[2]!),
                threadId: ThreadId.make(header[3]!),
              },
              header[1],
            );
        }
        if (
          parent !== null &&
          parent !== undefined &&
          !textsByRoute.get(`${owner}\0${parent}`)?.has(message.text)
        )
          add({
            id: `response:${environmentId}:${message.id}`,
            from: owner,
            to: parent,
            text: message.text,
            summary: "Reply in agent thread",
            at: DateTime.formatIso(message.createdAt),
            kind: "response",
            state: "recorded",
          });
        continue;
      }
      if (message.role !== "user") continue;
      const header =
        /^(Agent message from|Reply from) (.+)\nSource environment: ([^\n]+)\nSource thread: ([^\n]+)\n(?:Run: [^\n]+\n)?\n([\s\S]*)$/u.exec(
          message.text,
        );
      if (
        header !== null &&
        (message.createdBy === "agent" || message.creationSource === "server")
      ) {
        const ref = {
          environmentId: EnvironmentId.make(header[3]!),
          threadId: ThreadId.make(header[4]!),
        };
        const from = ensure(ref, header[2]);
        add({
          id: `delivery:${environmentId}:${message.id}`,
          from,
          to: owner,
          text: header[5]!,
          summary: header[1] === "Reply from" ? "Watched reply" : null,
          at: DateTime.formatIso(message.createdAt),
          kind: header[1] === "Reply from" ? "response" : "message",
          state: "received",
        });
      } else if (message.senderThreadId !== undefined) {
        add({
          id: `delivery:${environmentId}:${message.id}`,
          from: ensure({ environmentId, threadId: message.senderThreadId }),
          to: owner,
          text: message.text,
          summary: null,
          at: DateTime.formatIso(message.createdAt),
          kind: "message",
          state: "received",
        });
      } else if (message.creationSource === "provider") {
        for (const match of message.text.matchAll(
          /<teammate-message\s+([^>]+)>([\s\S]*?)<\/teammate-message>/gu,
        )) {
          const sender = /teammate_id=["']([^"']+)["']/u.exec(match[1]!);
          if (sender === null) continue;
          add({
            id: `native-message:${environmentId}:${message.id}:${match.index}`,
            from: nativeRecipient(owner, environmentId, sender[1]!),
            to: owner,
            text: match[2]!,
            summary: /summary=["']([^"']+)["']/u.exec(match[1]!)?.[1] ?? null,
            at: DateTime.formatIso(message.createdAt),
            kind: "message",
            state: "received",
          });
        }
      }
    }
  }
  return {
    rootId,
    participants: [...participants.values()],
    messages: [...messages.values()].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
    ),
  };
}

export type CommunicationSelection =
  | { readonly kind: "all" }
  | { readonly kind: "participant"; readonly id: string }
  | { readonly kind: "connection"; readonly from: string; readonly to: string };

export function selectCommunicationMessages(
  model: ThreadCommunication,
  selection: CommunicationSelection,
) {
  const fromParent =
    selection.kind === "connection"
      ? model.participants.find((p) => p.id === selection.from)?.parentId
      : null;
  const toParent =
    selection.kind === "connection"
      ? model.participants.find((p) => p.id === selection.to)?.parentId
      : null;
  return model.messages.filter(
    (message) =>
      selection.kind === "all" ||
      (selection.kind === "participant"
        ? message.from === selection.id || message.to === selection.id
        : (message.from === selection.from && message.to === selection.to) ||
          (message.from === selection.to && message.to === selection.from) ||
          (fromParent !== null &&
            fromParent !== undefined &&
            fromParent === toParent &&
            message.kind === "message" &&
            message.from === fromParent &&
            (message.to === selection.from || message.to === selection.to))),
  );
}

/** Only the inspected pair/agent opens extra detail streams; unrelated children stay on shells. */
export function communicationDetailRefs(
  model: ThreadCommunication,
  selection: CommunicationSelection,
): ReadonlyArray<ScopedThreadRef> {
  const ids =
    selection.kind === "all"
      ? []
      : selection.kind === "participant"
        ? [selection.id]
        : [selection.from, selection.to];
  return model.participants.flatMap((p) =>
    ids.includes(p.id) && p.threadId !== null
      ? [{ environmentId: p.environmentId, threadId: p.threadId }]
      : [],
  );
}

/** Keep discovered communication while only the selected detail streams remain subscribed. */
export function retainThreadCommunication(
  previous: ThreadCommunication | null,
  current: ThreadCommunication,
): ThreadCommunication {
  if (previous === null || previous.rootId !== current.rootId)
    return { ...current, participants: recentCommunicationParticipants(current) };
  const participants = new Map(
    previous.participants.map((participant) => [participant.id, participant]),
  );
  const messages = new Map(previous.messages.map((message) => [message.id, message]));
  for (const participant of recentCommunicationParticipants(current)) {
    const old = participants.get(participant.id);
    if (!old) {
      participants.set(participant.id, participant);
      continue;
    }
    const newer =
      (Date.parse(old.lastActivityAt ?? "") || 0) >
      (Date.parse(participant.lastActivityAt ?? "") || 0);
    const update = {
      ...participant,
      ...(newer ? old : {}),
      parentId: participant.parentId ?? old.parentId,
      model: participant.model ?? old.model,
      status:
        participant.status === "unknown" ? old.status : newer ? old.status : participant.status,
      environmentLabel: participant.environmentLabel,
    };
    participants.set(participant.id, update);
  }
  for (const message of current.messages) {
    const old = messages.get(message.id);
    if (old?.state !== "received" || message.state === "received")
      messages.set(message.id, message);
  }
  return {
    rootId: current.rootId,
    participants: [...participants.values()],
    messages: [...messages.values()].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
    ),
  };
}

/** Activity order is independent of the selected task and deterministic for equal timestamps. */
export function communicationParticipantActivity(
  model: ThreadCommunication,
): ReadonlyMap<string, number> {
  const activity = new Map(
    model.participants.map((participant) => [
      participant.id,
      Date.parse(participant.lastActivityAt ?? "") || 0,
    ]),
  );
  for (const message of model.messages) {
    const at = Date.parse(message.at) || 0;
    for (const id of [message.from, message.to])
      activity.set(id, Math.max(at, activity.get(id) ?? 0));
  }
  return activity;
}

export function recentCommunicationParticipants(
  model: ThreadCommunication,
): ReadonlyArray<CommunicationParticipant> {
  const activity = communicationParticipantActivity(model);
  return [...model.participants].sort(
    (a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0),
  );
}
