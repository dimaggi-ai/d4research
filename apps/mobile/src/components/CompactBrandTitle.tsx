import Constants from "expo-constants";
import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";
import { T3Wordmark } from "./T3Wordmark";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { useThemeColor } from "../lib/useThemeColor";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

// Native leading items inherit different UIKit margins than title views.
const IOS_NATIVE_LEADING_TITLE_OFFSET = -6;
const IPAD_NATIVE_LEADING_TITLE_OFFSET = 7;

/**
 * Horizontal correction applied to content rendered in the brand title slot,
 * shared with the connection-status swap so both align identically.
 */
export function brandTitleOffset(nativeLeadingItem: boolean): number {
  if (Platform.OS !== "ios") return 0;
  if (nativeLeadingItem) {
    return Platform.isPad ? IPAD_NATIVE_LEADING_TITLE_OFFSET : IOS_NATIVE_LEADING_TITLE_OFFSET;
  }
  return Platform.isPad ? IPAD_HOME_TITLE_OFFSET : 0;
}

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle(
  props: {
    readonly nativeLeadingItem?: boolean;
  } = {},
) {
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const titleOffset = brandTitleOffset(props.nativeLeadingItem === true);
  const { scale } = useAndroidControlSizing();

  return (
    <View
      aria-level={1}
      accessibilityLabel="T3 Code, Threads"
      accessible
      role="heading"
      style={[
        {
          alignItems: "center",
          flexDirection: "row",
          gap: 6,
          marginLeft: titleOffset,
        },
        Platform.OS === "android" && { gap: 5.25 * scale },
      ]}
    >
      <T3Wordmark color={iconColor} height={Math.round(15 * scale)} />
      <Text
        style={{
          color: mutedColor,
          fontFamily: "DMSans-Medium",
          fontSize: 21 * scale,
          letterSpacing: -0.5 * scale,
        }}
      >
        Code
      </Text>
      <View
        style={[
          {
            backgroundColor: subtleColor,
            borderRadius: 999,
            paddingHorizontal: 6,
            paddingVertical: 2,
          },
          Platform.OS === "android" && {
            paddingHorizontal: 5.25 * scale,
            paddingVertical: 1.75 * scale,
          },
        ]}
      >
        <Text
          style={{
            color: mutedColor,
            fontFamily: "DMSans-Bold",
            fontSize: 9 * scale,
            letterSpacing: 0.9 * scale,
            textTransform: "uppercase",
          }}
        >
          {stageLabel}
        </Text>
      </View>
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle />;
}

export function renderCompactBrandHeaderItems(): NativeStackHeaderItem[] {
  return [
    {
      element: <CompactBrandTitle nativeLeadingItem />,
      hidesSharedBackground: true,
      type: "custom",
    },
  ];
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  if (Platform.OS === "ios" && NATIVE_LIQUID_GLASS_SUPPORTED) {
    return {
      headerTitle: "Threads",
      headerTitleStyle: { color: "transparent", fontSize: 18, fontWeight: "800" },
      title: "Threads",
      unstable_headerLeftItems: renderCompactBrandHeaderItems,
    };
  }

  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
  };
}
