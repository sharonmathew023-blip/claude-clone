// OpenClaude Gemini proxy. Deployed from GitHub via Cloudflare Workers Builds.
// OpenAI-compatible requests in, OpenAI-compatible server-sent events out.
//
// Required secret:
//   GEMINI_API_KEY
// Optional settings (Worker > Settings > Variables and Secrets):
//   ALLOWED_ORIGINS  comma-separated site origins. When unset, any site may call
//   DEFAULT_MODEL    model used when a request does not name one
//   FALLBACK_MODEL   first backup model, tried when the requested one is busy
//   FALLBACK_MODELS  comma-separated backups (default gemini-3.6-flash,
//                    gemini-flash-lite-latest)
//
// Routes:
//   GET  /health            -> { ok, hasKey }
//   GET  /models            -> OpenAI-style model list
//   POST /chat/completions  -> streams the reply
//// Errors are JSON: { error: { message, type, code } } with a real HTTP status.

const DEFAULT_MODEL = "gemini-3.5-flash"; // 3.8-flash answers 503 for days at a time
const DEFAULT_FALLBACKS = "gemini-3.6-flash,gemini-flash-lite-latest";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_BODY_BYTES = 12_000_000;
const MAX_MESSAGES = 200;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MODEL_GONE_STATUS = 404; // retired model: move on to the next one, do not retry it
const HEADERS_TIMEOUT_MS = 20_000; // wait for the first response headers, not for the whole stream
const ATTEMPTS_PER_MODEL = 2;
const TOTAL_BUDGET_MS = 45_000; // keep the answer inside the browser's 60s request timeout

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsFor(request, env);
    const reply = (data, status = 200, extra) => jsonResponse(data, status, cors.headers, extra);
    const fail = (status, message, extra) => reply(errorBody(status, message), status, extra);

    if (!cors.allowed) return fail(403, "This origin is not allowed. Add it to ALLOWED_ORIGINS.");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });

    const path = url.pathname.replace(/\/+$/, "");

    // Public-page reader used by browser-oriented custom skills.
    if (request.method === "POST" && path === "/browse") {
      if (!env.ACCESS_TOKEN) return fail(503, "Missing ACCESS_TOKEN Worker secret.");
      if (request.headers.get("Authorization") !== `Bearer ${env.ACCESS_TOKEN}`) return fail(401, "Missing or invalid Worker access token.");
      try {
        const input = await request.json().catch(() => ({}));
        let target;
        try { target = new URL(String(input.url || "")); } catch { return fail(400, "Enter a valid public website URL."); }
        if (target.protocol !== "https:" || !isPublicWebHost(target.hostname)) return fail(400, "Only public HTTPS websites can be opened.");
        let response;
        for (let hop = 0; hop < 4; hop++) {
          response = await fetch(target.toString(), {
            redirect: "manual",
            headers: { "User-Agent": "OpenClaude-PageReader/1.0", "Accept": "text/html,text/plain;q=0.9" },
            signal: AbortSignal.timeout(12000)
          });
          if (![301,302,303,307,308].includes(response.status)) break;
          const location = response.headers.get("Location");
          if (!location) break;
          target = new URL(location, target);
          if (target.protocol !== "https:" || !isPublicWebHost(target.hostname)) return fail(400, "The website redirected to a blocked address.");
        }
        if (!response || !response.ok) return fail(response ? response.status : 502, "Could not open that website.");
        const type = response.headers.get("Content-Type") || "";
        if (!/(text\/html|text\/plain)/i.test(type)) return fail(415, "That URL did not return an HTML or text page.");
        const source = await response.text();
        if (source.length > 2_000_000) return fail(413, "That page is too large to inspect.");
        const page = extractPageText(source, type);
        return reply({ ok: true, url: target.toString(), title: page.title, content: page.content.slice(0, 18000), html: page.html.slice(0, 30000) });
      } catch (error) {
        return fail(502, error.message || "Website inspection failed.");
      }
    }

    // Composio connector routes. The project API key never leaves this Worker.
    if (path.startsWith("/composio/")) {
      if (!env.COMPOSIO_API_KEY) return fail(503, "Missing COMPOSIO_API_KEY Worker secret. Add it in Cloudflare > Worker > Settings > Variables and Secrets, then deploy.");
      if (!env.ACCESS_TOKEN) return fail(503, "Composio routes are locked until you add an ACCESS_TOKEN Worker secret.");
      if (request.headers.get("Authorization") !== `Bearer ${env.ACCESS_TOKEN}`) return fail(401, "Missing or invalid Worker access token.");
      const api = "https://backend.composio.dev/api/v3.1";
      const callComposio = async (endpoint, options = {}) => {
        const res = await fetch(api + endpoint, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.COMPOSIO_API_KEY,
            ...(options.headers || {}),
          },
        });
        const body = await res.text();
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body.slice(0, 300) }; }
        if (!res.ok) {
          const detail = data.message
            || (typeof data.error === "string" ? data.error : data.error ? JSON.stringify(data.error) : "")
            || data.detail
            || data.errors && JSON.stringify(data.errors)
            || body.slice(0, 500)
            || `Composio returned HTTP ${res.status}.`;
          throw new Error(`Composio HTTP ${res.status}: ${detail}`);
        }
        return data;
      };

      try {
        if (request.method === "POST" && path === "/composio/session") {
          const created = await callComposio("/tool_router/session", {
            method: "POST",
            body: JSON.stringify({
              user_id: "openclaude-primary-user",
              toolkits: { enabled: ["github"] },
              manage_connections: { enabled: true, enable_connection_removal: true },
            }),
          });
          return reply({ ok: true, sessionId: created.session_id, toolkits: created.tool_router_tools || [] });
        }

        if (request.method === "POST" && path === "/composio/connect") {
          const input = await request.json().catch(() => ({}));
          const sessionId = String(input.sessionId || "");
          const toolkit = String(input.toolkit || "github").toLowerCase();
          if (!/^trs_[a-zA-Z0-9_-]+$/.test(sessionId)) return fail(400, "A valid Composio session is required.");
          if (toolkit !== "github") return fail(400, "This first connector build currently supports GitHub only.");
          const linked = await callComposio(`/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
            method: "POST",
            body: JSON.stringify({ toolkit, callback_url: "https://sharonmathew023-blip.github.io/ultron/" }),
          });
          return reply({ ok: true, redirectUrl: linked.redirect_url, connectedAccountId: linked.connected_account_id });
        }

        if (request.method === "GET" && path === "/composio/status") {
          const sessionId = String(url.searchParams.get("sessionId") || "");
          if (!/^trs_[a-zA-Z0-9_-]+$/.test(sessionId)) return fail(400, "A valid Composio session is required.");
          const status = await callComposio(`/tool_router/session/${encodeURIComponent(sessionId)}/toolkits`);
          return reply({ ok: true, data: status });
        }
        return fail(404, "Unknown Composio route.");
      } catch (error) {
        return fail(502, error.message || "Composio request failed.");
      }
    }

    if (request.method === "GET" && (path === "" || path === "/health")) {
      return reply({ ok: true, hasKey: Boolean(env.GEMINI_API_KEY), message: "OpenClaude Gemini proxy is running. Use POST /chat/completions." });
    }

    if (request.method === "GET" && path.endsWith("/models")) {
      let ids = buildModelChain(String(env.DEFAULT_MODEL || DEFAULT_MODEL), env);
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
    // Public chat endpoint: require a verified Google Identity Services ID token.
    // The token is checked server-side; frontend-only login is never trusted.
    const authHeader = request.headers.get("Authorization") || "";
    const googleToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!googleToken) return fail(401, "Sign in with Google to use ULTRON.");
    let googleIdentity;
    try {
      googleIdentity = await verifyGoogleIdToken(googleToken, env.GOOGLE_CLIENT_ID);
    } catch {
      return fail(503, "Google sign-in verification is temporarily unavailable. Please try again.");
    }
    if (!googleIdentity) return fail(401, "Invalid or expired Google sign-in. Please sign in again.");

    // Per-Google-account and per-IP limits. Cloudflare's native counters are
    // approximate and regional; keep limits conservative to protect the Gemini quota.
    if (!env.ULTRON_USER_LIMITER || !env.ULTRON_IP_LIMITER) {
      return fail(503, "Rate limiting is not configured on this Worker yet.");
    }
    const userLimit = await env.ULTRON_USER_LIMITER.limit({ key: String(googleIdentity.sub) });
    if (!userLimit.success) return fail(429, "You've reached the ULTRON message limit. Wait a minute and try again.", { "Retry-After": "60" });
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipLimit = await env.ULTRON_IP_LIMITER.limit({ key: clientIp });
    if (!ipLimit.success) return fail(429, "Too many messages from this network. Wait a minute and try again.", { "Retry-After": "60" });

    // Keep GEMINI_API_KEY server-side.
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

    if (input.enableTools === true) {
      if (!env.ACCESS_TOKEN || request.headers.get("X-ULTRON-Admin-Token") !== env.ACCESS_TOKEN) {
        return fail(403, "Connected app tools are restricted to the ULTRON owner.");
      }
      try {
        const agentReply = await runComposioToolAgent(input, model, env);
        return new Response(toStaticOpenAIStream(agentReply.text, agentReply.model), {
          headers: { ...cors.headers, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
        });
      } catch (error) {
        return fail(502, error.message || "Connected tool execution failed.");
      }
    }

    const result = await callGemini(buildModelChain(model, env), JSON.stringify(geminiBody), env.GEMINI_API_KEY);
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


/* ---------- skill tool execution ---------- */
async function runComposioToolAgent(input, requestedModel, env) {
  const sessionId = String(input.composioSessionId || "");
  const hasSession = Boolean(sessionId);
  if (hasSession && !/^trs_[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid Composio session. Reconnect GitHub in Settings.");
  if (hasSession && !env.COMPOSIO_API_KEY) throw new Error("Add a valid COMPOSIO_API_KEY in Cloudflare Worker secrets to enable connected apps.");
  const apiBase = "https://backend.composio.dev/api/v3.1";
  const composioCall = async (path, options = {}) => {
    const response = await fetch(apiBase + path, { ...options, headers: { "Content-Type": "application/json", "x-api-key": env.COMPOSIO_API_KEY, ...(options.headers || {}) }, signal: AbortSignal.timeout(20000) });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 400) }; }
    if (!response.ok) throw new Error(data.message || data.error?.message || data.detail || `Composio returned HTTP ${response.status}.`);
    return data;
  };
  const available = [];
  if (hasSession) {
    let cursor = "";
    for (let page = 0; page < 4; page++) {
      const query = cursor ? `?limit=500&cursor=${encodeURIComponent(cursor)}` : "?limit=500";
      const result = await composioCall(`/tool_router/session/${encodeURIComponent(sessionId)}/tools${query}`);
      available.push(...(Array.isArray(result.items) ? result.items : []));
      cursor = result.next_cursor || "";
      if (!cursor) break;
    }
  }
  // Only GitHub read actions are exposed. Writes stay disabled until an approval UI exists.
  const readOnly = available.filter(tool => tool && tool.toolkit?.slug === "github" &&
    /(?:^|_)(?:GET|LIST|SEARCH|FETCH|READ|FIND|VIEW|CHECK|LOOKUP|DOWNLOAD|DESCRIBE|INSPECT)(?:_|$)/i.test(tool.slug || "") && !tool.is_deprecated
  ).slice(0, 80);
  const declarations = readOnly.map(tool => ({
    name: tool.slug,
    description: String(tool.description || tool.human_description || tool.name || tool.slug).slice(0, 900),
    parameters: composioInputSchema(tool.input_parameters || {}),
  }));
  declarations.push({
    name: "OPEN_PUBLIC_WEBPAGE",
    description: "Read text from a public HTTPS webpage. Does not run JavaScript, click, sign in, or interact with the page.",
    parameters: { type: "OBJECT", properties: { url: { type: "STRING", description: "Public HTTPS URL" } }, required: ["url"] },
  });
  const body = buildGeminiBody(input);
  if (!body.contents.length) throw new Error("No user or assistant messages were provided.");
  body.tools = [{ functionDeclarations: declarations }];
  const chain = buildModelChain(requestedModel, env);
  let model = chain[0], finalText = "";
  for (let round = 0; round < 5; round++) {
    const generated = await callGeminiJson(chain, body, env.GEMINI_API_KEY);
    if (generated.error) throw new Error(generated.error.message);
    model = generated.model;
    const candidate = generated.data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const calls = parts.filter(part => part?.functionCall);
    if (!calls.length) { finalText = parts.map(part => part.text || "").join(""); break; }
    body.contents.push(candidate.content);
    for (const part of calls) {
      const call = part.functionCall, name = String(call.name || "");
      const args = call.args && typeof call.args === "object" ? call.args : {};
      let result;
      try {
        if (name === "OPEN_PUBLIC_WEBPAGE") result = await readPublicPageForAgent(String(args.url || ""));
        else {
          if (!readOnly.some(tool => tool.slug === name)) throw new Error("Tool not enabled. Only connected GitHub read actions are currently allowed.");
          result = await composioCall(`/tool_router/session/${encodeURIComponent(sessionId)}/execute`, { method: "POST", body: JSON.stringify({ tool_slug: name, arguments: args }) });
        }
      } catch (error) { result = { error: error.message || "Tool execution failed." }; }
      body.contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result: JSON.stringify(result).slice(0, 18000) } } }] });
    }
  }
  if (!finalText) {
    const last = await callGeminiJson(chain, { ...body, tools: undefined }, env.GEMINI_API_KEY);
    if (last.error) throw new Error(last.error.message);
    model = last.model;
    finalText = (last.data.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("");
  }
  if (!finalText.trim()) throw new Error("The model completed tool calls but returned no final text.");
  return { text: finalText, model };
}
function composioInputSchema(inputParameters) {
  const properties = {}, required = [];
  for (const [key, value] of Object.entries(inputParameters || {})) {
    if (!value || typeof value !== "object") continue;
    const rawType = String(value.type || "string").toLowerCase();
    const type = ({ string:"STRING", number:"NUMBER", integer:"INTEGER", boolean:"BOOLEAN", array:"ARRAY", object:"OBJECT" })[rawType] || "STRING";
    const property = { type };
    if (value.description) property.description = String(value.description).slice(0, 500);
    if (Array.isArray(value.enum)) property.enum = value.enum;
    if (type === "ARRAY") property.items = value.items || { type:"STRING" };
    if (type === "OBJECT") property.properties = value.properties || {};
    properties[key] = property;
    if (value.required === true) required.push(key);
  }
  return { type:"OBJECT", properties, ...(required.length ? { required } : {}) };
}
async function callGeminiJson(chain, body, apiKey) {
  let last = { status:502, message:"Could not reach Gemini." };
  for (const model of chain) {
    try {
      const response = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method:"POST", headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
        body:JSON.stringify(body), signal:AbortSignal.timeout(45000),
      });
      const raw = await response.text(); let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}
      if (response.ok) return { data, model };
      last = { status:response.status, message:extractMessage(raw) || `Gemini returned HTTP ${response.status}.` };
      if (![404,429,500,502,503,504].includes(response.status)) break;
    } catch (error) { last = { status:502, message:error.message || "Could not reach Gemini." }; }
  }
  return { error:last };
}
async function readPublicPageForAgent(value) {
  let target;
  try { target = new URL(value); } catch { throw new Error("Enter a valid URL."); }
  if (target.protocol !== "https:" || !isPublicWebHost(target.hostname)) throw new Error("Only public HTTPS websites can be opened.");
  let response;
  for (let hop=0; hop<4; hop++) {
    response = await fetch(target.toString(), { redirect:"manual", headers:{"User-Agent":"OpenClaude-PageReader/1.0","Accept":"text/html,text/plain;q=0.9"}, signal:AbortSignal.timeout(12000) });
    if (![301,302,303,307,308].includes(response.status)) break;
    const location=response.headers.get("Location"); if(!location) break;
    target=new URL(location,target);
    if(target.protocol!=="https:" || !isPublicWebHost(target.hostname)) throw new Error("The website redirected to a blocked address.");
  }
  if(!response || !response.ok) throw new Error("Could not open that website.");
  const type=response.headers.get("Content-Type") || "";
  if(!/(text\/html|text\/plain)/i.test(type)) throw new Error("That URL did not return an HTML or text page.");
  const source=await response.text(); if(source.length>2000000) throw new Error("That page is too large to inspect.");
  const page=extractPageText(source,type);
  return { url:target.toString(), title:page.title, content:page.content.slice(0,14000) };
}
function toStaticOpenAIStream(text, model) {
  const encoder=new TextEncoder(), id="chatcmpl-"+crypto.randomUUID(), created=Math.floor(Date.now()/1000);
  const frames=[
    {id,object:"chat.completion.chunk",created,model,choices:[{index:0,delta:{role:"assistant",content:text},finish_reason:null}]},
    {id,object:"chat.completion.chunk",created,model,choices:[{index:0,delta:{},finish_reason:"stop"}]},
  ];
  const body=frames.map(frame=>"data: "+JSON.stringify(frame)+"\n\n").join("")+"data: [DONE]\n\n";
  return new ReadableStream({start(controller){controller.enqueue(encoder.encode(body));controller.close();}});
}

function isPublicWebHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) return false;
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) return false;
  return true;
}

function extractPageText(source, contentType) {
  if (/text\/plain/i.test(contentType)) return { title: "Text page", content: source.replace(/\s+/g, " ").trim(), html: "" };
  const title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,""])[1]
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const content = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const html = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "")
    .slice(0, 30000);
  return { title: title || "Website", content, html };
}

/* ---------- request translation ---------- */

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  return content == null ? "" : String(content);
}

function partsOf(content) {
  if (!Array.isArray(content)) return [{ text: textOf(content) }];
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") parts.push({ text: item.text });
    if (item.type === "image_url" && item.image_url && typeof item.image_url.url === "string") {
      const match = item.image_url.url.match(/^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error("An attachment could not be decoded. Reattach the file and try again.");
      if (!(/^(image\/[\w.+-]+|application\/pdf)$/.test(match[1]))) throw new Error("Unsupported attachment type: " + match[1]);
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }
  return parts.length ? parts : [{ text: "" }];
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
    const parts = partsOf(m.content);
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      if (last.parts.length && parts.length && last.parts[last.parts.length - 1].text && parts[0].text) {
        last.parts[last.parts.length - 1].text += "\n\n" + parts.shift().text;
      }
      last.parts.push(...parts);
    } else contents.push({ role, parts });
  }
  while (contents.length && contents[0].role !== "user") contents.shift();

  const body = { contents };
  // Gemini built-in Google Search grounding is opt-in per request.
  if (input.web_search === true) body.tools = [{ google_search: {} }];
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  const cfg = {};
  if (typeof input.temperature === "number") cfg.temperature = input.temperature;
  if (typeof input.top_p === "number") cfg.topP = input.top_p;
  if (Number.isInteger(input.max_tokens) && input.max_tokens > 0) cfg.maxOutputTokens = input.max_tokens;
  if (Object.keys(cfg).length) body.generationConfig = cfg;
  return body;
}

/* ---------- model chain ---------- */

// The requested model first, then the backups. Duplicates and bad names are dropped,
// so one saturated model can no longer take the whole app down.
function buildModelChain(requested, env) {
  const chain = [];
  const add = (value) => {
    const name = String(value || "").trim().replace(/^models\//, "");
    if (name && MODEL_RE.test(name) && !chain.includes(name)) chain.push(name);
  };
  add(requested);
  add(env.FALLBACK_MODEL);
  for (const name of String(env.FALLBACK_MODELS || DEFAULT_FALLBACKS).split(",")) add(name);
  return chain;
}

/* ---------- Gemini call with retries and model fallback ---------- */

// One attempt against one model. Resolves to { res, model } or a plain error record.
async function callModel(model, body, apiKey) {
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
    return {
      status: res.status,
      message: extractMessage(text) || `Gemini API returned HTTP ${res.status}.`,
      retryAfter: res.headers.get("Retry-After") || undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    return err && err.name === "AbortError"
      ? { status: 504, message: "Gemini did not respond in time.", timedOut: true }
      : { status: 502, message: "Could not reach the Gemini API." };
  }
}

async function callGemini(chain, body, apiKey) {
  const started = Date.now();
  const tried = [];
  let last = { status: 502, message: "Could not reach the Gemini API." };

  for (const model of chain) {
    tried.push(model);
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() - started > TOTAL_BUDGET_MS) return { error: busyError(tried, last) };

      const outcome = await callModel(model, body, apiKey);
      if (outcome.res) return outcome; // this model answered
      last = outcome;

      // A bad key or a bad request will not be fixed by trying another model.
      if (!RETRY_STATUS.has(outcome.status) && outcome.status !== MODEL_GONE_STATUS) return { error: outcome };
      // A retired model or one that just stalled will not improve on a second try.
      if (outcome.status === MODEL_GONE_STATUS || outcome.timedOut) break;
      // Each model has its own quota, so a rate limit is better spent on the next model.
      if (outcome.status === 429) break;

      if (attempt < ATTEMPTS_PER_MODEL) {
        const ra = Number(outcome.retryAfter);
        await sleep(ra > 0 && ra <= 2 ? ra * 1000 : 350 * attempt + Math.random() * 250);
      }
    }
  }
  return { error: busyError(tried, last) };
}

// Every model in the chain is busy: say that once, instead of echoing one model's error.
function busyError(tried, last) {
  const status = last && last.status === 429 ? 429 : last && last.status === 504 ? 504 : 503;
  const reason = (last && last.message) || "The model is busy.";
  return {
    status,
    message: `Google's models are busy right now, so this Worker could not get an answer (tried ${tried.join(", ")}). Last error: ${reason} Please try again in a moment.`,
    retryAfter: (last && last.retryAfter) || "10",
  };
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
  const groundingSources = new Map();

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
    const chunks = cand.groundingMetadata && cand.groundingMetadata.groundingChunks;
    if (Array.isArray(chunks)) {
      for (const item of chunks) {
        const web = item && item.web;
        const uri = String(web && web.uri || "");
        if (uri.startsWith("https://")) groundingSources.set(uri, String(web.title || new URL(uri).hostname).slice(0, 180));
      }
    }
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
      if (!errored && groundingSources.size) {
        const sourceList = [...groundingSources.entries()].slice(0, 8)
          .map(([url, title]) => `- [${title.replace(/[\[\]\r\n]/g, " ")}](${url})`).join("\n");
        ctl.enqueue(chunk({ content: `\n\n**Sources**\n${sourceList}` }));
      }
      if (!errored) ctl.enqueue(chunk({}, finish === "MAX_TOKENS" ? "length" : /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/i.test(finish) ? "content_filter" : "stop"));
      ctl.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  }));
}

