# Local development

From the repository root, install dependencies and start server and web:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. A bare origin does not authenticate a
new browser, unless it already holds the reusable dev credential below. See the
[root README](../../README.md) for prerequisites and the
[mobile README](../../apps/mobile/README.md) for native development.

## State and remote access

Linked worktrees use their own `.t3/userdata`. Do not start a test server against the live
`~/.t3/userdata`. Follow the [test-data instructions](../../AGENTS.md#test-data) when taking a
consistent copy of existing data.

Read ports from the dev runner's output because occupied ports can change the selected values.
Use `vp run dev --share` to share over the tailnet, and give the tester the complete pairing URL.
Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset: development uses the browser's origin and proxy.

### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to d4research. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree commands on Unix and Windows link that file to each worktree's
`.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See
[environment authentication](../internals/environment-auth.md#reusable-dev-credential) for the
security model.

## Verification

Run focused tests and typechecking for changed packages:

```sh
vp test run <files>
vp run --filter <package> typecheck
```

CI owns repository-wide checks. The [Windows workflow](../../.github/workflows/windows-tests.yml)
can be started manually for focused Windows testing. For release builds, use the
[release runbook](./release.md).
