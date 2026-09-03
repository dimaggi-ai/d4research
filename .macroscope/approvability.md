Use Macroscope's default approvability criteria.

Additionally, any pull request that changes product defaults is not auto-approvable and requires human review.

Any pull request that adds or broadens a directive disabling or suppressing lint,
type-checker, LSP, or other static-analysis diagnostics is not auto-approvable and
requires human review. This includes file-level, line-level, and configuration-level
overrides.
