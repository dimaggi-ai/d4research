# Workspace layout

> For maintainers. Using d2research? See [docs/user](../user/).

A pnpm workspace driven by [vite-plus](https://vite.plus) (`vp`). See [scripts.md](./scripts.md) for
the task commands.

## apps

- `apps/server` (`t3`): the execution runtime and the published CLI. Owns orchestration, provider
  drivers, checkpointing, VCS, terminals, filesystem access, auth, and the HTTP + WebSocket surface.
  Also serves the built web app.
- `apps/web` (`@t3tools/web`): React + Vite UI. Consumes the shared client runtime and adds routing,
  components, and web-specific platform layers.
- `apps/desktop` (`@t3tools/desktop`): Electron shell. Supervises a desktop-scoped `t3` backend,
  loads the web bundle over the `t3code://` protocol, and owns SSH-managed remote environments.
- `apps/mobile` (`@t3tools/mobile`): Expo/React Native client. Same client runtime composition as
  web, different platform layer and UI.
- `apps/marketing` (`@t3tools/marketing`): Astro marketing site.

## packages

- `packages/contracts` (`@t3tools/contracts`): shared Effect Schema definitions. RPC group,
  orchestration commands/events/read model, auth scopes, environment descriptors, settings.
- `packages/shared` (`@t3tools/shared`): framework-agnostic utilities used by server and clients
  (`DrainableWorker`, git and source-control helpers, relay auth and signing, DPoP, semver, logging,
  observability, and more).
- `packages/client-runtime` (`@t3tools/client-runtime`): connection lifecycle, authorization, RPC
  session, environment registry, and Atom-based domain state shared by web and mobile. See its
  [README](../../packages/client-runtime/README.md).
- `packages/ssh` (`@t3tools/ssh`): SSH config parsing, auth prompts, command execution, and the
  tunnel/environment manager behind desktop-managed SSH environments.
- `packages/tailscale` (`@t3tools/tailscale`): Tailscale CLI wrapper, including the
  `ensureTailscaleServe` / `disableTailscaleServe` serve lifecycle the server drives.
- `packages/effect-acp` (`effect-acp`): Effect client and agent implementation of the Agent Client
  Protocol, used by ACP-speaking provider drivers.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): Effect client for the
  `codex app-server` JSON-RPC protocol.

## infra

- `infra/relay` (`t3code-relay`): the hosted T3 Connect relay, deployed with Alchemy. Handles
  environment discovery, cloud-side records, and mobile notifications. It is not in the hot path;
  after connect, client traffic goes directly to the environment. See
  [t3-connect.md](./t3-connect.md).

## Other top-level directories

Every tracked top-level directory has a distinct owner. Do not delete one merely because it is not
part of the web application.

| Directory                         | Why it exists                                                                  | Shipping status           |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------- |
| `.agents/`                        | Shared repository skills; `.claude/skills` points here                         | Development tooling       |
| `.claude/`, `.codex/`, `.cursor/` | Provider-specific repository discovery and MCP/rule configuration              | Development tooling       |
| `.devcontainer/`, `.vscode/`      | Reproducible editor and container setup                                        | Development tooling       |
| `.github/`                        | CI, release workflows, issue templates, and repository automation              | Repository operations     |
| `.macroscope/`                    | Static-review agent guidance                                                   | CI/development tooling    |
| `.plans/`                         | Historical and active maintainability plans referenced during large migrations | Non-shipping records      |
| `.repos/`                         | Gitignored, vendored reference sources used for implementation guidance        | Local development only    |
| `.vite-hooks/`                    | Vite+ hook configuration                                                       | Development tooling       |
| `assets/`                         | Brand and app-icon sources for development, nightly, and production channels   | Build input               |
| `docs/`                           | User, internals, architecture, and operations documentation                    | Repository documentation  |
| `experiments/`                    | Deliberately isolated prototypes, currently the Messages glass lab             | Non-shipping prototypes   |
| `native/`                         | Rust/native libraries and resource-monitor binaries                            | Shipping build input      |
| `ops/`                            | Deployment assets, services, and Tool Guard policies                           | Deployment/build input    |
| `oxlint-plugin-t3code/`           | Repository-specific lint rules; compatibility name retained                    | Development tooling       |
| `patches/`                        | pnpm patches required by pinned dependencies                                   | Install input             |
| `scripts/`                        | Development, QA, branding, release, and deployment automation                  | Development/build tooling |

Generated `node_modules/`, build output, worktree state, and `.repos/` contents are ignored and must
not be committed. A tracked directory should be removed only with its owning workflow, references,
and documentation in the same change.

## Import conventions

`@t3tools/shared` and `@t3tools/client-runtime` use explicit subpath exports with no barrel index and
no root export. Import the narrow path (`@t3tools/shared/DrainableWorker`,
`@t3tools/client-runtime/state/threads`) rather than the package root. Files that are not exported
are implementation details. `@t3tools/contracts` does export a root alongside `./settings` and
`./relay`.
