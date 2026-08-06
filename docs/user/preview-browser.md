# Preview and In-App Browser

d4research includes a collaborative browser surface for previewing the app you are building — you
and the agent share it.

## Opening a preview

Open a preview tab from the workspace surface controls, from a link printed in a terminal (local
`http://…` links open in the preview instead of an external browser), or from a discovered local
dev server: the server's port scanner (`apps/server/src/preview/PortScanner.ts`) detects listening
local servers for the thread's workspace and offers them as one-click preview targets.

Preview sessions are managed server-side (`apps/server/src/preview/Manager.ts`) and exposed to
clients over the `preview.*` RPC methods (`open`, `navigate`, `resize`, `refresh`, `close`, `list`,
`reportStatus`), so a session survives client reconnects and is visible to every connected client.

## Viewports and appearance

A preview tab can fill the pane, use a freeform size, or emulate a device from the Chrome-style
preset catalog (iPhone SE through iPad Pro, Pixel, Galaxy, Surface, foldables, Nest Hub — see
`PREVIEW_VIEWPORT_PRESET_IDS` in `packages/contracts/src/preview.ts`). Sizes are clamped between
240 px and 3840 px per dimension. The color scheme (system, light, dark) can be forced per tab.

## Agent automation

Agents drive the same browser through the preview automation surface
(`packages/contracts/src/previewAutomation.ts`). The operation set is `status`, `open`, `navigate`,
`snapshot`, `click`, `type`, `press`, `scroll`, `evaluate`, `waitFor`, `recordingStart`,
`recordingStop`, plus `resize` and `setColorScheme` on current hosts. Agent actions target a
specific tab or the agent session's current tab, and the agent's pointer is rendered as a visible
cursor in the shared view so you can watch what it does. Console output and page snapshots flow
back to the agent.

## Annotating elements

You can select elements in the preview and attach them to your next message: annotations appear as
cards above the composer (element label, selector context) and are sent as structured context with
the prompt.
