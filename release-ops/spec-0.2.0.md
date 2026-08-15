# d4research v0.2.0 — Release Specification

**Companion to:** `plan-0.2.0.md` (priorities and gates) and
`test-spec-0.2.0.md` (verification matrix). The plan says what must be true;
this document says what we ship and how it is packaged, versioned, and
distributed; the test spec says how each claim is verified.

## What ships

One artifact: the composed server. It bundles the WebSocket server, the web
client, and the Tool Guard assets into `dist/`, and it serves web, desktop
(connecting), mobile (connecting), and remote clients. Desktop and mobile
native binaries are not part of the v0.2.0 artifact matrix (no signing or
store pipeline exists on the release host, and the plan forbids claiming
what we cannot verify).

## Artifact matrix

| Artifact        | Form                                 | Produced by                                 | Verified by                                                    |
| --------------- | ------------------------------------ | ------------------------------------------- | -------------------------------------------------------------- |
| Source checkout | git tag on `dimaggi-ai/d4research`   | `git tag` after approval                    | full test suite + focused validations                          |
| Server tarball  | `t3-<version>.tgz` (npm-installable) | `node release-ops/docker/make-artifact.mjs` | `release-ops/docker/smoke.sh` (Docker clean-machine lifecycle) |

The tarball manifest is generated at pack time: workspace `catalog:`
specifiers resolve to the pinned versions in `pnpm-workspace.yaml`, and
dependencies the bundler already inlined (`@t3tools/*`, `@pierre/diffs`,
`effect-acp`, `effect-codex-app-server`) are dropped. The repo manifest is
never mutated. A raw `npm pack` of `apps/server` is NOT installable outside
the workspace; the smoke exists to keep that class of defect from shipping.

## Clean-machine gate (Docker)

`bash release-ops/docker/smoke.sh` replaces the "clean machine" requirement.
It packs the artifact, then on a stock `node:24-bookworm` image with no repo
checkout:

1. **Install** — `npm install -g` of the tarball; dependency resolution and
   native builds (node-pty) must succeed with the stock toolchain.
2. **First launch** — `t3` starts against an empty `T3CODE_HOME`, answers
   `GET /` with 200 within 60 s, and creates `userdata/state.sqlite`.
3. **Pairing** — `t3 pair` exits 0 and prints a URL.
4. **Restart** — stop, relaunch, healthy again, state preserved.
5. **Update in place** — reinstall the artifact over live state, relaunch,
   healthy.
6. **Uninstall** — `npm rm -g t3` leaves nothing on PATH.

Any step failing fails the gate. The container is the only supported proxy
for "a machine we have never touched"; passing on the development host
proves nothing and does not count.

## Version and update story

- Package manifests carry the d2 line version (currently `0.0.2`), chosen
  deliberately below upstream T3 Code versions so no existing T3
  installation ever sees a d4research build as an update.
- The release program is named "v0.2.0" in planning documents. **Decision
  required before tagging:** either bump manifests to `0.2.0` (recommended:
  still below upstream, matches every public name for this release) or tag
  `v0.0.2` and rename the program. The tag, the manifests, the release page,
  and the documentation must state one version. This is the P0
  "unambiguous version story" gate; the tag is blocked until it closes.
- Update channel for v0.2.0: manual. Updating is "install the new tarball
  over the existing home" (smoke step 5). No auto-update claim is made
  anywhere.
- State compatibility across updates is owned by the server's migration
  chain; migrations run on first launch after an update.

## Supported platforms

- **Verified:** Linux x86_64 with Node 24 (host and Docker smoke).
- **Expected but unverified, therefore not claimed:** macOS, other Node
  majors. The release page may say "expected to work, unverified" and
  nothing stronger.

## Distribution and provenance

Release publication (after tag approval): a GitHub release on
`dimaggi-ai/d4research` carrying the tarball, a `SHA256SUMS` file generated
from the published artifacts, and the git commit the artifacts were built
from. The release page links the docker smoke definition so the claim
"passes clean-machine lifecycle" is reproducible by anyone.

## Tag gate summary

A `v0.2.0` tag may be proposed only when all of the following hold:

1. Full repository test suite passes (`vp run -r test`).
2. Docker distribution smoke passes from a fresh artifact build
   (`bash release-ops/docker/smoke.sh`, without `--no-build`).
3. The focused validations recorded in `plan-0.2.0.md` checkpoints stand.
4. The version-story decision above is made and applied everywhere.
5. The remaining plan gates (P1 matrix breadth, canonical acceptance
   journey, docs/website claims) are either demonstrated or explicitly
   waived by the release owner in writing.

Tagging is a human action. Passing gates makes a tag proposable, not
automatic.
