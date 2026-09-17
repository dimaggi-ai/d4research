import { MenuView } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import {
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useMemo,
  useRef,
} from "react";
import { Platform, Pressable, View, type ColorValue, type AccessibilityProps } from "react-native";
import { withUniwind } from "uniwind";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { cn } from "../lib/cn";
import { withMenuActionIconColors } from "../lib/menu-action-colors";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { MaterialIconButton } from "./MaterialIconButton";
import { MaterialButton } from "./MaterialButton";

const ThemedMenuView = withUniwind(
  function NativeMenuView({
    iconColor,
    destructiveIconColor,
    ...props
  }: ComponentProps<typeof MenuView> & {
    readonly iconColor?: ColorValue;
    readonly destructiveIconColor?: ColorValue;
  }) {
    const actions = useMemo(
      () =>
        withMenuActionIconColors(props.actions, {
          icon: iconColor,
          destructiveIcon: destructiveIconColor,
        }),
      [props.actions, iconColor, destructiveIconColor],
    );
    return <MenuView {...props} actions={actions} />;
  },
  {
    iconColor: { fromClassName: "iconColorClassName", styleProperty: "accentColor" },
    destructiveIconColor: {
      fromClassName: "destructiveIconColorClassName",
      styleProperty: "accentColor",
    },
  },
);

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly activateOnPressIn?: boolean;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const variant = props.variant ?? "circle";
  const activatedOnPressInRef = useRef(false);

  const handlePressIn = () => {
    activatedOnPressInRef.current = true;
    props.onPress?.();
  };
  const handlePressOut = () => {
    // Pressability invokes onPressOut immediately before onPress on release.
    // Defer the reset so onPress can identify the same physical gesture.
    setTimeout(() => {
      activatedOnPressInRef.current = false;
    }, 0);
  };
  const handlePress = () => {
    if (activatedOnPressInRef.current) {
      return;
    }
    props.onPress?.();
  };

  const iconTintClassName =
    variant === "primary"
      ? props.disabled
        ? "accent-icon-subtle"
        : "accent-primary-foreground"
      : variant === "danger"
        ? "accent-danger-foreground"
        : "accent-icon";

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);
  const containerClassName = cn(
    isCircle
      ? "h-11 w-11 items-center justify-center rounded-full"
      : variant === "primary"
        ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
        : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5",
    variant === "primary"
      ? props.disabled
        ? "bg-subtle-strong"
        : "bg-primary"
      : variant === "danger"
        ? "bg-danger"
        : "bg-subtle",
    props.className,
  );
  const labelClassName = cn(
    "text-center text-xs font-t3-bold",
    variant === "primary"
      ? props.disabled
        ? "text-foreground-muted"
        : "text-primary-foreground"
      : "",
  );

  if (
    Platform.OS === "android" &&
    (variant === "pill" || variant === "primary") &&
    props.label &&
    props.onPress &&
    !props.icon &&
    !props.iconNode &&
    !props.className &&
    !props.activateOnPressIn &&
    (!props.accessibilityLabel || props.accessibilityLabel === props.label)
  ) {
    return (
      <MaterialButton
        label={props.label}
        onPress={props.onPress}
        disabled={props.disabled}
        tone={variant === "primary" ? "primary" : "secondary"}
      />
    );
  }

  if (
    Platform.OS === "android" &&
    props.accessibilityLabel &&
    props.icon &&
    !props.iconNode &&
    !props.label &&
    !props.className &&
    !props.activateOnPressIn
  ) {
    return (
      <MaterialIconButton
        accessibilityLabel={props.accessibilityLabel}
        icon={props.icon}
        onPress={props.onPress}
        disabled={props.disabled}
        variant={variant === "primary" ? "primary" : variant === "danger" ? "danger" : "tonal"}
      />
    );
  }

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      onPress={props.activateOnPressIn ? handlePress : props.onPress}
      onPressIn={props.activateOnPressIn ? handlePressIn : undefined}
      onPressOut={props.activateOnPressIn ? handlePressOut : undefined}
      disabled={props.disabled}
      className={containerClassName}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName={iconTintClassName}
          type="monochrome"
        />
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </Pressable>
  );
}

// iOS renders UIMenu; AndroidAnchoredMenu adapts the same actions to the
// selected Android appearance and keeps editor menus above the keyboard.
export function ControlPillMenu(
  props: Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> &
    Pick<AccessibilityProps, "accessible" | "accessibilityLabel" | "accessibilityRole"> & {
      readonly children: ReactNode;
      readonly className?: string;
    },
) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  if (Platform.OS === "android") {
    // Long-press menus keep their child interactive: the child element gets
    // an injected onLongPress (mirroring the iOS context-menu interaction)
    // so its own tap handling still works.
    if (props.shouldOpenOnLongPress && isValidElement(props.children)) {
      const child = props.children as ReactElement<{ onLongPress?: () => void }>;
      return (
        <AndroidAnchoredMenu
          actions={props.actions}
          className={props.className}
          title={props.title}
          style={props.style}
          onPressAction={props.onPressAction}
        >
          {(open) =>
            cloneElement(child, {
              onLongPress: () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                open();
              },
            })
          }
        </AndroidAnchoredMenu>
      );
    }
    return (
      <AndroidAnchoredMenu
        actions={props.actions}
        className={props.className}
        title={props.title}
        style={props.style}
        onPressAction={props.onPressAction}
      >
        {props.children}
      </AndroidAnchoredMenu>
    );
  }

  const { className: _className, ...menuProps } = props;
  let children = menuProps.children;
  // In long-press mode the wrapped pressable still receives the touch (the
  // patched MenuView button is touch-transparent) and RN's Fabric touch
  // handler is never cancelled by the in-tree UIContextMenuInteraction, so a
  // bare onPress would fire on finger-up even after the menu opened — and
  // also on a long press released just under the menu threshold. A dispatched
  // onLongPress makes Pressability swallow the release, so holds past 350ms
  // (below the ~500ms context-menu threshold) can only open the menu, never
  // tap through.
  if (props.shouldOpenOnLongPress && isValidElement(children)) {
    const child = children as ReactElement<{ onLongPress?: () => void; delayLongPress?: number }>;
    children = cloneElement(child, {
      onLongPress: child.props.onLongPress ?? (() => undefined),
      delayLongPress: child.props.delayLongPress ?? 350,
    });
  }
  return (
    <ThemedMenuView
      {...menuProps}
      iconColorClassName="accent-icon"
      destructiveIconColorClassName="accent-danger-foreground"
      themeVariant={isDarkMode ? "dark" : "light"}
    >
      {children}
    </ThemedMenuView>
  );
}
