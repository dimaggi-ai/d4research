import { memo } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import type { TurnDiffSummary } from "./turn-diff-summary";

export const TurnDiffCard = memo(function TurnDiffCard(props: {
  readonly summary: TurnDiffSummary;
  readonly onOpen: (checkpointTurnCount: number) => void;
}) {
  const { summary, onOpen } = props;
  const label = `${summary.fileCount} file${summary.fileCount === 1 ? "" : "s"} changed`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open diff, ${label}`}
      onPress={() => onOpen(summary.checkpointTurnCount)}
      className="my-2 min-h-11 flex-row flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-card px-3 py-2"
    >
      <View className="flex-row flex-wrap items-center gap-2">
        <AppText className="text-sm text-foreground-muted">{label}</AppText>
        <AppText className="text-xs tabular-nums text-foreground-muted">
          +{summary.additions} -{summary.deletions}
        </AppText>
      </View>
      <AppText className="font-t3-medium text-sm text-foreground">Open diff</AppText>
    </Pressable>
  );
});
