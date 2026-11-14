import type { ModelSelection } from "@d4research/contracts";
import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { ModelRow } from "../threads/ThreadSettingsRows";

export function PickerSheet(props: {
  readonly title: string;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly contentContainerClassName: string;
  readonly children: ReactNode;
}) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-background pt-6">
        <View className="flex-row items-center justify-between px-5 pb-4">
          <Text className="text-lg font-t3-semibold text-foreground">{props.title}</Text>
          <Pressable accessibilityRole="button" className="p-2" onPress={props.onClose}>
            <Text className="text-base text-accent">Done</Text>
          </Pressable>
        </View>
        <ScreenScrollView contentContainerClassName={props.contentContainerClassName}>
          {props.children}
        </ScreenScrollView>
      </View>
    </Modal>
  );
}

export function ModelPickerSheet(props: {
  readonly title: string;
  readonly visible: boolean;
  readonly groups: ReadonlyArray<ProviderGroup>;
  readonly selected: ModelSelection | null;
  readonly onSelect: (option: ModelOption) => void;
  readonly onClose: () => void;
}) {
  return (
    <PickerSheet
      title={props.title}
      visible={props.visible}
      onClose={props.onClose}
      contentContainerClassName="gap-4 pb-10"
    >
      {props.groups.map((group) => (
        <View key={group.providerKey} className="gap-2">
          <Text className="px-5 text-sm text-foreground-muted">{group.providerLabel}</Text>
          {group.models.map((option, index) => (
            <ModelRow
              key={option.key}
              option={option}
              selected={
                option.selection.instanceId === props.selected?.instanceId &&
                option.selection.model === props.selected?.model
              }
              onPress={() => props.onSelect(option)}
              isFavorite={false}
              favoritesLoaded={false}
              onToggleFavorite={() => {}}
              isFirst={index === 0}
              isLast={index === group.models.length - 1}
            />
          ))}
        </View>
      ))}
      {props.groups.length === 0 ? (
        <Text className="p-5 text-sm text-foreground-muted">No providers available.</Text>
      ) : null}
    </PickerSheet>
  );
}