/* ---------- Google ID token verification ---------- */
let googleJwksCache = null;
let googleJwksExpiresAt = 0;

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function getGoogleJwks(forceRefresh = false) {
  if (!forceRefresh && googleJwksCache && Date.now() < googleJwksExpiresAt) return googleJwksCache;
  const discoveryResponse = await fetch("https://accounts.google.com/.well-known/openid-configuration", { signal: AbortSignal.timeout(7000) });
  if (!discoveryResponse.ok) throw new Error("Google OpenID discovery unavailable");
  const discovery = await discoveryResponse.json();
  if (!String(discovery.jwks_uri || "").startsWith("https://www.googleapis.com/")) throw new Error("Unexpected Google JWKS URL");
  const keysResponse = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(7000) });
  if (!keysResponse.ok) throw new Error("Google signing keys unavailable");
  const data = await keysResponse.json();
  if (!Array.isArray(data.keys) || !data.keys.length) throw new Error("Google signing keys missing");
  const cacheControl = keysResponse.headers.get("Cache-Control") || "";
  const maxAge = Number((cacheControl.match(/max-age=(\d+)/i) || [])[1] || 3600);
  googleJwksCache = data.keys;
  googleJwksExpiresAt = Date.now() + Math.max(60, Math.min(maxAge, 86400)) * 1000;
  return googleJwksCache;
}

