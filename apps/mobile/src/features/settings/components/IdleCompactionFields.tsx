import { useState } from "react";
import { View } from "react-native";
import type { ServerSettingsPatch } from "@d4research/contracts";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";

function NumericField({
  value,
  label,
  source,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number | null;
  label: string;
  source: string;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const text = draft;
    setDraft(null);
    if (disabled || text === null || !/^\d+$/.test(text)) return;
    const next = Number(text);
    if (Number.isInteger(next) && next >= min && next <= max && next !== value) onChange(next);
  };
  return (
    <View className="flex-row items-center justify-between gap-3 px-4 py-3">
      <View className="flex-1 gap-1">
        <Text className="text-base text-foreground">{label}</Text>
        <Text className="text-sm text-foreground-muted">{source}</Text>
      </View>
      <AppTextInput
        className="min-h-10 w-28 rounded-xl px-3 py-2 text-right text-base"
        keyboardType="number-pad"
        returnKeyType="done"
        placeholder="Mixed"
        value={draft ?? (value === null ? "" : String(value))}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        accessibilityLabel={label}
        editable={!disabled}
      />
    </View>
  );
}

export function IdleCompactionFields({
  minutes,
  tokens,
  minutesSource,
  tokensSource,
  disabled,
  onChange,
}: {
  minutes: number | null;
  tokens: number | null;
  minutesSource: string;
  tokensSource: string;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  return (
    <>
      <NumericField
        source={minutesSource}
        value={minutes}
        label="Idle minutes (1–1,440)"
        min={1}
        max={1440}
        disabled={disabled}
        onChange={(value) => onChange({ idleCompactionMinutes: value })}
      />
      <NumericField
        source={tokensSource}
        value={tokens}
        label="Context tokens (1k–10m)"
        min={1000}
        max={10000000}
        disabled={disabled}
        onChange={(value) => onChange({ idleCompactionTokens: value })}
      />
    </>
  );
}
