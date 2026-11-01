import * as ClientTracer from "./clientTracer";

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

/** Fork policy: never attach a network trace exporter, even for remote environments. */
export function configureClientTracing(_config: ClientTracingConfig = {}): Promise<void> {
  ClientTracer.setDelegate(null);
  return Promise.resolve();
}
