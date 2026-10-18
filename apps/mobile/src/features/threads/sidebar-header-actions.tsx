import { SymbolView } from "../../components/ui/AppSymbol";
import { Pressable, StyleSheet, View } from "react-native";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  /** Rendered inside a shared capsule group — buttons drop their own chrome. */
  readonly grouped?: boolean;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "gearshape" | "square.and.pencil";
  readonly grouped?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      className={`h-11 w-[50px] items-center justify-center rounded-[22px] active:bg-subtle ${props.grouped ? "bg-transparent" : "bg-subtle border-border"}`}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
      style={{ borderWidth: props.grouped ? 0 : StyleSheet.hairlineWidth }}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="flex-row items-center gap-0.5">
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        grouped={props.grouped}
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
