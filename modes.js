// modes.js - ULTRON modes + Research (Gemini + Google Search grounding)
// Drop next to worker.js. Needs env.GEMINI_API_KEY (server-side secret).

export const MODES = {
  chat: {
    search: false,
    system: "You are ULTRON, a friendly everyday AI. Keep answers short and clear.",
  },
  research: {
    search: true,
    system:
      "You are ULTRON Research. Search the web, compare sources, and answer with facts. " +
      "Lead with the answer. Then give key points as bullets. Say when sources disagree.",
  },
  agent: {
    search: false,
    system:
      "You are ULTRON Agent. Break the task into numbered steps (max 5). " +
      "Do each step, then report what you did.",
  },
  studio: {
    search: false,
    system:
      "You are ULTRON Studio. Build websites, games and code. " +
      "Return complete runnable code in one block.",
  },
  developer: {
    search: false,
    system:
      "You are ULTRON Developer. Help with GitHub, debugging, tests and deploys. " +
      "Ask before any action that writes or deletes.",
  },
};

// Ordered fallback list. Edit to match your Smart AI Engine.
const MODEL_FALLBACK = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const TIMEOUT_MS = 25000;

async function callGemini(env, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Try each model. Retry 429/503 with backoff, then move to the next model.
async function generate(env, body) {
  let lastError = "Unknown error";
  for (const model of MODEL_FALLBACK) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await callGemini(env, model, body);
        if (res.ok) return { data: await res.json(), model };
        lastError = `${model} returned ${res.status}`;
        if (res.status === 400 || res.status === 403) {
          throw new Error("Bad request or invalid API key");
        }
        if (res.status !== 429 && res.status !== 503) break;
      } catch (e) {
        if (e.message.startsWith("Bad request")) throw e;
        lastError = e.name === "AbortError" ? `${model} timed out` : e.message;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(lastError);
}

// Insert [1] [2] markers into the text using Gemini's grounding support.
// Gemini gives byte offsets, so work in UTF-8 bytes.
function addCitations(text, meta) {
  const supports = meta?.groundingSupports || [];
  if (!supports.length) return text;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let bytes = enc.encode(text);
  const sorted = [...supports].sort(
    (a, b) => (b.segment?.endIndex ?? 0) - (a.segment?.endIndex ?? 0)
  );
  for (const s of sorted) {
    const end = s.segment?.endIndex;
    const ids = (s.groundingChunkIndices || []).map((i) => i + 1);
    if (end == null || !ids.length) continue;
    const marker = enc.encode(" " + ids.map((n) => `[${n}]`).join(""));
    bytes = new Uint8Array([...bytes.slice(0, end), ...marker, ...bytes.slice(end)]);
  }
  return dec.decode(bytes);
}

// POST body: { mode: "research", messages: [{ role: "user"|"assistant", content: "..." }] }
// Returns:   { text, sources: [{ title, url }], model, mode }
export async function handleModeRequest(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const mode = MODES[payload.mode] ? payload.mode : "chat";
  const cfg = MODES[mode];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length) return json({ error: "No messages" }, 400);

  const body = {
    systemInstruction: { parts: [{ text: cfg.system }] },
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    })),
  };
  if (cfg.search) body.tools = [{ google_search: {} }];

  try {
    const { data, model } = await generate(env, body);
    const cand = data.candidates?.[0];
    const raw = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    if (!raw) return json({ error: "Empty reply. Try again." }, 502);

    const meta = cand.groundingMetadata;
    const sources = (meta?.groundingChunks || [])
      .map((c) => c.web)
      .filter(Boolean)
      .map((w) => ({ title: w.title, url: w.uri }));

    return json({ text: addCitations(raw, meta), sources, model, mode });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/* ---- Hook into worker.js ----
import { handleModeRequest } from "./modes.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }});
    }
    if (url.pathname === "/mode" && request.method === "POST") {
      return handleModeRequest(request, env);
    }
    // ...your existing chat handler stays below, untouched
  },
};
*/
