import { useLayoutEffect, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { SymbolView } from "../../../components/ui/AppSymbol";

type SettingsDragHandleProps = {
  readonly title: string;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onStart: () => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
};

function createDragGesture(props: SettingsDragHandleProps) {
  let latest = props;
  let translation = 0;
  const gesture = Gesture.Pan()
    .minDistance(0)
    .shouldCancelWhenOutside(false)
    .runOnJS(true)
    .onStart(() => {
      translation = 0;
      latest.onStart();
    })
    .onUpdate((event) => {
      translation = event.translationY;
      latest.onMove(event.translationY);
    })
    .onFinalize((_, success) => latest.onEnd(translation, !success));
  return {
    gesture,
    update(next: SettingsDragHandleProps) {
      latest = next;
    },
  };
}

export function SettingsDragHandle(props: SettingsDragHandleProps) {
  const [controller] = useState(() => createDragGesture(props));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the mounted native gesture handlers on the latest committed callbacks.
  useLayoutEffect(() => controller.update(props), [controller, props]);
  return (
    <GestureDetector gesture={controller.gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${props.title}`}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        style={{ width: 48, alignSelf: "stretch", alignItems: "center", justifyContent: "center" }}
      >
        <SymbolView
          name="line.3.horizontal"
          size={20}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}
