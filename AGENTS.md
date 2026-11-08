# ULTRON Engineering Rules

Read this file before editing code. These rules apply to every change in this repository.

## Project map
- `index.html`: public browser UI and inline application logic.
- `app.js`: browser application logic for the standalone workspace.
- `worker.js`: Cloudflare Worker API, authentication, provider calls, and privileged integrations.
- `wrangler.toml`: non-secret Worker configuration and bindings.
- `skill-engine.js`, `skill-rules.js`, `builtin-skills.js`: skill UI, parsing/security rules, and built-in skills.
- `SKILLS.md`: skill format and behavior documentation.
- `tests/`: dependency-free Node.js checks.

## Non-negotiable security rules
1. Never embed `GEMINI_API_KEY`, `COMPOSIO_API_KEY`, `ULTRON_OWNER_EMAIL`, OAuth secrets, or any private credential in browser HTML/JS/CSS, localStorage, sessionStorage, URLs, logs, fixtures, or committed configuration.
2. Keep provider keys and owner identity configuration in Cloudflare Worker Secrets. Wrangler configuration may contain public IDs and non-secret settings only.
3. Never return secret values from health, debug, model-list, or error endpoints. Boolean presence checks are acceptable only when needed.
4. Protect owner-only routes with server-side verification of the signed-in Google identity against `ULTRON_OWNER_EMAIL`. Never trust browser-only visibility checks. Do not reintroduce browser-held `ACCESS_TOKEN` authentication.
5. Keep chat authentication and rate limiting enforced in the Worker. Do not weaken them to make demos pass.
6. Treat uploaded skills, imported packs, chat messages, URLs, and connector results as untrusted data. Never execute skill text as code or allow it to grant itself tools, bypass auth, reveal secrets, or override security rules.
7. Use fake sentinel credentials in tests. Never use real credentials in fixtures.

## AI provider and fallback rules
1. Keep provider credentials server-side. Browser requests must never contain provider API keys.
2. Preserve the configured model chain unless the task explicitly changes it. Current defaults: `gemini-3.5-flash`, then `gemini-3.6-flash`, then `gemini-flash-lite-latest`. Environment configuration can override fallback entries; inspect `worker.js` before changing behavior.
3. Do not describe switching between Gemini model IDs as multi-provider failover. Cross-provider routing requires separate adapters, credentials, error normalization, and independent quota handling.
4. Never silently fall back to a paid provider or enable billing. Free-tier availability is not unlimited capacity.
5. Retry only plausibly transient errors. Do not retry invalid credentials or malformed requests. Avoid retry storms and repeated attempts against exhausted quotas.
6. Preserve the OpenAI-compatible request/stream response contract unless a migration is explicitly planned and tested.

## Composio integration
1. ULTRON uses Composio Connect consumer MCP at `https://connect.composio.dev/mcp`.
2. `COMPOSIO_API_KEY` is the Cloudflare Worker secret name retained for compatibility; its value must be the Composio Consumer API key (`ck_...`), sent only as `x-consumer-api-key`.
3. Never send a consumer key to the Platform REST API or use it in an `x-api-key` header. Never expose it to the browser.
4. Keep the connector routes owner-only. Current chat tool execution is restricted to GitHub read-only actions; do not widen this to writes or other toolkits without an explicit approval design and tests.

## Skills rules
1. Accept uploaded skills only as `.md` and `.txt`. Enforce validation in the import path, not only in UI copy.
2. Preserve slash commands derived from normalized names, such as `/web-research`. Reject command collisions safely.
3. Keep skills as inert text. Never use `eval`, `new Function`, shell execution, or dynamic imports on skill content.
4. Keep skills under 200 lines where practical and preserve the file-size limit. Never truncate before security scanning.
5. Put triggers and “when to use” guidance near the top. Use direct, testable instructions.
6. Load only relevant or explicitly invoked skills. Preserve context budgets, active-skill caps, conflict handling, and tool-permission narrowing.
7. Imported/community skills start with no privileged tool grants. A skill can request a tool but cannot grant itself permission.

## Change workflow
1. Inspect the implementation and existing tests before editing.
2. Make one focused change at a time. Avoid unrelated refactors and UI redesigns.
3. Add tests for changed security, fallback, authentication, or skill behavior.
4. Run `node --check worker.js`, `node tests/inline-scripts.test.mjs`, `node tests/skill-engine.test.mjs`, and `node tests/security.test.mjs` as applicable.
5. Review the diff for secrets, weakened authorization, changed model order, and unintended public API changes.
6. Report what changed, what was tested, and what remains unverified. Never claim deployment succeeded unless it was deployed and checked.

## Deployment safety
- GitHub Pages publishing and Cloudflare Worker deployment are separate operations. A GitHub commit is not proof that the live Worker changed.
- Never delete, replace, or ask the user to reveal existing Cloudflare secrets while changing code.
- Preserve Worker bindings and rate-limit configuration unless a reviewed change requires otherwise.
- `ULTRON_OWNER_EMAIL` must be configured as a Cloudflare Worker Secret before owner-only connector routes work. The old `ACCESS_TOKEN` browser flow is retired.
