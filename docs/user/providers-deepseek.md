# Local DeepSeek

In **Settings → Providers**, add **DeepSeek (local)** and enable the instance. Select it in the model picker for text tasks. It uses the service on the machine running your d4 server, including when you connect remotely.

The defaults are `http://127.0.0.1:8094/v1` and `deepseek-v4.1-flash-ist-das-1.75bpw`. d4 does not install or restart the service. Only numeric loopback HTTP endpoints are accepted; redirects are rejected.

DeepSeek can generate text from the conversation. It cannot read workspace files, execute commands, call MCP tools, or perform public actions. Attachments are unsupported. Existing provider permissions and Tool Guard settings still apply when another provider runs a task.

To enable routing, set a **Fallback provider instance** and **Fallback model**, then enable **Smart routing**. This explicitly allows the conversation to be handed to that provider. Choose **Text** or **Tools (fallback)** in the model picker's task mode. Tools mode always requires a capable fallback. Text mode uses local endpoint health, recent performance, availability, and context pressure to choose a provider before accepting the turn. If the configured fallback is unavailable, the request fails.

The selected provider stays fixed during the turn. A failed turn is not automatically replayed elsewhere; its outcome informs the next turn. Queued turns keep the selection made when accepted. To stop routing, disable **Smart routing** or select a different provider.

Routing records stay in the server's local database. They contain timings, counts, outcomes, and hashed identifiers, without prompt or response text. Normal conversation history is still stored as usual. The thread and run records retain the selected provider and routing reason. Routing measurements retain at most 10,000 observations; recent performance uses up to 20 terminal observations from the previous hour. Context estimates are conservative, and the default 32,768-token limit is a configurable guard, not a measured service limit.
