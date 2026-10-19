import { SymbolView } from "../../components/ui/AppSymbol";
import { Pressable, StyleSheet } from "react-native";

export type SidebarFilterButtonIcon =
  | "line.3.horizontal.decrease.circle"
  | "line.3.horizontal.decrease.circle.fill";

export function SidebarFilterButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: SidebarFilterButtonIcon;
  /** Rendered inside a shared capsule group — no own background/border. */
  readonly grouped?: boolean;
}) {
  return (
    <Pressable
      className={`h-11 w-[50px] cursor-pointer items-center justify-center rounded-[22px] active:bg-subtle ${props.grouped ? "bg-transparent" : "bg-subtle border-border"}`}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
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