async function verifyGoogleIdToken(token, clientId) {
  if (!clientId || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;
  let keys = await getGoogleJwks();
  let jwk = keys.find(key => key.kid === header.kid && key.alg === "RS256" && key.use === "sig");
  if (!jwk) {
    keys = await getGoogleJwks(true);
    jwk = keys.find(key => key.kid === header.kid && key.alg === "RS256" && key.use === "sig");
  }
  if (!jwk) return null;
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signatureValid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  const now = Math.floor(Date.now() / 1000);
  const issuerValid = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const emailVerified = claims.email_verified === true || String(claims.email_verified).toLowerCase() === "true";
  if (
    !signatureValid ||
    claims.aud !== clientId ||
    (claims.azp && claims.azp !== clientId) ||
    !issuerValid ||
    !claims.sub ||
    !emailVerified ||
    !Number.isFinite(Number(claims.exp)) ||
    Number(claims.exp) <= now ||
    (claims.iat && Number(claims.iat) > now + 60)
  ) return null;
  return claims;
}

/* ---------- helpers ---------- */

function corsFor(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter((s) => s && s !== "*");
  const list = configured.length ? configured : ["https://sharonmathew023-blip.github.io"];
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-ULTRON-Admin-Token",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && list.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    return { headers, allowed: true };
  }
  return { headers, allowed: !origin }; // non-browser requests still require the bearer token on private routes
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
