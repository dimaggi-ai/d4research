# Appearance

On web and desktop, open **Settings → Appearance** and choose **System**, **Light**, or **Dark**.
System follows your device's appearance. The glass opacity setting controls the transparency of
menus, dialogs, and the composer; higher values make these surfaces more solid.

Use **Change theme** in the command palette to pick a theme without leaving chat, or press
**Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows and Linux to open the theme picker directly.

**Change appearance** in the command palette switches between System, Light, and Dark independently
of the theme. **Cmd+Option+Shift+A** or **Ctrl+Alt+Shift+A** cycles through those modes. Both
shortcuts can be changed under **Settings → Keybindings**.

Mobile has separate appearance preferences. See [Mobile appearance](./mobile-appearance.md).

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a T3 Code or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. Additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, T3 Code falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
d4research theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `d4research theme set`. Run the command again to
reapply it, even if the name is unchanged.

`d4research theme clear` removes the default without changing anyone's current theme. `d4research theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from T3 Code into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `d4research theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. T3 Code
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.
