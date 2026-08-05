# d2research

d2research is a private workspace for long-running, evidence-heavy research across coding agents. It combines bounded multi-agent planning, continuity across providers, local shared memory, voice workflows, and an optional safety layer for tool access. The product is built from the [T3 Code](https://github.com/pingdotgg/t3code) foundation and retains its fast, remote-ready clients and provider runtime.

## Why this project exists

Most agent harnesses are optimized for one provider completing one turn. Research work is different: it crosses many sources, benefits from specialized perspectives, outlives a provider session, and still needs a clear record of what actually happened. d2research is the working product used to test that lifecycle without turning the orchestration layer into an opaque autonomous swarm.

The design goals are:

- keep one durable thread while changing provider or model;
- make delegated research bounded, inspectable, and evidence-oriented;
- keep memory and optional voice processing local to the environment;
- retain provider-native permissions by default;
- make additional Tool Guard policy explicit, reversible, and environment-scoped;
- preserve the performance, remote access, and multi-surface architecture inherited from T3 Code.

## The difference

| Area                   | T3 Code baseline                | d2research exploration                                                            |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| Primary workflow       | Run coding agents               | Run coding agents and structured research                                         |
| Research orchestration | Normal provider turns           | `#deep-research` prompt expansion with bounded specialist roles                   |
| Provider changes       | Select a provider for a session | Hand off within the same thread, with a compact transcript and local Memo context |
| Continuity             | Durable T3 thread history       | Thread history plus local handoff memory and failure rollback                     |
| Tool permissions       | Provider-native modes           | Native modes by default, with optional managed d2 Tool Guard                      |
| Local operations       | Standard server and clients     | Optional voice gateway, system panel, and isolated Docker QA stack                |

## What it covers today

- **Deep Research.** A prompt beginning with `#deep-research` receives a structured research-lead brief. It suggests Scout, Analyst, Challenger, and Synthesizer roles, advertises only ready providers, caps delegated work at three concurrent agents, and forbids recursive delegation. The provider remains responsible for deciding which roles are useful and must not claim work that was not performed.
- **Same-thread provider handoff.** Changing the model during an active conversation can summarize a bounded recent transcript, store handoff context in local Memo, stop the previous session, and continue with the selected provider in the same chat. A failed handoff restores the prior selection.
- **Local shared context.** Research agents are instructed to exchange durable findings through the local Memo connector, including sources, paths, commands, and uncertainty.
- **Managed Tool Guard.** Settings can install, enable, disable, and uninstall the [Dimaggi Tool Guard Core](https://github.com/dimaggi-ai/tool-guard-core) integration for an environment. It copies managed resources into that environment and gates provider tools only when enabled. Provider-native permissions remain the default. See [Tool Guard](./docs/user/tool-guard.md).
- **Voice and operations experiments.** The web client can use local speech-to-text, summarization, and text-to-speech services. The system panel and Docker QA stack support the d2 deployment environment. These require local supporting services and are not part of a generic source checkout.
- **The T3 foundation.** Web, Electron desktop, and mobile clients; remote connections; multiple provider adapters; terminals; source control; previews; and checkpoint-based diff/restore remain inherited capabilities.

See [Research workflows](./docs/user/research-workflows.md) for user behavior and [d2research architecture and scope](./docs/internals/d2research.md) for implementation boundaries.

## Run from source

This repository is private. Clone access and Node.js `^22.16 || ^23.11 || >=24.10` are required.

```bash
git clone git@github.com:dimaggi-ai/d2research.git
cd d2research
```

Install the Vite+ `vp` command if needed:

```bash
curl -fsSL https://vite.plus | bash
```

Then install and start the development server:

```bash
vp i
vp run dev
```

Install and authenticate at least one supported provider CLI before starting its sessions. The inherited provider setup is documented in [Install and first run](./docs/user/install.md).

There is not currently a separate public `npx d2research` package or d2 desktop release channel. The upstream `npx t3` package and T3 desktop releases install T3 Code, not this fork. `scripts/deploy-local.sh` rebuilds an existing local d2 deployment; it is not a fresh-machine installer.

## Documentation

- [Documentation index](./docs/README.md)
- [Research workflows](./docs/user/research-workflows.md)
- [Tool Guard lifecycle](./docs/user/tool-guard.md)
- [d2research architecture and scope](./docs/internals/d2research.md)
- [Docker QA stack](./docs/operations/docker-qa.md)
- [Inherited T3 architecture](./docs/internals/overview.md)
- [Contributor policy](./CONTRIBUTING.md) and [agent instructions](./AGENTS.md)

## Project status and attribution

d2research is a private product-research fork, not an upstream T3 Code release. Compatibility names such as `t3`, `T3CODE_HOME`, and some inherited documentation remain where changing them would break protocols, storage, packages, or deployment workflows.

The d2research release line starts at `0.0.1`. It must use a d2-specific update channel: `0.0.1` is a new product version, not an upgrade over inherited T3 Code `0.0.31` installations.

The underlying application and architecture come from T3 Code. d2research changes should preserve that attribution and keep upstream-compatible behavior unless the research product explicitly needs a different contract.
