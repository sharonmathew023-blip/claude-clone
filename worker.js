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

// Skill Engine 2.0 shares its parser, scanner, and tool catalog with the browser.
import "./skill-rules.js";

const DEFAULT_MODEL = "gemini-3.5-flash"; // 3.8-flash answers 503 for days at a time
const DEFAULT_FALLBACKS = "gemini-3.6-flash,gemini-flash-lite-latest";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_BODY_BYTES = 12_000_000;
const MAX_PAGE_BYTES = 2_000_000;
const MODEL_LIST_CACHE_MS = 300_000;
const MAX_MESSAGES = 200;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MODEL_GONE_STATUS = 404; // retired model: move on to the next one, do not retry it
const HEADERS_TIMEOUT_MS = 20_000; // wait for the first response headers, not for the whole stream
const ATTEMPTS_PER_MODEL = 3; // first try plus two retries, with exponential backoff between them
const MIN_ATTEMPT_MS = 2_000; // do not start an attempt with less budget than this
const BACKOFF_BASE_MS = 400; // wait ~400ms, ~800ms, ~1.6s ... (jittered) between retries of one model
const BACKOFF_MAX_MS = 3_000;
// How long a model rests after a failure. Rate limits use Google's own hint when it sends one.
const COOLDOWN_MS = { rateLimited: 60_000, overloaded: 30_000, timeout: 20_000, gone: 600_000 };
const COOLDOWN_MIN_MS = 5_000;
const COOLDOWN_MAX_MS = 600_000;
const COOLDOWN_KV_KEY = "model-cooldowns:v1";
let modelListCache = { expiresAt: 0, data: null };
const COOLDOWN_CACHE_MS = 3_000; // re-read the KV copy at most this often
const TOTAL_BUDGET_MS = 45_000; // keep the answer inside the browser's 60s request timeout
// Skills may only narrow the Worker's read-only tool access. Nothing in a
// request can widen these grants, and write tools never exist here.
const GRANTABLE_SKILL_TOOLS = new Set(["web.read", "github.read"]);
const BASELINE_SKILL_TOOLS = ["web.read", "github.read"];
const SKILL_MARKER = "<<<SKILL";
const MAX_SKILLS_PER_REQUEST = 8;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsFor(request, env);
    const reply = (data, status = 200, extra) => jsonResponse(data, status, cors.headers, extra);
    const fail = (status, message, extra) => reply(errorBody(status, message), status, extra);

    if (!cors.allowed) return fail(403, "This origin is not allowed. Add it to ALLOWED_ORIGINS.");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });

    const path = url.pathname.replace(/\/+$/, "");

    // Public-page reader used by browser-oriented custom skills.
    if (request.method === "POST" && path === "/browse") {
      const auth = await authenticateGoogleRequest(request, env);
      if (!auth.identity) return fail(auth.status, auth.message);
      if (!isUltronOwner(auth.identity, env)) return fail(env.ULTRON_OWNER_EMAIL ? 403 : 503, env.ULTRON_OWNER_EMAIL ? "Website inspection is restricted to the ULTRON owner account." : "Owner access is not configured. Add the ULTRON_OWNER_EMAIL Worker secret.");
      try {
        let input = {};
        try {
          const rawInput = await readStreamTextLimited(request.body, 16_384);
          if (rawInput) input = JSON.parse(rawInput);
        } catch (error) {
          if (error && error.code === "PAYLOAD_TOO_LARGE") return fail(413, "Website inspection request is too large.");
          return fail(400, "Website inspection request must be valid JSON.");
        }
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
        let source;
        try { source = await readStreamTextLimited(response.body, MAX_PAGE_BYTES); }
        catch (error) {
          if (error && error.code === "PAYLOAD_TOO_LARGE") return fail(413, "That page is too large to inspect.");
          throw error;
        }
        const page = extractPageText(source, type);
        return reply({ ok: true, url: target.toString(), title: page.title, content: page.content.slice(0, 18000), html: page.html.slice(0, 30000) });
      } catch (error) {
        return fail(502, error.message || "Website inspection failed.");
      }
    }

    // Composio Connect consumer MCP. The ck_* key stays server-side and is
    // sent only to connect.composio.dev using x-consumer-api-key.
    if (path.startsWith("/composio/")) {
      const auth = await authenticateGoogleRequest(request, env);
      if (!auth.identity) return fail(auth.status, auth.message);
      if (!isUltronOwner(auth.identity, env)) return fail(env.ULTRON_OWNER_EMAIL ? 403 : 503, env.ULTRON_OWNER_EMAIL ? "Connected apps are restricted to the ULTRON owner account." : "Owner access is not configured. Add the ULTRON_OWNER_EMAIL Worker secret.");
      if (!env.COMPOSIO_API_KEY) return fail(503, "Missing COMPOSIO_API_KEY Worker secret. Add your Composio Consumer API key in Cloudflare and deploy.");

      try {
        const mcp = await createComposioMcpClient(env.COMPOSIO_API_KEY);
        if (request.method === "POST" && path === "/composio/session") {
          const tools = await mcp.listTools();
          const required = ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"];
          const missing = required.filter(name => !tools.some(tool => tool.name === name));
          if (missing.length) throw new Error("Composio MCP did not expose required tools: " + missing.join(", "));
          return reply({ ok: true, sessionId: "consumer-mcp", toolkits: tools.map(tool => tool.name) });
        }

        if (request.method === "POST" && path === "/composio/connect") {
          const input = await request.json().catch(() => ({}));
          const toolkit = String(input.toolkit || "github").toLowerCase();
          if (toolkit !== "github") return fail(400, "This connector setup currently supports GitHub only.");
          const connected = await mcp.callTool("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [toolkit], reinitiate_all: false });
          const redirectUrl = findComposioField(connected, ["redirect_url", "redirectUrl"]);
          const connectedAccountId = findComposioField(connected, ["connected_account_id", "connectedAccountId"]);
          const connectionState = findComposioField(connected, ["status", "state"]);
          const isConnected = Boolean(connectedAccountId) || ["active", "connected"].includes(String(connectionState || "").toLowerCase());
          return reply({ ok: true, connected: isConnected, redirectUrl: typeof redirectUrl === "string" ? redirectUrl : null, connectedAccountId, data: connected });
        }

        if (request.method === "GET" && path === "/composio/status") {
          const toolkit = String(url.searchParams.get("toolkit") || "github").toLowerCase();
          if (toolkit !== "github") return fail(400, "This connector setup currently supports GitHub only.");
          const status = await mcp.callTool("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [toolkit], reinitiate_all: false });
          return reply({ ok: true, data: status });
        }
        return fail(404, "Unknown Composio route.");
      } catch (error) {
        return fail(502, error.message || "Composio MCP request failed.");
      }
    }

    if (request.method === "GET" && (path === "" || path === "/health")) {
      return reply({ ok: true, hasKey: Boolean(env.GEMINI_API_KEY), hasGroqKey: Boolean(env.GROQ_API_KEY), cooldownStore: env.ULTRON_STATE ? "kv" : "memory", skillEngine: "2.0.0", message: "OpenClaude AI proxy is running. Use POST /chat/completions." });
    }

    if (request.method === "GET" && path.endsWith("/models")) {
      if (modelListCache.data && modelListCache.expiresAt > Date.now()) {
        return reply(modelListCache.data, 200, { "Cache-Control": "public, max-age=300" });
      }
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
      const data = { object: "list", data: [...new Set(ids)].map((id) => ({ id, object: "model" })) };
      modelListCache = { data, expiresAt: Date.now() + MODEL_LIST_CACHE_MS };
      return reply(data, 200, { "Cache-Control": "public, max-age=300" });
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
    try { raw = await readStreamTextLimited(request.body, MAX_BODY_BYTES); }
    catch (error) {
      if (error && error.code === "PAYLOAD_TOO_LARGE") return fail(413, "Request is too large.");
      return fail(400, "Could not read the request body.");
    }
    let input;
    try { input = JSON.parse(raw); } catch { return fail(400, "Request body must be valid JSON."); }

    if (!input || !Array.isArray(input.messages) || input.messages.length === 0) {
      return fail(400, "A non-empty messages array is required.");
    }
    if (input.messages.length > MAX_MESSAGES) return fail(400, `Too many messages (max ${MAX_MESSAGES}).`);

    // Uploaded skills are untrusted instructions. Re-check every injected skill
    // block here so a stale or modified browser cannot smuggle secret access,
    // authentication overrides, or code execution into the model prompt.
    const skillAccess = readSkillManifest(input);
    const skillCheck = guardSkillPrompt(input.messages, skillAccess);
    if (!skillCheck.ok) return fail(400, skillCheck.message);

    const model = String(input.model || env.DEFAULT_MODEL || DEFAULT_MODEL).replace(/^models\//, "");
    if (!MODEL_RE.test(model)) return fail(400, "Invalid model name.");

    const geminiBody = buildGeminiBody(input);
    if (!geminiBody.contents.length) return fail(400, "No user or assistant messages were provided.");

    if (input.enableTools === true) {
      if (!isUltronOwner(googleIdentity, env)) {
        return fail(env.ULTRON_OWNER_EMAIL ? 403 : 503, env.ULTRON_OWNER_EMAIL ? "Connected app tools are restricted to the ULTRON owner account." : "Owner access is not configured. Add the ULTRON_OWNER_EMAIL Worker secret.");
      }
      try {
        const agentReply = await runComposioToolAgent(input, model, env, skillAccess, ctx);
        return new Response(toStaticOpenAIStream(agentReply.text, agentReply.model), {
          headers: { ...cors.headers, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-ULTRON-Model": agentReply.model },
        });
      } catch (error) {
        return fail(502, error.message || "Connected tool execution failed.");
      }
    }

    const chain = buildModelChain(model, env);
    const result = await callGemini(chain, JSON.stringify(geminiBody), env.GEMINI_API_KEY, makeHealth(env, ctx));
    if (result.error) {
      // Use the independent provider only for upstream availability failures.
      // callGemini normalizes exhausted regional-routing 400s into a 503 busy
      // error, so those failures also reach this provider fallback.
      if ([429, 500, 502, 503, 504].includes(Number(result.error.status))) {
        if (!env.GROQ_API_KEY) {
          console.error("[ultron] Gemini is unavailable and GROQ_API_KEY is not configured.");
          return fail(503, "Gemini is unavailable and the Groq backup is not configured on this Worker. Add GROQ_API_KEY under the Production environment's Variables and Secrets, then redeploy.");
        }
        const backup = await callGroqFallback(input, env);
        if (backup.res) {
          return new Response(backup.res.body, {
            headers: {
              ...cors.headers,
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-ULTRON-Model": "groq/" + backup.model,
              "X-ULTRON-Fallback": "provider",
            },
          });
        }
        const backupMessage = redact(backup.message || "unknown error").slice(0, 240);
        console.warn("[ultron] Groq backup failed: " + backupMessage);
        return fail(502, "Gemini is unavailable and the Groq backup failed: " + backupMessage);
      }
      const extra = result.error.retryAfter ? { "Retry-After": result.error.retryAfter } : undefined;
      return fail(result.error.status, result.error.message, extra);
    }

    return new Response(toOpenAIStream(result.res.body, result.model), {
      headers: {
        ...cors.headers,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-ULTRON-Model": result.model,
        "X-ULTRON-Fallback": result.model === chain[0] ? "false" : "true",
      },
    });
  },
};


/* ---------- skill manifest and prompt guard ---------- */
// A skill manifest is metadata only: names plus approved tool ids. It can
// narrow the read-only tools a request may use, never add capabilities.
function readSkillManifest(input) {
  const list = Array.isArray(input.skills) ? input.skills.slice(0, MAX_SKILLS_PER_REQUEST) : null;
  if (!list) return { present: false, tools: BASELINE_SKILL_TOOLS.slice(), names: [] };
  const tools = new Set();
  const names = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const name = String(entry.name || "").slice(0, 80);
    if (name) names.push(name);
    const requested = Array.isArray(entry.tools) ? entry.tools.slice(0, 4) : [];
    for (const tool of requested) {
      if (typeof tool === "string" && GRANTABLE_SKILL_TOOLS.has(tool)) tools.add(tool);
    }
  }
  return { present: true, tools: [...tools], names };
}

function guardSkillPrompt(messages, manifest) {
  const declaredSkills = Boolean(manifest && manifest.present && manifest.names.length);
  let blocks = 0;
  for (const message of messages) {
    if (!message || message.role !== "system" || typeof message.content !== "string") continue;
    const hasMarker = message.content.includes(SKILL_MARKER);
    if (!hasMarker && !declaredSkills) continue;
    if (message.content.length > 400_000) return { ok: false, message: "Skill context is too large." };

    if (hasMarker) {
      blocks += message.content.split(SKILL_MARKER).length - 1;
      if (blocks > MAX_SKILLS_PER_REQUEST) return { ok: false, message: `Too many skills in one request (max ${MAX_SKILLS_PER_REQUEST}).` };
    }

    const api = globalThis.ULTRONSkillRules;
    if (!api || typeof api.scanSkill !== "function") {
      return { ok: false, message: "Skill validation is unavailable on this Worker. Redeploy worker.js with skill-rules.js." };
    }

    // Scan everything from the first marker to the end of the system message.
    // A skill that injects a fake closing marker cannot hide later text this way.
    const from = hasMarker ? message.content.indexOf(SKILL_MARKER) : 0;
    const scan = api.scanSkill(message.content.slice(from));
    if (scan.blocked) {
      const first = (scan.findings || []).find(finding => finding.severity === "block");
      return { ok: false, message: "A skill was blocked: " + (first ? first.message : "it failed the security check.") };
    }
  }
  return { ok: true, blocks };
}

/* ---------- skill tool execution ---------- */
async function createComposioMcpClient(apiKey) {
  const endpoint = "https://connect.composio.dev/mcp";
  const state = { sessionId: "", requestId: 0 };
  const send = async (method, params, notification = false) => {
    const payload = { jsonrpc: "2.0", ...(notification ? {} : { id: ++state.requestId }), method, ...(params === undefined ? {} : { params }) };
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-consumer-api-key": apiKey,
      "MCP-Protocol-Version": "2025-03-26",
      ...(state.sessionId ? { "MCP-Session-Id": state.sessionId } : {}),
    };
    const response = await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
    });
    const returnedSession = response.headers.get("MCP-Session-Id");
    if (returnedSession) state.sessionId = returnedSession;
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 500);
      try { const parsed = JSON.parse(raw); detail = parsed.message || parsed.error?.message || detail; } catch {}
      throw new Error("Composio MCP HTTP " + response.status + ": " + detail);
    }
    if (notification || response.status === 202 || !raw.trim()) return {};
    let message;
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("text/event-stream")) {
      const frames = [...raw.matchAll(/^data:\s*(.+)$/gm)].map(match => match[1].trim()).filter(Boolean);
      for (let i = frames.length - 1; i >= 0; i--) {
        try { message = JSON.parse(frames[i]); break; } catch {}
      }
    } else {
      try { message = JSON.parse(raw); } catch { throw new Error("Composio MCP returned an unreadable response."); }
    }
    if (!message) throw new Error("Composio MCP returned no JSON-RPC response.");
    if (message.error) throw new Error(message.error.message || "Composio MCP request failed.");
    return message.result || {};
  };

  await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "ULTRON", version: "1.0.0" },
  });
  await send("notifications/initialized", undefined, true);
  return {
    request: send,
    async listTools() {
      const tools = [];
      let cursor = "";
      for (let page = 0; page < 8; page++) {
        const result = await send("tools/list", cursor ? { cursor } : {});
        tools.push(...(Array.isArray(result.tools) ? result.tools : []));
        cursor = result.nextCursor || "";
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name, args) {
      const result = await send("tools/call", { name, arguments: args || {} });
      if (result.isError) {
        const detail = (result.content || []).map(item => item.text || "").join("\n");
        throw new Error(detail || "Composio tool " + name + " failed.");
      }
      if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
      const text = (result.content || []).filter(item => item && item.type === "text").map(item => item.text || "").join("\n");
      if (text) {
        try { return JSON.parse(text); } catch { return { text }; }
      }
      return result;
    },
  };
}

