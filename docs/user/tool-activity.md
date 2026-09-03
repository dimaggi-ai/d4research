# Tool activity

Open a tool-group summary in the conversation to see its individual calls. Each row has an icon;
select a row to inspect its details. Select the group summary again to collapse it.

Long groups scroll inside a bounded area without expanding the whole conversation. Faded edges
indicate more calls above or below. Short groups use only the space they need.
Collapsing and reopening a group preserves your reading position and any open call details.

Recognized T3 tools display descriptive labels in both running summaries and individual rows.
These labels track the call's state, showing "Clicking" while active and "Clicked" after
success. Failed, declined, or stopped calls describe what happened without implying success.
Preview browser actions show a globe icon; other T3 tools keep the T3 mark. Group summaries
count browser actions separately, like "Used browser 18 times" or "Ran 4 commands and used
browser 15 times". Browser-only groups also use a globe icon.

Command summaries display the program in a shell wrapper, like "Running vp" for
`/bin/zsh -lc 'vp test run'`. Expanded rows retain the full command.
