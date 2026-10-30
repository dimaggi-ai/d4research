import { useEffect, useState } from "react";
import { MAX_CHAT_CUSTOM_WIDTH_PX, MIN_CHAT_CUSTOM_WIDTH_PX } from "@d4research/contracts/settings";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";

export function ChatCustomWidthControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (width: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <NumberField
      value={draft}
      min={MIN_CHAT_CUSTOM_WIDTH_PX}
      max={MAX_CHAT_CUSTOM_WIDTH_PX}
      step={1}
      size="sm"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) {
          setDraft(value);
          return;
        }
        const width = Math.min(
          MAX_CHAT_CUSTOM_WIDTH_PX,
          Math.max(MIN_CHAT_CUSTOM_WIDTH_PX, Math.round(next)),
        );
        setDraft(width);
        onChange(width);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label="Decrease chat width" />
        <NumberFieldInput aria-label="Custom chat width in pixels" />
        <span aria-hidden="true" className="self-center pr-2 text-xs">
          px
        </span>
        <NumberFieldIncrement aria-label="Increase chat width" />
      </NumberFieldGroup>
    </NumberField>
  );
}