function findComposioField(value, names, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return null;
  for (const name of names) {
    if (typeof value[name] === "string" && value[name]) return value[name];
  }
  for (const child of Object.values(value)) {
    const found = findComposioField(child, names, depth + 1);
    if (found) return found;
  }
  if (typeof value.text === "string" && depth < 3) {
    try { return findComposioField(JSON.parse(value.text), names, depth + 1); } catch {}
  }
  return null;
}

function composioMcpSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 6) return { type: "STRING" };
  const rawType = Array.isArray(schema.type) ? schema.type.find(type => type !== "null") : schema.type;
  const type = String(rawType || (schema.properties ? "object" : "string")).toUpperCase();
  const mapped = ["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"].includes(type) ? type : "STRING";
  const output = { type: mapped };
  if (schema.description) output.description = String(schema.description).slice(0, 500);
  if (Array.isArray(schema.enum)) output.enum = schema.enum;
  if (mapped === "OBJECT") {
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties || {})) properties[key] = composioMcpSchema(value, depth + 1);
    output.properties = properties;
    if (Array.isArray(schema.required) && schema.required.length) output.required = schema.required;
  }
  if (mapped === "ARRAY") output.items = composioMcpSchema(schema.items || { type: "string" }, depth + 1);
  return output;
}

async function runComposioToolAgent(input, requestedModel, env, skillAccess, ctx) {
  const hasComposio = Boolean(input.composioSessionId);
  const allowedTools = skillAccess && skillAccess.present
    ? new Set(skillAccess.tools)
    : new Set(BASELINE_SKILL_TOOLS);
  if (!allowedTools.has("github.read") && !allowedTools.has("web.read")) throw new Error("The active skills do not grant any supported tools.");
  if (hasComposio && !env.COMPOSIO_API_KEY) throw new Error("Add the Composio Consumer API key as COMPOSIO_API_KEY in Cloudflare Worker secrets.");
  if (!hasComposio && allowedTools.has("github.read") && !allowedTools.has("web.read")) throw new Error("Connect GitHub in Settings before using GitHub tools.");

  const mcp = hasComposio ? await createComposioMcpClient(env.COMPOSIO_API_KEY) : null;
  const available = mcp ? await mcp.listTools() : [];
  const safeMetaTools = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL"]);
  const declarations = available
    .filter(tool => tool && safeMetaTools.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: String(tool.description || tool.name).slice(0, 900),
      parameters: composioMcpSchema(tool.inputSchema || { type: "object", properties: {} }),
    }));
  if (allowedTools.has("web.read")) {
    declarations.push({
      name: "OPEN_PUBLIC_WEBPAGE",
      description: "Read text from a public HTTPS webpage. Does not run JavaScript, click, sign in, or interact with the page.",
      parameters: { type: "OBJECT", properties: { url: { type: "STRING", description: "Public HTTPS URL" } }, required: ["url"] },
    });
  }
  if (!declarations.length) throw new Error("Composio Connect did not expose its tool discovery actions.");

  const body = buildGeminiBody(input);
  if (!body.contents.length) throw new Error("No user or assistant messages were provided.");
  const safetyNote = "Connected-app safety rules: use Composio only to discover and read GitHub repository information. Search only for GitHub read tools. Never execute writes, mutations, issue creation, commits, file updates, pull-request changes, or actions for any other app. COMPOSIO_MULTI_EXECUTE_TOOL is allowed only when every requested tool_slug is a GitHub read action (GET, LIST, SEARCH, FETCH, READ, FIND, VIEW, CHECK, LOOKUP, DOWNLOAD, DESCRIBE, or INSPECT).";
  if (body.systemInstruction?.parts) body.systemInstruction.parts.push({ text: safetyNote });
  else body.systemInstruction = { parts: [{ text: safetyNote }] };
  body.tools = [{ functionDeclarations: declarations }];

  const chain = buildModelChain(requestedModel, env);
  const health = makeHealth(env, ctx);
  let model = chain[0], finalText = "", searchSessionId = "";
  for (let round = 0; round < 5; round++) {
    const generated = await callGeminiJson(chain, body, env.GEMINI_API_KEY, health);
    if (generated.error) throw new Error(generated.error.message);
    model = generated.model;
    const candidate = generated.data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const calls = parts.filter(part => part?.functionCall);
    if (!calls.length) { finalText = parts.map(part => part.text || "").join(""); break; }
    body.contents.push(candidate.content);
    for (const part of calls) {
      const call = part.functionCall, name = String(call.name || "");
      const args = call.args && typeof call.args === "object" ? { ...call.args } : {};
      let result;
      try {
        if (name === "OPEN_PUBLIC_WEBPAGE") {
          if (!allowedTools.has("web.read")) throw new Error("web.read is not granted to the active skills.");
          result = await readPublicPageForAgent(String(args.url || ""));
        } else {
          if (!safeMetaTools.has(name)) throw new Error("This Composio action is not enabled in ULTRON.");
          if (!mcp) throw new Error("Connect GitHub in Settings before using Composio tools.");
          if (name === "COMPOSIO_SEARCH_TOOLS") {
            const queries = Array.isArray(args.queries) ? args.queries : [];
            args.queries = queries.map(query => ({
              ...query,
              use_case: "Search GitHub for read-only repository information: " + String(query.use_case || "repository details").slice(0, 700),
            }));
            args.session = searchSessionId ? { id: searchSessionId } : { generate_id: true };
          }
          if (name === "COMPOSIO_GET_TOOL_SCHEMAS" || name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
            if (searchSessionId) args.session_id = searchSessionId;
          }
          if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
            if (!Array.isArray(args.tools) || !args.tools.length) throw new Error("No GitHub read tools were supplied.");
            const readOnlyPattern = /^GITHUB_(?:GET|LIST|SEARCH|FETCH|READ|FIND|VIEW|CHECK|LOOKUP|DOWNLOAD|DESCRIBE|INSPECT)(?:_|$)/i;
            for (const item of args.tools) {
              if (!item || !readOnlyPattern.test(String(item.tool_slug || ""))) {
                throw new Error("ULTRON currently permits GitHub read-only tools only. This requested action was blocked.");
              }
            }
          }
          result = await mcp.callTool(name, args);
          if (name === "COMPOSIO_SEARCH_TOOLS") {
            searchSessionId = findComposioField(result, ["session_id", "sessionId"]) || searchSessionId;
          }
        }
      } catch (error) { result = { error: error.message || "Tool execution failed." }; }
      body.contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result: JSON.stringify(result).slice(0, 18000) } } }] });
    }
  }
  if (!finalText) {
    const last = await callGeminiJson(chain, { ...body, tools: undefined }, env.GEMINI_API_KEY, health);
    if (last.error) throw new Error(last.error.message);
    model = last.model;
    finalText = (last.data.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("");
  }
  if (!finalText.trim()) throw new Error("The model completed tool calls but returned no final text.");
  return { text: finalText, model };
}
async function callGeminiJson(chain, body, apiKey, health) {
  let last = { status: 502, message: "Could not reach Gemini." };
  await health.load();
  for (const model of health.order(chain)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
        });
        const raw = await response.text(); let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        if (response.ok) { await health.clear(model); return { data, model }; }
        const hint = retryHintMs(response.headers.get("Retry-After"), raw);
        last = { status: response.status, message: extractMessage(raw) || `Gemini returned HTTP ${response.status}.` };
        if (isKeyProblem(response.status, raw)) { console.error(`[ultron] Gemini rejected the API key (HTTP ${response.status}).`); return { error: keyError() }; }
        if (response.status === 429) { await health.mark(model, hint || COOLDOWN_MS.rateLimited, "rate-limited"); break; }
        if (response.status === MODEL_GONE_STATUS) { await health.mark(model, COOLDOWN_MS.gone, "not-found"); break; }
        if (!RETRY_STATUS.has(response.status)) return { error: last };
        if (attempt < 2) await sleep(backoffDelay(attempt, hint)); else await health.mark(model, COOLDOWN_MS.overloaded, "overloaded");
      } catch (error) {
        const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
        last = { status: timedOut ? 504 : 502, message: timedOut ? "Gemini did not respond in time." : "Could not reach Gemini." };
        await health.mark(model, timedOut ? COOLDOWN_MS.timeout : COOLDOWN_MS.overloaded, timedOut ? "timeout" : "unreachable");
        break;
      }
    }
  }
  return { error: last };
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
  let source;
  try { source=await readStreamTextLimited(response.body,MAX_PAGE_BYTES); }
  catch(error) { if(error && error.code==="PAYLOAD_TOO_LARGE") throw new Error("That page is too large to inspect."); throw error; }
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

