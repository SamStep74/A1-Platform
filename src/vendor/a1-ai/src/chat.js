"use strict";

/**
 * OpenRouter chat-completions client (OpenAI-compatible) — the single cloud
 * generation path for the A1 family. Framework-agnostic: the egress-gated fetch
 * and the OpenRouter endpoint/attribution config are INJECTED by the host product
 * (egress is enforced inside the injected safeFetch — deny-until-listed).
 *
 * Exposes a provider-agnostic `callModel({ instructions, input })` and a
 * `callVision({ ..., imageBase64, mimeType })`, both returning
 * { text, responseId, usage, provider:"openrouter", model }. Errors carry
 * { statusCode, code } so hosts can map them to HTTP responses.
 */

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function extractText(payload) {
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : "";
  return typeof content === "string" ? content.trim() : "";
}

/**
 * @param {{
 *   safeFetch: (url:string, options:object, env?:object) => Promise<{ok:boolean,status?:number,json:Function}>,
 *   openrouter: { baseUrl:string, referer?:string, title?:string },
 *   maxOutputTokens?: number
 * }} deps
 */
function createChatClient({ safeFetch, openrouter, maxOutputTokens = 1200 } = {}) {
  if (typeof safeFetch !== "function") throw new TypeError("createChatClient requires safeFetch(url, options, env)");
  if (!openrouter || !openrouter.baseUrl) throw new TypeError("createChatClient requires openrouter.baseUrl");
  const endpoint = openrouter.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  function headers(apiKey) {
    const h = {
      "Content-Type": "application/json",
      "HTTP-Referer": openrouter.referer || "",
      "X-Title": openrouter.title || ""
    };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  async function post(body, apiKey, env) {
    if (!apiKey) throw httpError(503, "AI_NOT_CONFIGURED", "OpenRouter API key is not configured.");
    const res = await safeFetch(endpoint, { method: "POST", headers: headers(apiKey), body: JSON.stringify(body) }, env);
    const payload = await res.json().catch(() => ({}));
    if (!res || !res.ok) {
      throw httpError(
        res ? res.status : 502,
        (payload && payload.error && payload.error.code) || "OPENROUTER_ERROR",
        (payload && payload.error && payload.error.message) || `OpenRouter request failed (${res ? res.status : "no response"})`
      );
    }
    return payload;
  }

  function result(payload, model) {
    return {
      text: extractText(payload),
      responseId: payload.id || null,
      usage: payload.usage,
      provider: "openrouter",
      model: payload.model || model || ""
    };
  }

  async function callModel({ instructions, input, model = "", apiKey = "", env = process.env, maxTokens = maxOutputTokens } = {}) {
    const payload = await post({
      model: model || undefined,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input }
      ]
    }, apiKey, env);
    return result(payload, model);
  }

  async function callVision({ instructions, input, imageBase64, mimeType = "image/jpeg", model = "", apiKey = "", env = process.env, maxTokens = maxOutputTokens } = {}) {
    const payload = await post({
      model: model || undefined,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: [
          { type: "text", text: input },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ] }
      ]
    }, apiKey, env);
    return result(payload, model);
  }

  // Structured output via OpenRouter's OpenAI-compatible response_format json_schema.
  // Returns { data: <parsed JSON>, ... }. Only models that support structured output
  // honor the schema; callers should keep a fallback for AI_BAD_JSON.
  async function callStructured({ instructions, input, schema, schemaName = "result", strict = true, model = "", apiKey = "", env = process.env, maxTokens = maxOutputTokens } = {}) {
    const payload = await post({
      model: model || undefined,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input }
      ],
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict, schema } }
    }, apiKey, env);
    const text = extractText(payload);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw httpError(502, "AI_BAD_JSON", "Structured AI response was not valid JSON");
    }
    return { data, text, responseId: payload.id || null, usage: payload.usage, provider: "openrouter", model: payload.model || model || "" };
  }

  return { callModel, callVision, callStructured, endpoint };
}

module.exports = { createChatClient };
