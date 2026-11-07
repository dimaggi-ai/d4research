# FAQ

## What is d4research?

d4research is a private research workspace built on T3 Code. It runs coding-agent providers,
keeps their work in visible threads, and adds bounded research workflows, provider handoffs,
and local Memo storage. See [research workflows](./research-workflows.md).

## How do I install it?

Use the [source installation](./install.md). Upstream T3 Code packages and store apps are
separate distributions. This fork does not include hosted T3 Connect or its account service.

## Where do agents run?

Agents run on the machine hosting the environment. Provider installation, login, project
files, and environment settings belong to that machine. A connected phone or browser controls
that environment; it does not supply its provider credentials.

## How do I connect from another device?

Use a pairing link over a reachable private-network or HTTPS endpoint. Tailscale and
SSH-managed environments are supported. The host must remain running. See
[remote access](./remote-access.md).

## Can I use separate provider accounts or an API key?

Add a provider instance in **Settings → Providers**. Each instance can have its own configuration
and environment variables. Account isolation and supported endpoints depend on the provider;
see [Claude](./providers-claude.md) and [Codex](./providers-codex.md).

## Can I use local models?

Yes, through a supported provider configuration. See [Local DeepSeek](./providers-deepseek.md)
for that setup. Available models and capabilities depend on the configured provider.

## Where does my data go?

Threads and built-in Memo storage belong to the environment. Agent requests go to the selected
provider, which may use an external service. The fork excludes upstream product analytics and
hosted relay services. Choosing an external Memo backend or speech provider sends the relevant
data to the destination you configure. See [local data](./install.md#local-data) and
[voice input](./voice-input.md#choose-where-audio-goes).

## Is there voice input?

Yes. Mobile offers supported on-device recognition; web and desktop use a transcription
destination you choose. Sending audio to an environment or external speech provider requires
an explicit choice. Transcripts enter your draft for review. See [voice input](./voice-input.md).

## Why is my provider unavailable?

Check the provider's status in **Settings → Providers** on the host environment. Install and
sign in to its CLI there, or set an absolute **Binary path** if it is outside the server's
`PATH`. Authentication and model readiness can still fail when the binary is present.
See [provider setup](./install.md#providers).