async function readStreamTextLimited(stream, maxBytes) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        const error = new Error("Response exceeded the allowed size.");
        error.code = "PAYLOAD_TOO_LARGE";
        try { await reader.cancel(error); } catch {}
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
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

/* ---------- per-model cooldown ---------- */

// A model that just failed rests at the back of the line instead of being hit again.
// Memory is per Worker isolate. Bind a KV namespace named ULTRON_STATE and the same
// map is also saved there, so it survives restarts and is shared across locations.
// Without that binding everything still works, with memory only.
const memCooldowns = new Map(); // model -> epoch ms when it may be tried again
let kvCooldownCache = { at: 0, map: {} };

function makeHealth(env, ctx) {
  const kv = env && env.ULTRON_STATE && typeof env.ULTRON_STATE.get === "function" ? env.ULTRON_STATE : null;

  async function save() {
    if (!kv) return;
    const now = Date.now();
    const map = {};
    for (const [name, until] of memCooldowns) if (until > now) map[name] = until;
    kvCooldownCache = { at: now, map };
    const job = Promise.resolve()
      .then(() => kv.put(COOLDOWN_KV_KEY, JSON.stringify(map), { expirationTtl: 3600 }))
      .catch(() => {}); // a failed save only costs persistence, never the chat
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job); else await job;
  }

  return {
    persistent: Boolean(kv),
    async load() {
      if (!kv || Date.now() - kvCooldownCache.at < COOLDOWN_CACHE_MS) return;
      try {
        const stored = await kv.get(COOLDOWN_KV_KEY, "json");
        kvCooldownCache = { at: Date.now(), map: stored && typeof stored === "object" ? stored : {} };
        for (const [name, until] of Object.entries(kvCooldownCache.map)) {
          if (Number(until) > (memCooldowns.get(name) || 0)) memCooldowns.set(name, Number(until));
        }
      } catch {
        kvCooldownCache = { at: Date.now(), map: kvCooldownCache.map };
      }
    },
    // Same order as the chain, except models that are resting go last (soonest to wake first).
    // Resting models are still tried as a last resort, so a cooldown never causes an outage.
    order(chain) {
      const now = Date.now();
      const ready = [], resting = [];
      for (const name of chain) ((memCooldowns.get(name) || 0) > now ? resting : ready).push(name);
      resting.sort((a, b) => memCooldowns.get(a) - memCooldowns.get(b));
      return [...ready, ...resting];
    },
    isResting(model) { return (memCooldowns.get(model) || 0) > Date.now(); },
    async mark(model, ms, reason) {
      const wait = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Number(ms) || COOLDOWN_MS.overloaded));
      memCooldowns.set(model, Date.now() + wait);
      console.warn(`[ultron] ${model} resting ${Math.round(wait / 1000)}s (${reason})`);
      await save();
    },
    async clear(model) { if (memCooldowns.delete(model)) await save(); },
  };
}

