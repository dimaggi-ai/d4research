import { useState, useLayoutEffect } from "react";
import { Platform, Pressable, StyleSheet, View, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { cn } from "../../lib/cn";

const ACCESSIBILITY_RESIZE_STEP = 24;

interface WorkspacePaneDividerProps {
  readonly accessibilityLabel: string;
  readonly currentWidth: number;
  readonly resizeDirection: 1 | -1;
  readonly onResizeStart?: () => void;
  readonly onResizeBy: (delta: number) => void;
  readonly onResizeEnd?: () => void;
}

function createResizeGesture(
  props: WorkspacePaneDividerProps,
  setDragging: (value: boolean) => void,
) {
  let latest = props;
  const start = () => {
    setDragging(true);
    latest.onResizeStart?.();
  };
  const resize = (delta: number) => latest.onResizeBy(delta * latest.resizeDirection);
  const end = () => {
    setDragging(false);
    latest.onResizeEnd?.();
  };
  const gesture = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .failOffsetY([-24, 24])
    .onStart(() => {
      runOnJS(start)();
    })
    .onUpdate((event) => {
      runOnJS(resize)(event.translationX);
    })
    .onFinalize(() => {
      runOnJS(end)();
    });
  return {
    gesture,
    update(next: WorkspacePaneDividerProps) {
      latest = next;
    },
  };
}

export function WorkspacePaneDivider(props: WorkspacePaneDividerProps) {
  const [dragging, setDragging] = useState(false);
  const [controller] = useState(() => createResizeGesture(props, setDragging));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the native resize gesture on the latest committed direction and callbacks.
  useLayoutEffect(() => controller.update(props), [controller, props]);

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    props.onResizeStart?.();
    if (event.nativeEvent.actionName === "increment") {
      props.onResizeBy(ACCESSIBILITY_RESIZE_STEP);
    } else if (event.nativeEvent.actionName === "decrement") {
      props.onResizeBy(-ACCESSIBILITY_RESIZE_STEP);
    }
    props.onResizeEnd?.();
  };

  return (
    <GestureDetector gesture={controller.gesture}>
      <Pressable
        className="relative z-[100] -mx-[22px] w-11 self-stretch justify-center"
        accessibilityActions={[
          { name: "increment", label: "Make pane wider" },
          { name: "decrement", label: "Make pane narrower" },
        ]}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="adjustable"
        accessibilityValue={{
          now: Math.round(props.currentWidth),
          text: `${Math.round(props.currentWidth)} points wide`,
        }}
        onAccessibilityAction={handleAccessibilityAction}
      >
        <View
          className={cn(
            "h-full self-center bg-border opacity-70",
            dragging ? "w-0.5 bg-primary opacity-100" : "w-px",
            Platform.OS === "android" && !dragging && "opacity-0",
          )}
          style={[styles.line, dragging && styles.activeLine]}
        />
      </Pressable>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  line: {
    alignSelf: "center",
    height: "100%",
    width: StyleSheet.hairlineWidth,
  },
  activeLine: {
    width: 2,
  },
});
