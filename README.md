# ULTRON

A browser-based AI workspace with a responsive chat interface, conversation history, skills, HTML artifact previews, and a Cloudflare Worker backend.

**Live app:** https://sharonmathew023-blip.github.io/ultron/

## Features

- Responsive chat UI with desktop and mobile layouts.
- Conversation creation, search, deletion, and local browser history.
- Dark and light themes.
- Streaming Gemini responses through an OpenAI-compatible endpoint.
- Google Identity Services sign-in verified by the Worker.
- Per-account and per-IP rate limiting.
- Model fallback and cooldown handling.
- Skill Engine with built-in and imported skills, prompt checks, and restricted read-only tool access.
- Owner-gated Composio/GitHub integration.
- HTML artifact preview, code view, and download.
- JSON conversation export.

## Architecture

- `index.html`, `styles.css`: application UI.
- `skill-rules.js`, `skill-engine.js`, `builtin-skills.js`: skill parsing, validation, activation, and UI.
- `worker.js`: Cloudflare Worker API, Google token verification, rate limiting, Gemini streaming, model fallback, and owner-only integrations.
- `wrangler.toml`: Worker deployment and binding configuration.
- `worker.test.mjs` and `tests/`: automated tests.

## Local development

Serve the repository root with a static HTTP server:

```bash
python -m http.server 8000
```

Open http://localhost:8000. The hosted chat backend still requires its configured Cloudflare Worker services and secrets.

Run the Worker tests with Node.js 20 or newer:

```bash
node --test worker.test.mjs
node --test tests/*.test.mjs
```

## Worker configuration

Configure secrets in Cloudflare, never in committed source files:

- `GEMINI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `ULTRON_OWNER_EMAIL` for owner-only features
- `COMPOSIO_API_KEY` for the connected-app integration

Configure the rate-limiter bindings and optional `ULTRON_STATE` KV namespace as described by `wrangler.toml`. Set `ALLOWED_ORIGINS` to the exact production origin when restricting browser access.

## Security notes

- Keep provider keys and consumer API keys in Worker secrets.
- The Worker verifies Google ID tokens; frontend state is not an authentication boundary.
- Imported skills are untrusted input and must remain subject to the browser and Worker validation.
- Connected tools are owner-gated and restricted to read-only capabilities.
- Treat generated HTML as untrusted, even when it is rendered in a sandboxed preview.

## Limitations

- Conversation history is stored in the current browser and does not automatically sync across devices.
- Clearing browser site data removes local conversations.
- Demo mode is a UI preview, not an offline AI model.
- Availability and model names depend on the configured Google AI account and Worker settings.

## License

No license is currently specified. All rights remain with the repository owner unless a license is added.
