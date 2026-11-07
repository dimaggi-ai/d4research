export const startCatalogBenchmark = () => {
  if (process.env.D4RESEARCH_BENCHMARK_CATALOG !== "1") return () => {};
  const start = performance.now();
  return () => {
    const elapsed = performance.now() - start;
    if (elapsed >= 500) {
      throw new Error(
        `1000-note catalog + lint took ${elapsed.toFixed(1)} ms; expected under 500 ms`,
      );
    }
  };
};