/* ---------- errors, hints and backoff ---------- */

// Strip anything that looks like a credential before text can reach a client or a log.
function redact(text) {
  return String(text == null ? "" : text)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',]+/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{12,}/gi, "$1[redacted]")
    .replace(/\bck_[A-Za-z0-9_-]{10,}/g, "[redacted]");
}

// How long Google asked us to wait, in ms: the Retry-After header or the retryDelay hint in the error body.
function retryHintMs(headerValue, text) {
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text || "");
  return m ? Number(m[1]) * 1000 : 0;
}

// A rejected key is a setup problem. No other model can fix it, and the details stay out of the response.
function isKeyProblem(status, text) {
  if (status === 401 || status === 403) return true;
  return status === 400 && /API_KEY_INVALID|API key not valid|API key expired|invalid api key/i.test(text || "");
}

function keyError() {
  return {
    status: 503,
    message: "ULTRON's AI service rejected the server's API key. This is a setup problem on the server, not on your side. The site owner needs to check the GEMINI_API_KEY secret.",
    keyProblem: true,
  };
}

// Exponential backoff with jitter: ~400ms, ~800ms, ~1.6s ... capped. Google's own hint wins when it is short.
function backoffDelay(attempt, hintMs) {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
  return hintMs > 0 && hintMs <= BACKOFF_MAX_MS ? Math.max(jittered, hintMs) : jittered;
}

