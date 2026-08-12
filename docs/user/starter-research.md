# Run the Starter Research Scenario

The built-in `starter` scenario is a small, bounded first run. It performs one evidence pass and one review pass, does not recurse, and stops after producing a structured result.

## Before you start

Confirm four things:

1. The d4research server is connected.
2. **Settings → Providers** shows at least one enabled provider as ready, with a model listed.
3. Your project contains the checked-in sample corpus at [`docs/user/samples/kitten-fluffiness.md`](./samples/kitten-fluffiness.md).
4. Local shared memory is enabled in **Settings → Connections** if you want to include a document that would exceed a provider request limit.

## Run the deterministic sample

Open this repository as a project, create a thread, and send:

```text
!research:starter Using only docs/user/samples/kitten-fluffiness.md, which observations support or weaken the claim that kitten coats feel fluffy? Stop after the checked-in corpus and cite the source headings.
```

The result must contain these headings:

- Findings
- Source evidence
- Uncertainty
- Unresolved questions
- Delegate status
- RUN STATE

The starter is provider-independent. It does not name a second model, so **Delegate status** reports `SKIPPED` unless you edit the scenario and add an explicit `!provider:model` directive. This is intentional: the UI never claims a delegate ran when it did not.

## Export the result

On web or desktop, use **Export thread as Markdown** in the thread header. The file contains the latest assistant result, the authoritative visible conversation, current provider/model identifiers, the latest turn state, and recorded research/provider lifecycle events.

Mobile renders the result and run state but does not currently offer the Markdown download action. Export from a connected web or desktop client without creating another thread.

## Customize safely

Open **Settings → Research**, select `starter`, and edit its pipeline. Safe customizations include the question, source boundary, output headings, and the number of non-recursive evidence passes. Add delegation only through explicit `!provider:model` directives shown as resolved in the editor.

Keep the stopping condition and `RUN STATE` requirement. A missing or ambiguous provider directive is an error to report, not permission to silently choose another model.
