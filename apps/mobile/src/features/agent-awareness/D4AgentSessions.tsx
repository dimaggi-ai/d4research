import type { D4AgentState, EnvironmentId } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function D4AgentSessions({
  environmentId,
  sessions,
  refresh,
}: {
  environmentId: EnvironmentId;
  sessions: NonNullable<D4AgentState["openSessions"]>;
  refresh: () => void;
}) {
  const close = useAtomCommand(serverEnvironment.closeD4AgentSession);
  const allowed = useAtomValue(serverEnvironment.closeD4AgentSession.permissionAtom(environmentId));
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  return (
    <View className="gap-2 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="text-sm text-accent">Open sessions · {sessions.length}/4</Text>
      </Pressable>
      {expanded && sessions.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No open sessions.</Text>
      ) : null}
      {expanded
        ? sessions.map((session) => (
            <View key={session.context} className="gap-2 border-b border-border py-2">
              <Text className="text-sm font-t3-semibold text-foreground">{session.context}</Text>
              <Text className="text-xs text-foreground-muted">
                Last activity: {session.lastActivityAt}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {session.inputTokens} input tokens · context window{" "}
                {session.contextWindow ?? "unavailable"}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !allowed || busy !== null }}
                disabled={!allowed || busy !== null}
                className="py-2"
                onPress={async () => {
                  setBusy(session.context);
                  setError(false);
                  try {
                    const result = await close({
                      environmentId,
                      input: { context: session.context },
                    });
                    if (result._tag === "Failure") setError(true);
                    else refresh();
                  } catch {
                    setError(true);
                  }
                  setBusy(null);
                }}
              >
                <Text className="text-accent">
                  {busy === session.context ? "Closing…" : `Close ${session.context} session`}
                </Text>
              </Pressable>
            </View>
          ))
        : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
          Could not close this session.
        </Text>
      ) : null}
    </View>
  );
}
