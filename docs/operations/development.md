# Local development

From the repository root, install dependencies and start server and web:

```sh
vp i
vp run dev
```

Open the one-time pairing URL printed by the dev runner. A bare origin does not authenticate a
new browser. See the [root README](../../README.md) for prerequisites and the
[mobile README](../../apps/mobile/README.md) for native development.

## State and remote access

Linked worktrees use their own `.t3/userdata`. Do not start a test server against the live
`~/.t3/userdata`. Follow the [test-data instructions](../../AGENTS.md#test-data) when taking a
consistent copy of existing data.

Read ports from the dev runner's output because occupied ports can change the selected values.
Use `vp run dev --share` to share over the tailnet, and give the tester the complete pairing URL.
Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset: development uses the browser's origin and proxy.

## Verification

Run focused tests and typechecking for changed packages:

```sh
vp test run <files>
vp run --filter <package> typecheck
```

CI owns repository-wide checks. The [Windows workflow](../../.github/workflows/windows-tests.yml)
can be started manually for focused Windows testing. For release builds, use the
[release runbook](./release.md).
