# Observability

> For maintainers. Using d4research? See [docs/user](../user/).

d4research has one server-side observability model:

- pretty logs go to stdout for humans
- completed spans go to a local NDJSON trace file
- metrics stay in-process; external trace and metric exporters are not included

The local trace file is the persisted source of truth for normal local launches. Those launches do not
write a separate server log file, but SSH-managed launches also persist the remote process's
stdout/stderr at `~/.t3/ssh-launch/<state>/server.log`.

## Where To Find Things

### Logs

Logs are human-facing:

- destination: stdout
- format: `Logger.consolePretty()`
- normal local persistence: none
- SSH-managed launch persistence: `~/.t3/ssh-launch/<state>/server.log`

If you want a log message to show up in the trace file, emit it inside an active span with `Effect.log...`. `Logger.tracerLogger` will attach it as a span event.

### Traces

Completed spans are written as NDJSON records to `serverTracePath`. The default path depends on
how the server starts. Production and explicitly configured homes use
`<home>/userdata/logs/server.trace.ndjson` (so `~/.t3/userdata/...` by default, or
`/custom/path/userdata/...` with `--home-dir /custom/path`). A linked worktree dev run uses
`<worktree>/.t3/userdata/logs/server.trace.ndjson`, and an implicit dev run outside a linked
worktree uses `~/.t3/dev/logs/server.trace.ndjson`.

Important fields common to both record types:

- `type`: `effect-span` or `otlp-span`
- `name`: span name
- `traceId`, `spanId`, `parentSpanId`: correlation
- `durationMs`: elapsed time
- `attributes`: structured context
- `events`: embedded logs and custom events

`effect-span` records also contain `exit` with `Success`, `Failure`, or `Interrupted`. `otlp-span`
records instead carry OTLP resource, scope, and optional status fields.

The `TraceRecord`, `EffectTraceRecord`, and `OtlpTraceRecord` schemas live in
`packages/shared/src/observability.ts`.

DPoP proof failures include the safe `environment.dpop.failure_code` span
attribute. A `time_window` failure means that a signed proof was too old or too
far in the future for the environment server's allowed window. It can point to
a date or time problem on either device, but it can also result from a delayed
request.

### Metrics

Metrics are not written to a local file.

- local persistence: none
- remote export: none
- current definitions: `apps/server/src/observability/Metrics.ts`

Metrics exist in-process, but there is no local metrics artifact to inspect.

### Related Artifacts

Provider event NDJSON files still exist for provider runtime streams. Those are separate from the main server trace file.

## Run The Server In Instrumented Mode

Diagnostics stay on the environment you connect to. Browser spans are sent to that environment's
local trace collector, not an external analytics service. Legacy `T3CODE_OTLP_*` configuration and
saved exporter URLs no longer enable exports. Provider CLIs are separate processes; their own
telemetry settings are outside this guarantee.

### Local Traces

You do not need any extra env vars. Just run the app normally and inspect `server.trace.ndjson`.

Examples:

```bash
npx d4research
```

```bash
node --run dev
```

```bash
node --run dev:desktop
```

## How To Use Traces And Metrics To Debug The Server

### Start With The Local Trace File

The trace file is the fastest way to inspect raw span data.

Resolve the path for the launch mode once. Production and explicitly configured homes store runtime
state under the base directory's `userdata` folder:

```bash
TRACE_FILE="${T3CODE_HOME:-$HOME/.t3}/userdata/logs/server.trace.ndjson"
```

A dev server started from a linked worktree defaults to that worktree's local home:

```bash
TRACE_FILE="$WORKTREE/.t3/userdata/logs/server.trace.ndjson"
```

Only an implicit dev run outside a linked worktree uses the shared dev directory:

```bash
TRACE_FILE="$HOME/.t3/dev/logs/server.trace.ndjson"
```

Tail the selected file:

```bash
tail -f "$TRACE_FILE"
```

Show failed spans:

```bash
jq -c 'select(.type == "effect-span" and .exit._tag != "Success") | {
  name,
  durationMs,
  exit,
  attributes
}' "$TRACE_FILE"
```

Show slow spans:

```bash
jq -c 'select(.durationMs > 1000) | {
  name,
  durationMs,
  traceId,
  spanId
}' "$TRACE_FILE"
```

Inspect embedded log events:

```bash
jq -c 'select(any(.events[]?; .attributes["effect.logLevel"] != null)) | {
  name,
  durationMs,
  events: [
    .events[]
    | select(.attributes["effect.logLevel"] != null)
    | {
        message: .name,
        level: .attributes["effect.logLevel"]
      }
  ]
}' "$TRACE_FILE"
```

Follow one trace:

```bash
jq -r 'select(.traceId == "TRACE_ID_HERE") | [
  .name,
  .spanId,
  (.parentSpanId // "-"),
  .durationMs
] | @tsv' "$TRACE_FILE"
```

Filter orchestration commands:

```bash
jq -c 'select(.attributes["orchestration.command_type"] != null) | {
  name,
  durationMs,
  commandType: .attributes["orchestration.command_type"],
  aggregateKind: .attributes["orchestration.aggregate_kind"]
}' "$TRACE_FILE"
```

Filter git activity:

```bash
jq -c 'select(.attributes["git.operation"] != null) | {
  name,
  durationMs,
  operation: .attributes["git.operation"],
  cwd: .attributes["git.cwd"],
  hookEvents: [
    .events[]
    | select(.name == "git.hook.started" or .name == "git.hook.finished")
  ]
}' "$TRACE_FILE"
```

### Use Metrics To See Systemic Problems

Traces are best for one request. Metrics are best for trends.

Good metric families to watch:

