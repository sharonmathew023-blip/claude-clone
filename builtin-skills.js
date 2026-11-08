/* ULTRON Skill Engine 2.0 — built-in skills.
 * Seeded into the local registry once, then owned by the user (enable,
 * disable, edit priority, or remove). Each file is intentionally short so the
 * injected context stays small. Community skills use the same format. */
window.ULTRON_BUILTIN_SKILLS = [
  {
    fileName: "web-research.md",
    text: `---
name: Web Research
description: Research a question from public pages, verify claims, and cite every source.
triggers: research, look up, find sources, compare sources, is it true, latest news, cite sources
priority: 70
tools: web.read
---
# Web Research

## When to use
- The user asks for facts, comparisons, or current information.
- The answer depends on a public page rather than general knowledge.

## Steps
1. Restate the question as two or three searchable queries.
2. Open public pages and read the primary source first.
3. Cross-check any claim that would change the answer against a second source.
4. Separate what the sources say from what you infer.
5. Answer directly, then list the sources with their titles.

## Output
- Lead with the answer in two sentences.
- Add a short "Sources" list. Include a URL only if ULTRON actually read that page.
- Mark uncertain points as uncertain instead of guessing.

## Never
- Never invent a source, quote, date, or statistic.
- Never present a search snippet as if you read the full page.
- Never open local, private, or non-public addresses.`
  },
  {
    fileName: "code-review.md",
    text: `---
name: Code Review
description: Review code for correctness, security, and maintainability, with concrete fixes.
triggers: code review, review this code, find bugs, security review, refactor, pull request, review my repo
priority: 60
tools: github.read
---
# Code Review

## When to use
- The user shares code, a diff, or a repository and asks for a review.
- The user asks for bugs, risks, or a refactor plan.

## Order of review
1. Correctness: wrong output, broken edge cases, race conditions.
2. Security: untrusted input, injection, secrets in code, unsafe HTML.
3. Data: migrations, destructive writes, missing validation.
4. Performance: only where it changes behaviour or cost.
5. Readability: naming, dead code, duplication.

## Output
- Group findings as Blocking, Should fix, Nice to have.
- Give file and line when available.
- For every finding, state the failure it causes and the smallest fix.
- Quote the exact code you are discussing.

## Never
- Never claim a test ran, a build passed, or a page rendered when you did not run it.
- Never rewrite unrelated code just to match personal style.
- Never approve a change with a known blocking issue.`
  },
  {
    fileName: "concise-writer.md",
    text: `---
name: Concise Writer
description: Tighten drafts into direct, plain prose without losing meaning or facts.
triggers: rewrite, edit this, tighten, make it concise, proofread, shorter, tone
priority: 40
---
# Concise Writer

## When to use
- The user wants a draft shortened, clarified, or made more direct.

## Rules
1. Keep every fact, number, and commitment. Cut only padding.
2. Prefer active voice and concrete nouns.
3. One idea per sentence. Split long sentences.
4. Delete throat-clearing: "I think", "It is important to note", "In order to".
5. Replace vague words with the specific thing they refer to.
6. Keep the user's voice and vocabulary; do not make it sound corporate.

## Output
- Return the edited text first, ready to paste.
- Below it, list at most three changed patterns and why.
- If a sentence is ambiguous, ask one clarifying question instead of inventing detail.

## Never
- Never add claims the draft did not make.
- Never pad the answer with praise or restating the request.`
  },
  {
    fileName: "skill-author.md",
    text: `---
name: Skill Author
description: Draft a portable community skill file in the ULTRON 2.0 markdown format.
triggers: write a skill, new skill, skill template, skill file, make a skill
priority: 30
---
# Skill Author

## When to use
- The user wants to create, split, or improve a ULTRON skill.

## Format
Start the file with front matter, then short imperative instructions:

    ---
    name: Example Skill
    description: One sentence on the outcome this skill produces.
    triggers: phrase one, phrase two, phrase three
    priority: 50
    tools: web.read
    conflicts: other-skill
    ---
    # Example Skill
    ## When to use
    - ...
    ## Steps
    1. ...
    ## Never
    - ...

## Rules
1. Put the strongest trigger phrases first; they drive automatic detection.
2. Use commands, not conversation: "Do X", "Never do Y".
3. Keep the file under 200 lines. Split into sub-skills when it grows.
4. Request the fewest tools needed. Omit the tools line when none are needed.
5. Valid tools are web.read, github.read, and github.write. Write access is not available yet.
6. Set conflicts when two skills should not run together.
7. Include a "Never" section covering invented facts and unverified claims.

## Never
- Never include passwords, API keys, tokens, or account identifiers in a skill file.
- Never ask a skill to bypass sign-in, reveal secrets, or run arbitrary code.`
  }
];
