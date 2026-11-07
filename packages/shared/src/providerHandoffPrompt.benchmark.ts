// Keep runner-speed assertions opt-in while correctness tests always execute.
export function measureHandoffParsing<T>(parse: () => T) {
  if (process.env.D4RESEARCH_BENCHMARK_HANDOFF !== "1") {
    return { result: parse(), elapsedMillis: null };
  }
  const started = performance.now();
  const result = parse();
  return { result, elapsedMillis: performance.now() - started };
}
