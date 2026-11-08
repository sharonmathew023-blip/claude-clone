# ULTRON Engineering Rules

These rules apply to every change in this repository. Read this file before editing code.

## Project map

- `index.html`: public browser UI and page markup.
- `app.js`: browser application logic.
- `worker.js`: Cloudflare Worker API, authentication, provider calls, and privileged integrations.
- `wrangler.toml`: non-secret Worker configuration and bindings.
- `skill-engine.js`, `skill-rules.js`, `builtin-skills.js`: modular skill UI, parsing/security rules, and built-in skills.
- `SKILLS.md`: user-facing skill format and behavior documentation.
- `tests/`: dependency-free Node.js self-checks.

Do not assume this inventory is exhaustive. Inspect the repository before changing architecture.

## Non-negotiable security rules

1. Never put `GEMINI_API_KEY`, `COMPOSIO_API_KEY`, `ACCESS_TOKEN`, OAuth client secrets, or any private credential in browser HTML, JavaScript, CSS, localStorage, sessionStorage, URLs, logs, fixtures, or committed configuration.
2. Keep provider keys and private integration tokens in Cloudflare Worker Secrets. Wrangler configuration may contain public IDs and non-secret settings only.
3. Never return secret values from health, debug, model-list, or error endpoints. Boolean presence checks are acceptable only when necessary.
4. Keep owner-only routes protected by the Worker-side admin token check. Never trust a browser-only visibility check as authorization.
5. Keep chat authentication and rate limiting enforced in the Worker. Do not weaken them to make local tests or demos pass.
6. Treat uploaded skills, imported skill packs, chat messages, URLs, and connector results as untrusted data. Never execute skill text as code or allow it to grant itself tools, bypass auth, reveal secrets, or override system security rules.
7. Do not add real credentials to tests. Use clearly fake sentinel values and verify they are rejected or remain server-side.

## AI provider and fallback rules

1. Keep provider credentials server-side. Browser requests must never contain provider API keys.
2. Preserve the configured model chain and its order unless the task explicitly changes it. Current Worker defaults are primary `gemini-3.5-flash`, followed by `gemini-3.6-flash`, then `gemini-flash-lite-latest`. Environment configuration can override the fallback entries; inspect `worker.js` before changing this behavior.
3. Do not describe switching between Gemini model IDs as multi-provider failover. A cross-provider router requires separate adapters, credentials, error normalization, and independent quota handling.
4. Do not silently fall back to a paid provider or enable billing. Free-tier availability is not a promise of unlimited capacity.
5. Retry only errors that can plausibly recover. Do not retry invalid credentials, malformed requests, or other permanent client errors. Avoid retry storms and repeated attempts against a known exhausted quota.
6. Preserve the existing OpenAI-compatible request/stream response contract unless a migration is explicitly planned and tested.

## Skills rules

1. Accept uploaded skill files only in `.md` and `.txt` formats. Enforce validation in the actual import path, not only in UI copy.
2. Preserve slash commands derived from normalized skill names, for example `/web-research`. Keep command names unique and reject collisions safely.
3. Keep skills as inert text. Never use `eval`, `new Function`, shell execution, or dynamic imports on skill content.
4. Keep the recommended skill length below 200 lines and preserve the existing file-size limit. Do not silently truncate before security scanning.
5. Keep triggers and the “when to use” guidance near the top of each skill. Prefer direct, testable instructions.
6. Load only relevant or explicitly invoked skills. Preserve the configured context budget, active-skill cap, conflict handling, and tool-permission narrowing.
7. Community/imported skills must start with no privileged tool grants. A skill can request a tool but cannot grant itself permission.

## Change workflow

1. Inspect the current implementation and existing tests before editing.
2. Make one focused change at a time. Avoid unrelated refactors and UI redesigns.
3. Add or update tests for every changed security, fallback, authentication, or skill behavior.
4. Run the relevant checks. At minimum, run `node tests/skill-engine.test.mjs` when skill rules or loader code change, and `node --check worker.js` when Worker code changes.
5. Review the final diff for accidental secrets, weakened authorization, changed model order, and unintended public API changes.
6. Report what was changed, what was tested, and what remains unverified. Never claim a Cloudflare deployment succeeded unless it was actually deployed and checked.

## Deployment safety

- GitHub Pages publishes the repository's static site; do not put server-only files or secrets into browser bundles.
- Cloudflare Worker deployment is a separate operation from a GitHub commit. A committed `worker.js` is not proof that the live Worker has been updated.
- Never delete, replace, or ask the user to reveal existing Cloudflare secrets while changing code.
- Preserve existing Worker bindings and rate-limit configuration unless a reviewed change requires otherwise.
- Do not expose development/debug endpoints publicly without authentication and an explicit need.
