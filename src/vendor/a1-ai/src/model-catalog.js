"use strict";

/**
 * Live OpenRouter model catalog. Framework-agnostic: the egress gate, the fetch
 * implementation, and the OpenRouter endpoint/attribution config are INJECTED by
 * the consuming product (so this package depends on no product's config.js).
 *
 * listModels() returns { online, source:"live"|"fallback", reason?, models:[...] }
 * and NEVER throws — when egress is blocked or the call fails it degrades to the
 * bundled FALLBACK_MODELS so the onboarding menu always renders.
 */

const { FALLBACK_MODELS, normalizeModels } = require("./model-policy");

function fallback(reason) {
  return { online: false, source: "fallback", reason, models: FALLBACK_MODELS.slice() };
}

/**
 * @param {{
 *   safeFetch: (url:string, options:object, env?:object) => Promise<{ok:boolean,status?:number,json:Function}>,
 *   isEgressAllowed: (env?:object) => boolean,
 *   openrouter: { modelsUrl:string, referer?:string, title?:string }
 * }} deps
 */
function createModelCatalog({ safeFetch, isEgressAllowed, openrouter } = {}) {
  if (typeof safeFetch !== "function") throw new TypeError("createModelCatalog requires safeFetch(url, options, env)");
  if (typeof isEgressAllowed !== "function") throw new TypeError("createModelCatalog requires isEgressAllowed(env)");
  if (!openrouter || !openrouter.modelsUrl) throw new TypeError("createModelCatalog requires openrouter.modelsUrl");

  async function listModels({ apiKey = "", env = process.env } = {}) {
    if (!isEgressAllowed(env)) return fallback("egress-blocked");
    try {
      const headers = {
        "Content-Type": "application/json",
        // OpenRouter attribution (recommended for ranking/analytics).
        "HTTP-Referer": openrouter.referer || "",
        "X-Title": openrouter.title || ""
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await safeFetch(openrouter.modelsUrl, { method: "GET", headers }, env);
      if (!res || !res.ok) return fallback(`http-${res ? res.status : "no-response"}`);
      const models = normalizeModels(await res.json());
      if (!models.length) return fallback("empty-list");
      return { online: true, source: "live", models };
    } catch (err) {
      return fallback((err && err.code) || "fetch-error");
    }
  }

  return { listModels };
}

module.exports = { createModelCatalog, FALLBACK_MODELS, normalizeModels };
