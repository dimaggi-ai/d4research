# d4research 0.2.0 release evidence

> For maintainers. This record describes the reviewed candidate before the release tag. Publication
> evidence is appended only after the tag workflow succeeds.

## Candidate

- Branch: `release/0.2.0`
- Review baseline: `4d186257db3c2796cc610d9a351b6f3ce0902c09`; final distribution/docs commit and
  exact-commit CI are recorded after this pass is committed.
- Five-round CTO review: final architecture, security, and verification seats reported no code or
  documentation findings before the distribution/docs completion pass.

## Automated verification

- [Exact-commit GitHub CI](https://github.com/dimaggi-ai/d4research/actions/runs/32877527163): Check,
  Test, Mobile Native Static Analysis, and Release Smoke passed.
- `bash release-ops/docker/smoke.sh`: passed from a fresh artifact build at the reviewed commit. The
  clean Node 24 container installed the package, launched against empty state, minted a pairing URL,
  preserved state across restart, updated in place, and uninstalled cleanly.
- Focused release checks: `vp run release:smoke`, release version-script tests, targeted lint, YAML
  parsing, and `git diff --check` passed.

## Surface applicability

| Surface                   | 0.2.0 evidence                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Server CLI and hosted web | Clean-container lifecycle and workspace CI passed                                                                                         |
| Desktop                   | CI builds macOS arm64/x64, Linux x64, and Windows x64 artifacts; publication verification remains tag-time                                |
| Mobile                    | Native static analysis passed; no d4research-branded store artifact is shipped                                                            |
| Providers                 | Adapter/unit integration coverage runs in CI; real provider credentials are environment-owned and were not embedded in release automation |
| Local/remote              | Pairing and persisted local state passed in Docker; remote clients use the same server contract                                           |

## Tag-time evidence still required

- GitHub environment protection and npm trusted-publisher identity verified.
- `d4research@0.2.0` visible on npm with provenance.
- GitHub Release assets present with `SHA256SUMS` and a build-provenance attestation.
- Desktop updater metadata points to `dimaggi-ai/d4research`.
- Signing status: macOS arm64/x64, Windows x64, and Linux x64 artifacts are intentionally unsigned
  for 0.2.0.
