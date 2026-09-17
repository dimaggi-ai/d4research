import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import type { EnvironmentId } from "@d4research/contracts";
import { useCallback, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SettingsScreen } from "./components/SettingsScreen";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
} from "../showcase/showcaseEnvironmentRows";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const localEnvironments = SHOWCASE_ENABLED
    ? applyShowcaseLocalEnvironmentDisplayUrls(connectedEnvironments)
    : connectedEnvironments;
  const hasLocalEnvironments = localEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const headerIconColor = useUniwindTheme()["--color-icon"];

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);
  const handleUpdateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => {
      if (!SHOWCASE_ENABLED) return onUpdateEnvironment(environmentId, updates);
      const actualEnvironment = connectedEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      const presentedEnvironment = localEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      return onUpdateEnvironment(environmentId, {
        ...updates,
        displayUrl:
          actualEnvironment && presentedEnvironment
            ? resolveShowcaseEnvironmentUpdateDisplayUrl({
                actualDisplayUrl: actualEnvironment.displayUrl,
                presentedDisplayUrl: presentedEnvironment.displayUrl,
                submittedDisplayUrl: updates.displayUrl,
              })
            : updates.displayUrl,
      });
    },
    [connectedEnvironments, localEnvironments, onUpdateEnvironment],
  );

  return (
    <SettingsScreen
      title="Environments"
      actions={[
        {
          accessibilityLabel: "Add environment",
          icon: "plus",
          onPress: () =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironmentNew" },
            }),
        },
      ]}
    >
      {Platform.OS !== "android" ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            icon="plus"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsEnvironmentNew" },
              })
            }
            separateBackground
            tintColor={headerIconColor}
          />
        </NativeHeaderToolbar>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {hasLocalEnvironments ? (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {localEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                className={cn(index !== 0 && "border-t border-border")}
              >
                <ConnectionEnvironmentRow
                  environment={environment}
                  expanded={expandedId === environment.environmentId}
                  onToggle={() => handleToggle(environment.environmentId)}
                  onReconnect={onReconnectEnvironment}
                  onRemove={onRemoveEnvironmentPress}
                  onSetEnabled={onSetEnvironmentEnabled}
                  onUpdate={handleUpdateEnvironment}
                />
              </View>
            ))}
          </View>
        ) : (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
              <SymbolView
                name="point.3.connected.trianglepath.dotted"
                size={20}
                tintColorClassName={"accent-icon-muted"}
                type="monochrome"
              />
            </View>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              No environments connected yet.{"\n"}Tap{" "}
              <Text className="font-t3-bold text-foreground">+</Text> to add one.
            </Text>
          </View>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