/* ---------- Gemini call with retries, backoff, cooldowns and model fallback ---------- */

// Reads up to the first complete SSE event, so an error frame sent inside a 200 response
// still triggers a retry or a fallback before any text reaches the browser.
async function primeStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const held = [];
  let text = "";
  try {
    while (!/\r?\n\r?\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      held.push(value);
      text += dec.decode(value, { stream: true });
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  let first = null;
  for (const line of text.split(/\r?\n\r?\n/)[0].split(/\r?\n/)) {
    if (line.startsWith("data:")) { try { first = JSON.parse(line.slice(5).trim()); } catch {} }
  }
  if (first && first.error) {
    reader.cancel().catch(() => {});
    const status = Number(first.error.code) || 502;
    const raw = JSON.stringify(first.error);
    return {
      failure: {
        status,
        message: redact(first.error.message || "Gemini reported an error.").slice(0, 300),
        retryAfterMs: retryHintMs(null, raw),
        keyProblem: isKeyProblem(status, raw),
      },
    };
  }
  const body = new ReadableStream({
    start(ctl) { for (const chunk of held) ctl.enqueue(chunk); },
    async pull(ctl) {
      try {
        const { value, done } = await reader.read();
        if (done) ctl.close(); else ctl.enqueue(value);
      } catch (err) { ctl.error(err); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { body };
}

// One attempt against one model. Resolves to { res, model } or a plain error record.
async function callModel(model, body, apiKey, timeoutMs = HEADERS_TIMEOUT_MS) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      const retryAfterMs = retryHintMs(res.headers.get("Retry-After"), text);
      const regionalRoutingIssue = res.status === 400 && /location is not supported/i.test(text);
      return {
        status: res.status,
        message: extractMessage(text) || `Gemini API returned HTTP ${res.status}.`,
        retryAfter: retryAfterMs ? String(Math.ceil(retryAfterMs / 1000)) : undefined,
        retryAfterMs,
        keyProblem: isKeyProblem(res.status, text),
        regionalRoutingIssue,
      };
    }
    const primed = await primeStream(res); // the first event must arrive before the timer fires
    clearTimeout(timer); // from here the stream itself runs without a cutoff
    if (primed.failure) return primed.failure;
    return { res: { body: primed.body }, model };
  } catch (err) {
    clearTimeout(timer);
    return err && err.name === "AbortError"
      ? { status: 504, message: "Gemini did not respond in time.", timedOut: true }
      : { status: 502, message: "Could not reach the Gemini API." };
  }
}

// Independent OpenAI-compatible backup. Configure GROQ_API_KEY as a Worker
// secret; GROQ_MODEL is optional and defaults to a currently supported text model.
// This path deliberately skips image/PDF and tool requests rather than silently
// dropping attachments or pretending provider-specific tools are portable.
async function callGroqFallback(input, env) {
  const messages = [];
  for (const message of (Array.isArray(input.messages) ? input.messages : [])) {
    if (!message || !["system", "user", "assistant"].includes(message.role)) continue;
    if (Array.isArray(message.content) && message.content.some(part => part && part.type === "image_url")) {
      return { message: "Groq backup skipped because this request contains an image or document attachment." };
    }
    messages.push({ role: message.role, content: textOf(message.content) });
  }
  if (!messages.length) return { message: "Groq backup has no compatible text messages." };
  const model = String(env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();
  if (!MODEL_RE.test(model)) return { message: "GROQ_MODEL is invalid." };
  const body = { model, messages, stream: true };
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (typeof input.top_p === "number") body.top_p = input.top_p;
  if (Number.isInteger(input.max_tokens) && input.max_tokens > 0) body.max_tokens = input.max_tokens;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GROQ_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok && response.body) return { res: response, model };
    const raw = await response.text().catch(() => "");
    return { status: response.status, message: extractMessage(raw) || "Groq returned HTTP " + response.status + "." };
  } catch (error) {
    return { status: 502, message: error && error.name === "TimeoutError" ? "Groq backup timed out." : "Could not reach the Groq backup." };
  }
}

async function callGemini(chain, body, apiKey, health) {
  const started = Date.now();
  const tried = [];
  let last = { status: 502, message: "Could not reach the Gemini API." };
  await health.load();

  for (const model of health.order(chain)) {
    tried.push(model);
    // A model that is resting gets one quick try as a last resort, not a full set of retries.
    const attempts = health.isResting(model) ? 1 : ATTEMPTS_PER_MODEL;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const left = TOTAL_BUDGET_MS - (Date.now() - started);
      if (left < MIN_ATTEMPT_MS) return { error: busyError(tried, last) };

      const outcome = await callModel(model, body, apiKey, Math.min(HEADERS_TIMEOUT_MS, left));
      if (outcome.res) { // this model answered
        await health.clear(model);
        return { ...outcome, tried };
      }
      last = outcome;
      console.warn(`[ultron] ${model} attempt ${attempt}/${attempts} failed: HTTP ${outcome.status}${outcome.timedOut ? " (timeout)" : ""}`);

      // A rejected key will not be fixed by another model, and its details never leave the Worker.
      if (outcome.keyProblem) {
        console.error(`[ultron] Gemini rejected the API key (HTTP ${outcome.status}).`);
        return { error: keyError() };
      }
      // A bad request will not be fixed by trying another model either.
      if (!RETRY_STATUS.has(outcome.status) && outcome.status !== MODEL_GONE_STATUS && !outcome.regionalRoutingIssue) return { error: outcome };

      // Each model has its own quota: a rate limit is better spent on the next model.
      if (outcome.status === 429) { await health.mark(model, outcome.retryAfterMs || COOLDOWN_MS.rateLimited, "rate-limited"); break; }
      // A retired model will not come back.
      if (outcome.status === MODEL_GONE_STATUS) { await health.mark(model, COOLDOWN_MS.gone, "not-found"); break; }
      // A model that just stalled will not improve on a second try.
      if (outcome.timedOut) { await health.mark(model, COOLDOWN_MS.timeout, "timeout"); break; }

      // 500, 502, 503, 504: back off exponentially, then rest the model if it never recovers.
      if (attempt < attempts) await sleep(backoffDelay(attempt, outcome.retryAfterMs));
      else await health.mark(model, COOLDOWN_MS.overloaded, "overloaded");
    }
  }
  return { error: busyError(tried, last) };
}

