import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ACCENT_COLOR_OPTIONS, resolveAccentHex } from "@d4research/shared/accentColors";
import { AsyncResult, Atom } from "effect/reactivity";
import { Modal, Pressable, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const threadColorAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    const preferences = get(mobilePreferencesAtom);
    return AsyncResult.isSuccess(preferences)
      ? (preferences.value.threadAccentColors?.[threadKey] ?? null)
      : null;
  }),
);

export function useThreadAccentColor(threadKey: string) {
  const hex = resolveAccentHex(useAtomValue(threadColorAtom(threadKey)));
  return hex?.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

export function ThreadColorPicker(props: {
  readonly threadKey: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const selected = useAtomValue(threadColorAtom(props.threadKey));
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const choose = (color: string | null) => {
    savePreferences({
      transform: (current) => {
        const colors = { ...current.threadAccentColors };
        if (color === null) delete colors[props.threadKey];
        else colors[props.threadKey] = color;
        return { threadAccentColors: colors };
      },
    });
    props.onClose();
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View className="flex-1 items-center justify-center px-6">
        <Pressable
          className="absolute inset-0 bg-black/50"
          accessibilityLabel="Close thread color picker"
          onPress={props.onClose}
        />
        <View
          accessibilityViewIsModal
          className="w-full max-w-[380px] rounded-3xl border border-border bg-sheet p-5"
        >
          <View className="flex-row items-center justify-between gap-3">
            <AppText accessibilityRole="header" className="text-xl font-t3-bold">
              Thread color
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close thread color picker"
              onPress={props.onClose}
              hitSlop={12}
            >
              <SymbolView name="xmark" size={18} tintColorClassName="accent-foreground-muted" />
            </Pressable>
          </View>
          <AppText className="mt-1 text-sm text-foreground-muted" numberOfLines={2}>
            {props.title}
          </AppText>
          <View className="mt-5 flex-row flex-wrap justify-between gap-y-4">
            {ACCENT_COLOR_OPTIONS.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityLabel={`${option.label} thread color`}
                accessibilityState={{ selected: selected === option.id }}
                onPress={() => choose(option.id)}
                className="w-1/5 items-center gap-1"
              >
                <View
                  style={{ backgroundColor: option.hex, width: 38, height: 38, borderRadius: 19 }}
                  className="items-center justify-center"
                >
                  {selected === option.id ? (
                    <SymbolView name="checkmark" size={18} tintColor="white" />
                  ) : null}
                </View>
                <AppText className="text-xs text-foreground-muted">{option.label}</AppText>
              </Pressable>
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => choose(null)}
            className="mt-5 min-h-11 items-center justify-center rounded-xl bg-input"
          >
            <AppText>Remove color</AppText>
          </Pressable>
          <AppText className="mt-3 text-xs text-foreground-muted">
            Saved on this device, like desktop color labels.
          </AppText>
        </View>
      </View>
    </Modal>
  );
}
