import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform } from "react-native";

import {
  brandTitleOffset,
  CompactBrandTitle,
  getCompactBrandHeaderOptions as getBrandHeaderOptions,
} from "../../../components/CompactBrandTitle";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";

function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  const options = getBrandHeaderOptions(fallbackTitleStyle);
  if (options.unstable_headerLeftItems) return options;
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}

export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
}): NativeStackNavigationOptions {
  const maxWidth = Math.max(0, opts.headerWidth - 64 - 44 * (opts.trailingItemCount ?? 1));

  const options = getCompactBrandHeaderOptions(opts.fallbackTitleStyle);
  const nativeLeadingItem = options.unstable_headerLeftItems !== undefined;
  const renderTitle = () => (
    <WorkspaceConnectionTitle
      brand={<CompactBrandTitle nativeLeadingItem={nativeLeadingItem} />}
      maxWidth={maxWidth}
      onPress={opts.onOpenEnvironments}
      statusOffset={brandTitleOffset(nativeLeadingItem)}
    />
  );
  return nativeLeadingItem
    ? {
        ...options,
        unstable_headerLeftItems: () => [
          { type: "custom", element: renderTitle(), hidesSharedBackground: true },
        ],
      }
    : { ...options, headerTitle: renderTitle };
}