- `t3_rpc_request_duration`
- `t3_orchestration_command_duration`
- `t3_orchestration_command_ack_duration`
- `t3_provider_turn_duration`
- `t3_git_command_duration`

Counters tell you volume and failure rate:

- `t3_rpc_requests_total`
- `t3_orchestration_commands_total`
- `t3_provider_turns_total`
- `t3_git_commands_total`

Use metrics when the question is:

- "is this always slow?"
- "did this get worse after a change?"
- "which command type is failing most often?"

Use traces when the question is:

- "what happened in this specific request?"
- "which child span caused this one slow interaction?"
- "what logs were emitted inside the failing flow?"

### What The New Ack Metric Means

`t3_orchestration_command_ack_duration` measures:

- start: command dispatch enters the orchestration engine
- end: the first committed domain event for that command is published by the server

That is a server-side acknowledgment metric. It does not measure:

- websocket transit to the browser
- client receipt
- React render time

If you need those later, add client-side instrumentation or a dedicated server fanout metric.

## Common Workflows

### "Why did this request fail?"

1. Start with the local NDJSON file.
2. Find `effect-span` records where `exit._tag != "Success"`.
3. Group by `traceId`.
4. Inspect sibling spans and span events.

### "Why is the UI feeling slow?"

1. Search for slow top-level spans in the trace file.
2. Check child spans for sqlite, git, provider, or terminal work.
3. Look at the matching duration metrics to see whether the slowness is systemic.

### "Did this command take too long to acknowledge?"

1. Check `t3_orchestration_command_ack_duration` by `commandType`.
2. If it is high, inspect the corresponding orchestration trace.
3. Look at child spans for projection, sqlite, provider, or git work.

### "Are git hooks causing latency?"

1. Filter `git.operation` spans.
2. Inspect `git.hook.started` and `git.hook.finished` events.
3. Compare hook timing to the enclosing git span duration.

### "Why do I have spans locally but nothing in Grafana?"

Usually one of these is true:

- `T3CODE_OTLP_TRACES_URL` was not set
- the app was launched from a different environment than the one where you exported the vars
- the app was not fully restarted after changing env
- Grafana is looking at the wrong time range or service name

If the local NDJSON file is updating, local tracing is working. The problem is almost always OTLP export configuration or process startup.

## How To Think About Adding Tracing To Future Code

### Prefer Boundaries Over Tiny Helpers

Good span boundaries:

- RPC methods
- orchestration command handling
- provider adapter calls
- external process calls
- persistence writes
- queue handoffs

Avoid tracing every tiny helper. Most helpers should inherit the active span rather than create a new one.

### Reuse `Effect.fn(...)` Where It Already Exists

The codebase already uses `Effect.fn("name")` heavily. That should usually be your first tracing boundary.

For ad hoc work:

```ts
import { Effect } from "effect";

const runThing = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({
    "thing.id": "abc123",
    "thing.kind": "example",
  });

  yield* Effect.logInfo("starting thing");
  return yield* doWork();
}).pipe(Effect.withSpan("thing.run"));
```

### Put High-Cardinality Detail On Spans

Use span annotations for IDs, paths, and other detailed context:

```ts
yield *
  Effect.annotateCurrentSpan({
    "provider.thread_id": input.threadId,
    "provider.request_id": input.requestId,
    "git.cwd": input.cwd,
  });
```

### Keep Metric Labels Low Cardinality

Good metric labels:

- operation kind
- method name
- provider kind
- aggregate kind
- outcome

Bad metric labels:

- raw thread IDs
- command IDs
- file paths
- cwd
- full prompts
- full model strings when a normalized family label would do

Detailed context belongs on spans, not metrics.

### Use Logs As Span Events

Logs inside a span become part of the trace story:

```ts
yield * Effect.logInfo("starting provider turn");
yield * Effect.logDebug("waiting for approval response");
```

Those messages show up as span events because `Logger.tracerLogger` is installed.

### Use The Pipeable Metrics API

`withMetrics(...)` is the default way to attach a counter and timer to an effect:

```ts
import { someCounter, someDuration, withMetrics } from "../observability/Metrics.ts";

const program = doWork().pipe(
  withMetrics({
    counter: someCounter,
    timer: someDuration,
    attributes: {
      operation: "work",
    },
  }),
);
```

## Detailed API Reference

### Runtime Wiring

The server observability layer lives in `apps/server/src/observability/Layers/Observability.ts`.

It provides:

- pretty stdout logger
- `Logger.tracerLogger`
- local NDJSON tracer
- Effect trace-level and timing refs

### Env Vars

Local trace file:

- `T3CODE_TRACE_FILE`: override trace file path
- `T3CODE_TRACE_MAX_BYTES`: per-file rotation size, default `10485760`
- `T3CODE_TRACE_MAX_FILES`: rotated file count, default `10`
- `T3CODE_TRACE_BATCH_WINDOW_MS`: flush window, default `1000`
- `T3CODE_TRACE_MIN_LEVEL`: minimum trace level, default `Info`
- `T3CODE_TRACE_TIMING_ENABLED`: enable timing metadata, default `true`

### What Is Instrumented Today

The current high-value span and metric boundaries are:

- Effect RPC websocket request spans from `effect/rpc`
- RPC request metrics in `apps/server/src/observability/RpcInstrumentation.ts`
- startup phases
- orchestration command processing
- orchestration command acknowledgment latency
- provider session and turn operations
- git command execution and git hook events
- terminal session lifecycle
- sqlite query execution

### Current Constraints

- logs outside spans are not persisted in the trace file; SSH-managed launch stdout/stderr is still
  captured in its launcher log
- metrics are not snapshotted locally
- the old `serverLogPath` still exists in config for compatibility, but the trace file is the primary
  structured persisted artifact
