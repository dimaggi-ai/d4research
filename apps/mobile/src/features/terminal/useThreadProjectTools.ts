import { useNavigation } from "@react-navigation/native";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_SERVER_SETTINGS,
  type ProjectScript,
} from "@d4research/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@d4research/shared/projectScripts";

import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentScope } from "../../state/session";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { stagePendingTerminalLaunch } from "./terminalLaunchContext";
import { buildTerminalMenuSessions, resolveProjectScriptTerminalId } from "./terminalMenu";

export function useThreadProjectTools() {
  const navigation = useNavigation();
  const {
    selectedThread: thread,
    selectedThreadProject: project,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const { selectedThreadWorktreePath: worktreePath } = useSelectedThreadWorktree();
  const { sessions: knownTerminalSessions } = useKnownTerminalSessions({
    environmentId: thread?.environmentId ?? null,
    threadId: thread?.id ?? null,
  });
  const terminalMenuSessions = buildTerminalMenuSessions({
    knownSessions: knownTerminalSessions ?? [],
    workspaceRoot: project?.workspaceRoot ?? null,
  });
  const projectScripts = project
    ? resolveProjectScripts(
        selectedEnvironmentRuntime?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        project,
      )
    : [];
  const runProjectScript = (script: ProjectScript) => {
    if (
      !thread ||
      !project?.workspaceRoot ||
      !readEnvironmentScope(thread.environmentId, AuthTerminalOperateScope)
    )
      return;
    const terminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
      ...(knownTerminalSessions === null ||
      !readEnvironmentScope(thread.environmentId, AuthTerminalReadScope)
        ? { uniqueSuffix: uuidv4() }
        : {}),
      hasRunningTerminal: terminalMenuSessions.some(
        (session) => session.status === "running" || session.status === "starting",
      ),
    });
    stagePendingTerminalLaunch({
      target: { environmentId: thread.environmentId, threadId: thread.id, terminalId },
      launch: {
        cwd: projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }),
        worktreePath,
        env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }),
        initialInput: projectScriptTerminalInput(script.command),
      },
    });
    navigation.navigate("ThreadTerminal", {
      environmentId: String(thread.environmentId),
      threadId: String(thread.id),
      terminalId,
    });
  };
  return { knownTerminalSessions, terminalMenuSessions, projectScripts, runProjectScript };
}
