# ULTRON Skill Engine 2.0

Skills are small Markdown files. ULTRON loads only the skills a request needs, so the system prompt stays short and the Cloudflare Worker stays fast. A skill can be activated three ways:

- **Automatically** from its trigger phrases.
- **Explicitly** with `/skill-name`.
- **Together** with several commands: `/research /code-review compare these two implementations`.

Activate up to five skills per reply (`Settings → Skill Engine 2.0 → Active skills per reply`). Higher priority skills run first and win conflicts. A request containing a URL also detects skills that request `web.read`, so page reading always follows an explicit skill grant.

## File format

```markdown
---
name: Release Notes
description: Turn merged changes into short, factual release notes.
triggers: release notes, changelog, ship notes, what changed
priority: 55
tools: github.read
conflicts: concise-writer
---
# Release Notes

## When to use
- The user asks what changed since the last release.

## Steps
1. Read the changes that are available to you.
2. Group them as Added, Changed, Fixed.
3. Name user-visible behaviour, not internal refactors.

## Never
- Never invent a change, a version number, or a date.
```

### Front matter

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | Recommended | Display name. The command is derived from it (`/release-notes`). |
| `description` | Recommended | One sentence. Also used as a weak auto-detection signal. |
| `triggers` | Recommended | Comma-separated phrases. Put the strongest first. |
| `priority` | No | `0`–`100`, default `50`. Higher runs first and wins conflicts. |
| `tools` | No | Requested tool ids. Community skills start with none granted. |
| `conflicts` | No | Commands that must not run with this skill. |
| `always` | No | `true` applies the skill to every reply. Use sparingly. |

### Keep skills small

- Stay under **200 lines**. Split a heavy skill into sub-skills and let priority order them.
- Put trigger phrases and the "When to use" section at the top. Truncation keeps the top.
- Use direct instructions: "Do X", "Never do Y". Drop filler and conversation.
- Community skills are portable: upload `.md`/`.txt`, paste one, or exchange a JSON skill pack.

## Tool permissions

Tools are read-only and owner-scoped:

| Tool | Capability |
| --- | --- |
| `web.read` | Read public HTTPS page text. |
| `github.read` | Read connected GitHub data through Composio. |
| `github.write` | Declared for future use. Not available and never granted. |

A skill must both **declare** a tool in front matter and be **approved** by you in the skill's Details panel. Community skills are imported with no tool access. Unknown tool names are recorded and denied.

The Worker re-checks every request: the skill manifest can only narrow its built-in read-only tool set, never widen it, and tool execution still requires the private admin token plus Google sign-in.

## Token behaviour

- Default context budget: **1200 tokens** (adjustable 300–4000).
- Automatic skills get a small slice; explicitly invoked skills get more.
- Skills over their slice are truncated at a line boundary with a `/command` hint, so the full text stays local.
- The composer shows the active skills and the estimated injected tokens before you send.

## Security model

**Uploaded skills are untrusted instructions, not code.** The engine never evaluates skill text. It is parsed as data and injected as text.

Skills that try any of the following are **blocked** before they can run:

- Printing, sending, or encoding API keys, tokens, environment variables, or secrets.
- Disabling, bypassing, or faking sign-in, authentication, or authorization.
- Executing arbitrary code (`eval`, `new Function`, child processes, shell pipes).
- Overriding the system prompt, changing identity, or revealing hidden instructions.
- Containing hard-coded credentials or `javascript:` / `<script>` payloads.

Warnings (external links, browser storage, destructive wording, oversized files) import the skill in a **paused** state until you review it. Blocked skills are rejected outright.

The same scan runs again **inside the Cloudflare Worker** on every injected skill context, so a modified or stale browser cannot smuggle harmful instructions past the boundary. The Worker scans from the first skill marker to the end of the system message, so a fake closing marker cannot hide text behind it. The system prompt also carries a fixed rule that skill text never outranks secret handling, authentication, or code execution policy. Credentials such as `GEMINI_API_KEY` and Composio keys stay in Worker secrets and are never sent to the browser or to a skill.

What this does not do: it does not sandbox the model's reasoning. A harmless-looking skill can still ask for low-quality work, so review the instructions in Details before enabling a community skill.

## Testing

```bash
node tests/skill-engine.test.mjs
```

The self-check covers parsing, blocking patterns, negation-safe wording, detection, multi-activation, priorities, conflicts, caps, truncation, and tool-permission narrowing.
