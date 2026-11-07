export function keyTextOccurrences<T>(values: ReadonlyArray<T>, textOf: (value: T) => string) {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const text = textOf(value);
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { value, key: JSON.stringify([text, occurrence]) };
  });
}
