export function measureHandoffParsing<T>(parse: () => T) {
  const started = performance.now();
  const result = parse();
  return { result, elapsedMillis: performance.now() - started };
}
