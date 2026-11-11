// ULTRON modes. Server-side prompts for each mode.
// The browser sends { mode: "research" } with a normal /chat/completions request.
// Auth, rate limits, model fallback, streaming and Sources all stay in worker.js.
// "chat" is the default and adds nothing.

export const MODES = {
  research: {
    webSearch: true,
    system:
      "You are ULTRON in Research mode. Use Google Search, compare sources, and answer with facts. " +
      "Lead with the answer, then give key points as short bullets. Say so when sources disagree.",
  },
  agent: {
    webSearch: false,
    system:
      "You are ULTRON in Agent mode. Break the task into at most 5 numbered steps. " +
      "Do each step, then report what you did and what is left.",
  },
  studio: {
    webSearch: false,
    system:
      "You are ULTRON in Studio mode. Build websites, games, images and code. " +
      "Return complete, runnable code in one block per file.",
  },
  developer: {
    webSearch: false,
    system:
      "You are ULTRON in Developer mode. Help with GitHub, debugging, tests and deployment. " +
      "You cannot change anything yourself, so give exact commands or diffs for the user to run.",
  },
};

// Mutates the request: adds the mode prompt first, turns on Google Search when the mode wants it.
// Returns the mode name, or null for chat and for anything unknown.
export function applyMode(input) {
  const key = input && typeof input.mode === "string" ? input.mode : "";
  if (!Object.prototype.hasOwnProperty.call(MODES, key)) return null;
  const cfg = MODES[key];
  input.messages = [{ role: "system", content: cfg.system }, ...input.messages];
  if (cfg.webSearch) input.web_search = true;
  return key;
}
