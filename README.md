# ULTRON

A lightweight, local-first AI chat workspace. The interface runs in your browser; you connect your own model provider.

## Features

- Responsive desktop and mobile layout
- Local conversation history using browser `localStorage`
- Search, create, and delete conversations
- Light and dark themes
- Ollama local model streaming
- OpenAI-compatible chat-completions streaming
- Session-only API key handling (not persisted)
- System prompt settings
- Skill Engine 2.0: automatic detection, `/skill-name` commands, multiple concurrent skills, priority and conflict handling, per-skill tool permissions, token budgets, and community skill upload
- Copyable code blocks
- Sandboxed HTML artifact preview and download
- Export conversation data as JSON

## Run it

1. Install [Ollama](https://ollama.com/) if you want a local model.
2. Pull a model, for example:

   ```bash
   ollama pull llama3.2
   ```

3. Start Ollama:

   ```bash
   ollama serve
   ```

4. Serve this folder from localhost. For example, with Python:

   ```bash
   python -m http.server 8000
   ```

5. Open `http://localhost:8000` and select **Settings → Ollama**.
6. Set the base URL to `http://localhost:11434` and model to `llama3.2`.

## Browser access / CORS

The browser calls Ollama directly. If the browser blocks requests, configure Ollama's allowed origins for your local web origin, then restart Ollama. For example, set `OLLAMA_ORIGINS` to include `http://localhost:8000` (and `http://127.0.0.1:8000` if you use that address).

Do not expose an Ollama server directly to the public internet.

## OpenAI-compatible provider

Choose **OpenAI-compatible API**, enter the provider's API root (for example, `https://api.example.com/v1`), model name, and API key. The app appends `/chat/completions` unless the URL already ends with that path. Some providers may require extra headers or have CORS restrictions; this basic client cannot support every provider-specific variation.

The API key stays in JavaScript memory for the current page session. It is not saved to localStorage. Reloading the page clears it.

## Skill Engine 2.0

Skills are short Markdown files with front matter. ULTRON activates them automatically from trigger phrases, explicitly with `/skill-name`, or several at once (`/research /code-review …`). Injected context is capped by a token budget, and each skill can use only the read-only tools you approve for it.

Uploaded skills are treated as untrusted instructions: the engine scans them for secret extraction, authentication overrides, arbitrary code execution, and prompt injection, and the Cloudflare Worker re-checks every injected skill block. Blocked skills cannot be enabled or run. See [SKILLS.md](SKILLS.md) for the format, permissions, and security model.

## Important limitations

- Demo mode is an interface preview, not an AI model. It does not generate intelligent answers offline.
- Conversations are stored in this browser only. They do not sync between devices.
- Clearing site data removes saved conversations.
- HTML artifacts run in a sandboxed iframe with scripts enabled but without same-origin access. Treat generated code as untrusted.
- The Markdown renderer is intentionally lightweight and does not implement the full Markdown specification.
- This is a static front-end. There is no server-side account system, database, authentication, or proxy.

## Files

- `index.html` — application structure and chat pipeline
- `styles.css`, `skill-engine.css` — responsive interface, themes, skills UI
- `app.js` — legacy static demo client (the Worker build uses the inline script)
- `skill-rules.js` — shared skill parser, security scanner, detection, budgets, tool rules
- `skill-engine.js` — browser skill registry, settings UI, activation, import/export
- `builtin-skills.js` — bundled starter skills
- `worker.js` — Gemini/Composio proxy with server-side skill enforcement
- `SKILLS.md` — skill format and security model
- `tests/skill-engine.test.mjs` — dependency-free self-check
