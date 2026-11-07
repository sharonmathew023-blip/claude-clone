// OpenClaude Gemini proxy. Deployed from GitHub via Cloudflare Workers Builds.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      return json({ data: [{ id: "gemini-3.8-flash", object: "model" }] });
    }

    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      return json({ error: { message: "OpenClaude Gemini proxy is running. Use POST /chat/completions." } }, 404);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: { message: "Missing GEMINI_API_KEY Worker secret. Add it in Cloudflare Worker Settings > Variables and Secrets." } }, 500);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: { message: "Request body must be valid JSON." } }, 400);
    }

    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      return json({ error: { message: "A non-empty messages array is required." } }, 400);
    }

    const model = String(input.model || "gemini-3.8-flash").replace(/^models\//, "");
    const systemText = input.messages
      .filter(message => message.role === "system")
      .map(message => String(message.content || ""))
      .join("\n\n");

    const contents = input.messages
      .filter(message => message.role !== "system")
      .map(message => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: String(message.content || "") }]
      }));

    if (!contents.length) {
      return json({ error: { message: "No user or assistant messages were provided." } }, 400);
    }

    const geminiBody = { contents };
    if (systemText) geminiBody.systemInstruction = { parts: [{ text: systemText }] };
    if (input.temperature !== undefined) {
      geminiBody.generationConfig = { temperature: input.temperature };
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let upstream;
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify(geminiBody)
      });
    } catch (error) {
      return json({ error: { message: "Could not reach the Gemini API: " + error.message } }, 502);
    }

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = result.error?.message || `Gemini API returned HTTP ${upstream.status}.`;
      return json({ error: { message } }, upstream.status);
    }

    const text = (result.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("");

    if (!text) {
      const reason = result.promptFeedback?.blockReason || "The model returned an empty response.";
      return json({ error: { message: reason } }, 502);
    }

    // The frontend reads OpenAI-compatible server-sent events. Send one
    // complete content chunk, followed by the standard stream terminator.
    const chunk = {
      id: "chatcmpl-openclaude",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]
    };
    const stream = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform"
      }
    });
  }
};
