# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

Pinned threads can still move to **Settled** when the selected automatic settlement policy applies.
Their pin order remains intact if they return to the active list.

Each environment owns one automatic settlement policy. The server checks it even when no web,
desktop, or mobile client is connected. The default is **Never**, so threads move only when you
settle them manually. **When PR merges or closes** settles a thread only when the finished pull
request is not older than the user's latest activity. **After inactivity** uses the configured day
count and keeps threads with open pull requests active. Active work, pending input, and live
agent background work keep the thread active. Change the policy in **Settings > Threads**. A
settings change affects future settlement and does not reopen a settled thread.

The change is written to every environment you are
connected to at that moment. An environment that is offline keeps its old value. When a connected
environment holds a different value, **Settings > Threads** shows a warning that names it. Choose
**Apply to all** to write your current values to every connected environment. The same applies to
the new-thread workspace mode and the source control writing style.

Pin a thread from its menu to keep it above your active work.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. With the finished-pull-request policy selected, that linked request can settle the
thread. Right-click the same link and choose **Unlink from thread** to remove it.
On mobile, **New thread** starts in the current thread's project, or else in the
last project you opened or chose on that device. If neither is available, the
project picker opens. Turn off **Settings → General → Use last project** to
choose a project every time. When you pick a project that is on more than one
machine, the thread starts on a connected one if any is connected.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

When the work grows into something real, pick **Turn into project** from the
thread's menu. The thread's folder becomes a project where it is, so nothing
moves and the agent keeps working in the same place. Other threads in that folder
move with it. Rename the project in its settings, and use **Initialize Git** to
get branch and diff controls.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).
On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order across connected clients.
New threads appear above arranged work. On the mobile app, **Move up** and **Move down**
update the same saved order. Older servers keep device-local active arrangements until upgraded.

On native mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

In a mobile browser, swipe right from near the left edge to open the thread sidebar. Swipe left
on the sidebar's empty space or headings to close it. The selected project filter is remembered
on this device when you close the sidebar or reload the page.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

Pinning and snoozing preserve active positions. The settled shelf uses settlement time.
Cross-section dragging and synced ordering require server support; update an older server
if those actions are unavailable.

## Colors

Right-click a thread and choose **Colour** to mark it with one of ten muted colors, or **No
colour** to clear it. The color enters the card from the left and fades out across it.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Threads that are working or waiting on work they will resume from move into a collapsed
**Working** section below the active list.
That includes subagents, watched pull requests, and background commands or monitors the agent
says it is waiting on. A dev server or other process an agent leaves running does not keep a thread
there. A thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. The Working section lists the thread you last sent work to first. Pinned threads stay in
the pinned section.

This is on by default. Turn it off with **Settings → General → Working section** on web and desktop,
or **Settings → General → Working section** on iOS and Android. Each device keeps its own
choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

### Group threads by project (beta)

Turn on **Settings → Labs → Boring sidebar (group by project)** on web and desktop to put active
threads in a folder for each project. Pinned projects come first. A project with no active
threads has no folder unless it is pinned and unarchived, or you pick it in the project filter.
An archived project's folder comes last and shows while it has active threads or is selected in the project filter. Click a folder to open or
close it. A closed folder shows how many threads it holds, and a dot when one of them
needs you. Use the pen button on a folder, or right-click it, to start a thread in that project.
Pinned threads stay above the folders, and Snoozed and Settled stay below them. In this mode you
cannot drag threads, and the Working section is off. Each device keeps its own choice.

## Settle finished work

A project can carry a color of its own, set in its settings. It marks that project's threads from
the right, and only while the sidebar is showing every project — scoped to one project it would
paint every row alike. A thread with its own color shows both at once, one from each side. Nothing
is colored until you color it, and colors are kept on the device you set them on.

## Finished pull requests

A thread whose pull request merges or closes stays where it is under the default policy. Select
**When PR merges or closes** in Settings if those events should settle threads automatically.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.
Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

Automatic settlement is disabled by default. Choose **When PR merges or closes**
to settle idle threads when their linked pull requests are all closed or merged,
or choose **After inactivity** to settle them after the configured inactivity period.
These modes are exclusive. Open pull requests keep threads active in inactivity
mode. Work in progress, pending questions or approvals, and live agent background
work prevent automatic settlement. An old closed or merged pull request does not
settle work you resumed after it closed. Only your own messages count as resuming;
automatic background turns and pull request watches do not.
Enable **Keep threads with a PR** to also exclude threads with closed or merged
pull requests from inactivity settlement. PR-based settlement still follows the
selected automatic settlement mode.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → Threads**.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments by title, branch, pull request, or project.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise the thread itself, which pastes into a composer as
a thread chip. To copy the thread even when it has a PR, choose **Copy → Thread**
from its context menu, or **Copy thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
Press **Resume** in an empty composer to continue a limited or interrupted turn
manually. Do this when the provider reports no reset time, because nothing
continues the turn on its own.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. **Auto-resume limited threads** is enabled by default when no saved
preference exists. It schedules a continuation for the main thread when its provider
reports a usage-limit reset time. Change it in **Settings → Threads** on web and
desktop, or **Settings → Threads** on mobile. A saved Off preference is
preserved, and you can cancel an individual continuation from its thread.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call to inspect its inputs, status, and command exit code. Raw command output and
tool-result bodies are not shown. See [Activity log](./activity-log.md) for summary behavior.

## Panel motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Under
**Settings → Appearance → Motion**, move the **Panel animations** slider above 0 ms to add motion.
The duration can be set up to 400 ms. Clicking the preview replays all three panel transitions; at
0 ms, it snaps between the same open and closed states.

## Environment icons

When you are connected to more than one environment, every thread that lives somewhere other than
the machine you are on wears a small icon for that machine at the end of its row: a server, a cloud
VM, a desktop, a laptop, a Mac mini, or a Mac Studio. In a separately served web client and the mobile app,
where every environment is remote, each row wears its machine so you can tell them apart at a
glance. The same icon appears wherever an environment is named: the thread tooltip, the command
palette, the "Run on" picker, the pull request server filter, the provider settings device tabs,
and the environment lists under **Settings → Connections**. On mobile it appears in the thread
lists, the archive, the new-task environment picker, and the Environments and storage settings.

Servers pick the icon themselves from the hardware they run on. A Mac reports its model, a Linux
machine reports its chassis type and whether it is a virtual machine, and anything without a usable
signal shows a generic server. To override it, open **Settings → Connections** and choose an icon
for that environment; **Automatic** goes back to what the server detected. The choice is stored on
that server, so every device that connects to it sees the same icon.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

On web and desktop, the browser panel lists discovered servers under **Local servers**,
with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel.

To choose what the thread details card shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Side chats

A side chat lets you ask a question about a thread without adding to it. It starts
with what the thread knows, and the thread keeps working while you ask.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from the **+** menu in the right panel. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in thread details.

A side chat works in the same folder as the thread. Its first reply asks before it
edits files or runs commands. After that, it uses the permission mode you choose
in its composer.

To use what you learned, choose **Bring back**. It adds the side chat to your next message in the thread. Bring back is available while the thread is idle.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

### Working and Monitoring

**Working** means the foreground agent turn is active. **Monitoring** means the agent
has replied and is waiting on background commands, subagents, monitors or response
watches. Monitoring threads remain in the Working section when that section is
enabled, and their project activity dot stays visible. They switch back to Working
when another agent turn starts, or become ready when their background work ends.
A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early only when it needs
an approval or answer from you, when a run fails, or when you send it a message.