// Every model in the chain is busy: say that once, instead of echoing one model's error.
function busyError(tried, last) {
  const status = last && last.status === 429 ? 429 : last && last.status === 504 ? 504 : 503;
  const reason = redact((last && last.message) || "The model is busy.").slice(0, 200);
  return {
    status,
    message: `Google's models are busy right now, so this Worker could not get an answer (tried ${tried.join(", ")}). Last error: ${reason} Please try again in a moment.`,
    retryAfter: (last && last.retryAfter) || "10",
  };
}

function extractMessage(text) {
  if (!text) return "";
  let message = "";
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
    message = typeof e === "string" ? e : (e && e.message) || j.message || "";
  } catch {
    message = text;
  }
  return redact(message).slice(0, 300);
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

/* ---------- Google account authorization ---------- */
async function authenticateGoogleRequest(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { status: 401, message: "Sign in with Google to continue." };
  try {
    const identity = await verifyGoogleIdToken(token, env.GOOGLE_CLIENT_ID);
    return identity ? { identity } : { status: 401, message: "Your Google sign-in is invalid or expired. Sign in again." };
  } catch {
    return { status: 503, message: "Google sign-in verification is temporarily unavailable. Try again." };
  }
}

function isUltronOwner(identity, env) {
  const ownerEmail = String(env.ULTRON_OWNER_EMAIL || "").trim().toLowerCase();
  return Boolean(ownerEmail && identity && identity.email_verified && String(identity.email || "").trim().toLowerCase() === ownerEmail);
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Retry-After, X-ULTRON-Model, X-ULTRON-Fallback",
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
  return { error: { message: redact(message), type: errorType(status), code: status } };
}

function jsonResponse(data, status, corsHeaders, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(extra || {}) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
