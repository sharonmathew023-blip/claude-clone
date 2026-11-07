// OpenClaude Gemini proxy. Deployed from GitHub via Cloudflare Workers Builds.
// OpenAI-compatible requests in, OpenAI-compatible server-sent events out.
//
// Required secret:
//   GEMINI_API_KEY
// Optional settings (Worker > Settings > Variables and Secrets):
//   ACCESS_TOKEN     secret. When set, callers must send "Authorization: Bearer <token>"
//   ALLOWED_ORIGINS  comma-separated site origins. When unset, any site may call
//   FALLBACK_MODEL   model to try when the main model keeps failing with 429/5xx
//   DEFAULT_MODEL    model used when a request does not name one
//
// Routes:
//   GET  /health            -> { ok, hasKey }
//   GET  /models            -> OpenAI-style model list
//   POST /chat/completions  -> streams the reply
// Errors are JSON: { error: { message, type, code } } with a real HTTP status.

const DEFAULT_MODEL = "gemini-3.8-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGES = 200;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const HEADERS_TIMEOUT_MS = 25_000; // wait for the first response headers, not for the whole stream
const SAME_MODEL_ATTEMPTS = 2; // one quick retry here; the browser shows the longer retries

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsFor(request, env);
    const reply = (data, status = 200, extra) => jsonResponse(data, status, cors.headers, extra);
    const fail = (status, message, extra) => reply(errorBody(status, message), status, extra);

    if (!cors.allowed) return fail(403, "This origin is not allowed. Add it to ALLOWED_ORIGINS.");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });

    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "GET" && (path === "" || path === "/health")) {
      return reply({ ok: true, hasKey: Boolean(env.GEMINI_API_KEY), message: "OpenClaude Gemini proxy is running. Use POST /chat/completions." });
    }

    if (!authorized(request, env)) {
      return fail(401, "Missing or wrong access token. Put it in Settings > Access token.");
    }

    if (request.method === "GET" && path.endsWith("/models")) {
      let ids = [env.DEFAULT_MODEL || DEFAULT_MODEL, env.FALLBACK_MODEL].filter(Boolean);
      if (env.GEMINI_API_KEY) {
        try { // ask Google which models your key can really use right now
          const res = await fetch(`${GEMINI_BASE}/models?pageSize=100`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY }, signal: AbortSignal.timeout(8000) });
          if (res.ok) {
            const j = await res.json();
            const live = (j.models || [])
              .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
              .map((m) => String(m.name).replace(/^models\//, ""));
            if (live.length) ids = live;
          }
        } catch { /* keep the static list */ }
      }
      return reply({ object: "list", data: [...new Set(ids)].map((id) => ({ id, object: "model" })) });
    }

    if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
      return fail(404, "OpenClaude Gemini proxy is running. Use POST /chat/completions.");
    }
    if (!env.GEMINI_API_KEY) {
      return fail(500, "Missing GEMINI_API_KEY Worker secret. Add it in Cloudflare Worker Settings > Variables and Secrets.");
    }

    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) return fail(413, "Request is too large.");
    let raw;
    try { raw = await request.text(); } catch { return fail(400, "Could not read the request body."); }
    if (raw.length > MAX_BODY_BYTES) return fail(413, "Request is too large.");
    let input;
    try { input = JSON.parse(raw); } catch { return fail(400, "Request body must be valid JSON."); }

    if (!input || !Array.isArray(input.messages) || input.messages.length === 0) {
      return fail(400, "A non-empty messages array is required.");
    }
    if (input.messages.length > MAX_MESSAGES) return fail(400, `Too many messages (max ${MAX_MESSAGES}).`);

    const model = String(input.model || env.DEFAULT_MODEL || DEFAULT_MODEL).replace(/^models\//, "");
    if (!MODEL_RE.test(model)) return fail(400, "Invalid model name.");

    const geminiBody = buildGeminiBody(input);
    if (!geminiBody.contents.length) return fail(400, "No user or assistant messages were provided.");

    const fallback = String(env.FALLBACK_MODEL || "").replace(/^models\//, "");
    const models = Array(SAME_MODEL_ATTEMPTS).fill(model);
    if (fallback && fallback !== model && MODEL_RE.test(fallback)) models.push(fallback);

    const result = await callGemini(models, JSON.stringify(geminiBody), env.GEMINI_API_KEY);
    if (result.error) {
      const extra = result.error.retryAfter ? { "Retry-After": result.error.retryAfter } : undefined;
      return fail(result.error.status, result.error.message, extra);
    }

    return new Response(toOpenAIStream(result.res.body, result.model), {
      headers: {
        ...cors.headers,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  },
};

/* ---------- request translation ---------- */

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  return content == null ? "" : String(content);
}

function buildGeminiBody(input) {
  const systemText = input.messages
    .filter((m) => m && m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n\n");

  const contents = [];
  for (const m of input.messages) {
    if (!m || m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    const text = textOf(m.content);
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n\n" + text; // Gemini wants alternating turns
    else contents.push({ role, parts: [{ text }] });
  }
  while (contents.length && contents[0].role !== "user") contents.shift();

  const body = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  const cfg = {};
  if (typeof input.temperature === "number") cfg.temperature = input.temperature;
  if (typeof input.top_p === "number") cfg.topP = input.top_p;
  if (Number.isInteger(input.max_tokens) && input.max_tokens > 0) cfg.maxOutputTokens = input.max_tokens;
  if (Object.keys(cfg).length) body.generationConfig = cfg;
  return body;
}

/* ---------- Gemini call with retries ---------- */

async function callGemini(models, body, apiKey) {
  let last = { status: 502, message: "Could not reach the Gemini API." };
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEADERS_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer); // headers arrived: the stream itself runs without a cutoff
      if (res.ok) return { res, model };
      const text = await res.text().catch(() => "");
      last = {
        status: res.status,
        message: extractMessage(text) || `Gemini API returned HTTP ${res.status}.`,
        retryAfter: res.headers.get("Retry-After") || undefined,
      };
      if (!RETRY_STATUS.has(res.status)) return { error: last }; // bad key, bad model, bad request: retrying will not help
    } catch (err) {
      clearTimeout(timer);
      last = err && err.name === "AbortError"
        ? { status: 504, message: "Gemini did not respond in time." }
        : { status: 502, message: "Could not reach the Gemini API." };
    }
    if (i < models.length - 1) {
      const ra = Number(last.retryAfter);
      await sleep(ra > 0 && ra <= 3 ? ra * 1000 : 400 * (i + 1) + Math.random() * 300);
    }
  }
  return { error: last };
}

function extractMessage(text) {
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
    if (typeof e === "string") return e;
    return (e && e.message) || j.message || "";
  } catch {
    return text.slice(0, 300);
  }
}

