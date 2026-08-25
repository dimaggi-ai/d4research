# d4research docs

d4research is a private workspace for long-running research across models and coding agents. Start with [why it exists and what it covers](./internals/d4research.md). Its application foundation comes from T3 Code; inherited documentation keeps that name when it refers to the actual package, protocol, or release channel.

## Using d4research

- [Release 0.2.0](./user/release-0.2.0.md)
- [Research workflows](./user/research-workflows.md)
- [Starter research scenario](./user/starter-research.md)
- [Starter sample corpus](./user/samples/kitten-fluffiness.md)
- [Install and first run](./user/install.md)
- [Product concepts](./user/concepts.md)
- [Troubleshooting](./user/troubleshooting.md)
- [The composer](./user/composer.md)
- [Settings](./user/settings.md)
- [Context window and usage](./user/context-and-usage.md)
- [Preview and in-app browser](./user/preview-browser.md)
- [Tool Guard](./user/tool-guard.md)
- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Review usage](./user/usage.md)
- [Customize a project icon](./user/project-settings.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [Agy](./user/providers-agy.md) · [Junie](./user/providers-junie.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on d4research

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [d4research architecture and scope](./internals/d4research.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Terminal renderers](./architecture/terminal-renderers.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Product contracts](./internals/product-contracts.md)
- [Providers](./internals/providers.md)
- [Tool Guard internals](./internals/tool-guard.md)
- [Handoff compression](./internals/handoff-compression.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Environment auth](./internals/environment-auth.md)
- [CI gates](./internals/ci.md)

### Runbooks

- [0.2.0 release evidence](./operations/release-evidence-0.2.0.md)
- [Docker QA stack](./operations/docker-qa.md)
- [Local deployment](./operations/local-deployment.md)
- [Release](./operations/release.md)
- [Upstream merge](./operations/upstream-merge.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
