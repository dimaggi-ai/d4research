import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Toast } from "../../components/ui/Toast";
import { useBarInset } from "../../components/ui/useBarInset";
import { MOBILE_MOTION } from "../../lib/designTokens";
import type { GitActionProgress } from "../../state/use-vcs-action-state";

export function GitActionProgressOverlay(props: {
  readonly progress: GitActionProgress;
  readonly onDismiss: () => void;
  readonly onOpenPullRequest?: (url: string) => Promise<boolean>;
}) {
  const { progress, onDismiss } = props;
  const openPullRequest = props.onOpenPullRequest;
  const prevPhaseRef = useRef(progress.phase);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Triggers native haptic feedback when the external git action finishes.
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = progress.phase;

    if (prev === "running" && progress.phase === "success") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (prev === "running" && progress.phase === "error") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [progress.phase]);

  const top = useBarInset() + 8;
  const handlePress = () => {
    if (progress.prUrl) {
      void (openPullRequest
        ? openPullRequest(progress.prUrl)
        : tryOpenExternalUrl(progress.prUrl, "pull-request"));
      return;
    }
    if (progress.phase === "success" || progress.phase === "error") {
      onDismiss();
    }
  };

  if (progress.phase === "idle") {
    return null;
  }

  return (
    <Animated.View
      entering={FadeIn.duration(MOBILE_MOTION.enter).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(MOBILE_MOTION.exit).reduceMotion(ReduceMotion.System)}
      className="absolute inset-x-3 z-[100]"
      style={{ top }}
      pointerEvents="box-none"
    >
      <Toast
        message={progress.label ?? "Source control"}
        description={progress.description ?? undefined}
        tone={
          progress.phase === "error"
            ? "danger"
            : progress.phase === "success"
              ? "success"
              : "default"
        }
        busy={progress.phase === "running"}
        action={progress.prUrl ? { label: "Open PR", onPress: handlePress } : undefined}
        onDismiss={progress.phase === "running" ? undefined : onDismiss}
      />
    </Animated.View>
  );
}
