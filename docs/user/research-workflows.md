# Research workflows

d2research is a research workspace for evidence-heavy work across models and providers. Its research mode structures an investigation, while provider handoff preserves one continuous chat when the active model changes.

## Start deep research

Begin a prompt with `#deep-research`. d2research expands it into a research-lead brief that asks the active provider to plan the investigation, use only useful specialist roles, preserve evidence, challenge weak conclusions, and synthesize the result.

The brief suggests four roles:

- **Scout** finds sources and maps the search space.
- **Analyst** extracts facts and compares evidence.
- **Challenger** tests assumptions, conflicts, and missing evidence.
- **Synthesizer** turns verified findings into the final answer.

These are roles, not guaranteed background jobs. The provider uses the delegation tools it actually has, advertises only providers that are ready in the current environment, and must report what ran. Delegation is capped at three concurrent agents and delegated agents may not recursively delegate.

When local Memo tools are available, research agents should store and retrieve durable findings with sources, file paths, commands, and uncertainty. The visible thread remains authoritative.

## Hand off to another provider

Choose a different model while a provider session is active. d2research keeps the same thread and prepares a bounded handoff containing the recent transcript, a compact summary, the destination provider, and the local Memo project name.

The lifecycle is:

1. Summarize the recent conversation locally, falling back to a compact excerpt if the summarizer is unavailable.
2. Persist the handoff to the environment's local Memo integration.
3. Stop the current provider session.
4. Apply the new model selection and start the receiving provider in the same chat.
5. Restore the prior model selection if the handoff cannot be completed.

The receiving provider is told that the visible transcript is authoritative and can search local Memo for additional shared context. A working local Memo integration is required to complete the managed handoff.

## Boundaries

- Deep Research structures a provider prompt; it does not create an unbounded autonomous swarm.
- Suggested roles and available providers are not proof that delegated work ran.
- Provider-native authentication and permission behavior still apply.
- Tool Guard is separate and opt-in. See [Tool Guard](./tool-guard.md).
- Voice conversation requires the d2 local voice gateway. It is an environment integration, not a hosted service bundled with a generic checkout.
