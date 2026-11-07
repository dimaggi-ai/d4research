import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";

export function SettingsTextField({
  label,
  value,
  disabled,
  onSave,
  placeholder,
  number = false,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onSave: (value: string) => void;
  placeholder?: string;
  number?: boolean;
}) {
  const edited = useRef(false);
  return (
    <View className="gap-2 px-4 py-3">
      <Text>{label}</Text>
      <AppTextInput
        key={value}
        accessibilityLabel={label}
        defaultValue={value}
        editable={!disabled}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={number ? "number-pad" : "default"}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        onChangeText={() => {
          edited.current = true;
        }}
        onEndEditing={(event) => {
          if (edited.current && event.nativeEvent.text.trim() !== value)
            onSave(event.nativeEvent.text.trim());
          edited.current = false;
        }}
      />
    </View>
  );
}