/* ---------- Gemini SSE -> OpenAI SSE ---------- */

function toOpenAIStream(upstreamBody, model) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const id = "chatcmpl-" + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  let buf = "";
  let sentRole = false;
  let sawText = false;
  let errored = false;
  let finish = "";

  const frame = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finishReason = null) =>
    frame({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const errorFrame = (code, message) => frame(errorBody(code, message));

  function handle(line, ctl) {
    const t = line.trim();
    if (!t.startsWith("data:") || errored) return;
    let obj;
    try { obj = JSON.parse(t.slice(5).trim()); } catch { return; }

    if (obj.error) {
      errored = true;
      ctl.enqueue(errorFrame(Number(obj.error.code) || 502, obj.error.message || "Gemini reported an error."));
      return;
    }
    const block = obj.promptFeedback && obj.promptFeedback.blockReason;
    if (block) {
      errored = true;
      ctl.enqueue(errorFrame(422, `Gemini blocked this prompt (${block}). Try rephrasing it.`));
      return;
    }
    const cand = obj.candidates && obj.candidates[0];
    if (!cand) return;
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (text) {
      sawText = true;
      ctl.enqueue(chunk(sentRole ? { content: text } : { role: "assistant", content: text }));
      sentRole = true;
    }
    if (cand.finishReason) finish = cand.finishReason;
  }

  return upstreamBody.pipeThrough(new TransformStream({
    transform(bytes, ctl) {
      buf += dec.decode(bytes, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) handle(line, ctl);
    },
    flush(ctl) {
      buf += dec.decode();
      if (buf.trim()) handle(buf, ctl);
      if (!errored && !sawText) {
        errored = true;
        const filtered = /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/i.test(finish);
        ctl.enqueue(errorFrame(filtered ? 422 : 502, filtered
          ? `Gemini stopped without an answer (${finish}). Try rephrasing your message.`
          : "The model returned an empty response."));
      }
      if (!errored) ctl.enqueue(chunk({}, finish === "MAX_TOKENS" ? "length" : /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/i.test(finish) ? "content_filter" : "stop"));
      ctl.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  }));
}

/* ---------- helpers ---------- */

function corsFor(request, env) {
  const origin = request.headers.get("Origin");
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (!list.length || list.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
    return { headers, allowed: true };
  }
  if (origin && list.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    return { headers, allowed: true };
  }
  return { headers, allowed: !origin }; // callers without an Origin header are not browsers
}

function authorized(request, env) {
  if (!env.ACCESS_TOKEN) return true; // open, same as before
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  return Boolean(m) && safeEqual(m[1], String(env.ACCESS_TOKEN));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function errorType(status) {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

function errorBody(status, message) {
  return { error: { message, type: errorType(status), code: status } };
}

function jsonResponse(data, status, corsHeaders, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(extra || {}) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
