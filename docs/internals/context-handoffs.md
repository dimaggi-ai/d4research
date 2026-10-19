# Context handoffs

Portable handoffs carry a budgeted selection of saved history. They do not reproduce native
provider reasoning, tool state, or approvals.

`ContextHandoffServiceV2` stores selected messages with their full text and roles, plus coverage and
retrieval references for omitted items. `ProviderTurnStartServiceV2` recalculates the delivery budget
against the target context. See [portable handoff limits](../user/portable-handoffs.md).

Provider handoffs select from either the eligible app history or the delta since that provider last
participated. Fork merge-back handoffs also carry selected history. Their separate summary uses
240-character whitespace-normalized prefixes for text-bearing items; that summary is not the
full-message history payload. Do not apply its prefix rule to provider handoffs.

Legacy import retains a separate recovery excerpt: it walks backward through user and assistant
messages within a 32,000-character budget. Continuation uses the delivery selection above, not that
excerpt as a replacement for the imported transcript. Keep the recovery-excerpt, summary-prefix,
and delivery-budget rules distinct.
