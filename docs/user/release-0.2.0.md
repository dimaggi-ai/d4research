# d4research 0.2.0

Version 0.2.0 makes the existing research workspace dependable enough for an early-access release.
It focuses on explicit provider readiness, recoverable turns, same-thread handoffs, bounded research
pipelines, local Memo-backed documents, and a usable first-run path.

## Highlights

- Run Codex, Claude, Cursor, Grok, or server-managed OpenCode as the orchestrating provider, with
  Junie and Agy available as bounded pipeline targets.
- Switch providers without forking the visible thread. Requested and resolved targets remain
  distinct in the run record.
- Use named Dev and Research pipelines with exact-target or explicitly labeled fallback policy.
- Keep oversized text documents in local Memo and retrieve relevant chunks during a turn.
- Inspect provider installation, authentication, reachability, model readiness, and remediation
  before starting work.
- Export an evidence-bearing Markdown result from web or desktop.

## Install

Run the server without a permanent installation:

```bash
npx d4research@0.2.0
```

Unsigned desktop artifacts for macOS, Windows, and Linux are attached to this release. They are
early-access builds and may require the operating system's documented manual approval flow.

## Verify a download

Download `SHA256SUMS` beside the artifact. On Linux, verify the files present in that directory:

```bash
sha256sum --check SHA256SUMS --ignore-missing
```

On macOS, verify one downloaded artifact:

```bash
expected="$(grep ' d4research-file.dmg$' SHA256SUMS | cut -d' ' -f1)"
actual="$(shasum -a 256 d4research-file.dmg | cut -d' ' -f1)"
test "$actual" = "$expected"
```

On Windows PowerShell, compare the output of `Get-FileHash` with the matching line in
`SHA256SUMS`:

```powershell
(Get-FileHash .\d4research-file.exe -Algorithm SHA256).Hash.ToLower()
```

Replace the example filename with the artifact you downloaded.

The npm package is published through npm trusted publishing with npm provenance. GitHub also records
a build-provenance attestation for the attached release assets.

## Updating

Keep the server and client on the same exact version. A global server install updates with:

```bash
npm install --global d4research@0.2.0
```

Desktop uses the fork-owned stable update channel. Source checkouts continue to update with
`git pull --ff-only` followed by `vp i`.

## Known limitations

- There is no d4research-branded iOS or Android store release in 0.2.0.
- The 0.2.0 desktop artifacts are unsigned.
- Provider CLIs and their credentials must exist on the machine hosting the server.
- Voice, Mission Control, external Memo, and managed Tool Guard require their corresponding local or
  explicitly configured deployment services.

Verification evidence is recorded in the
[0.2.0 release evidence](https://github.com/dimaggi-ai/d4research/blob/v0.2.0/docs/operations/release-evidence-0.2.0.md).
