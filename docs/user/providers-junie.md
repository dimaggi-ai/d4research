# Junie

d4research runs the JetBrains Junie CLI as a provider through Junie's Agent Client Protocol (ACP) mode.

## Setup

1. Install Junie using the instructions from JetBrains.
2. For fully local use, create `~/.junie/models/t3-local-ollama.json`:

   ```json
   {
     "baseUrl": "http://127.0.0.1:11434/v1/chat/completions",
     "id": "gemma4-12b-sys:latest",
     "apiType": "OpenAICompletion",
     "temperature": 0.3,
     "extraBody": { "max_tokens": 2048 },
     "primaryModel": { "id": "gemma4-12b-sys:latest" },
     "fasterModel": { "id": "gemma4-12b-sys:latest" }
   }
   ```

3. Ensure Ollama is running and the selected model appears in `ollama list`.
4. Open **Settings → Providers → Junie** in d4research.
5. Leave **Binary path** as `junie` when it is on `PATH`, or enter the absolute binary path. The default model is `custom:t3-local-ollama`; change it to `custom:<profile-name>` when using another profile.

d4research starts Junie in ACP mode with the configured default model. Models advertised by Junie are discovered during the provider health check. Provider-specific environment variables can be configured on an additional Junie instance.

Junie sessions support streaming chat, cancellation, command approvals, attachments, MCP servers, resume, model selection, and provider handoff. Provider-side rollback is not currently available through ACP.
