"use strict";

/**
 * Pure model-policy core (no I/O, no framework, no product config import):
 *  - FALLBACK_MODELS: tiny offline list so a model menu is never empty
 *  - normalizeModels(): map an OpenRouter /models payload to the A1 shape
 *  - resolveModelForRequest(): the per-module / per-aspect precedence
 *
 * The precedence ordering here is the single policy knob shared by every A1
 * product. Keep it pure so it is trivially testable and identical everywhere.
 */

// Minimal offline fallback so the dropdown is never empty when egress is off.
// The live list is the source of truth; these are only shown when offline.
const FALLBACK_MODELS = Object.freeze([
  { id: "anthropic/claude-3.5-sonnet", name: "Anthropic: Claude 3.5 Sonnet", contextLength: 200000, pricing: { prompt: null, completion: null } },
  { id: "openai/gpt-4o", name: "OpenAI: GPT-4o", contextLength: 128000, pricing: { prompt: null, completion: null } },
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini", contextLength: 128000, pricing: { prompt: null, completion: null } },
  { id: "google/gemini-flash-1.5", name: "Google: Gemini Flash 1.5", contextLength: 1000000, pricing: { prompt: null, completion: null } },
  { id: "meta-llama/llama-3.1-70b-instruct", name: "Meta: Llama 3.1 70B Instruct", contextLength: 131072, pricing: { prompt: null, completion: null } }
]);

// A1 family default policy keys. Products may override with their own set, but
// these defaults keep model selection consistent across the suite.
const MODEL_KEYS = Object.freeze(["default", "copilot", "transform", "finance", "crm", "docs"]);
const MODULES = new Set(["finance", "crm", "docs"]);
const ASPECTS = new Set(["copilot", "transform"]);

function normalizeModels(raw) {
  const data = raw && Array.isArray(raw.data) ? raw.data : null;
  if (!data) return [];
  return data
    .filter(m => m && typeof m.id === "string" && m.id)
    .map(m => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      contextLength: Number.isFinite(m.context_length) ? m.context_length : 0,
      pricing: m.pricing && typeof m.pricing === "object"
        ? { prompt: m.pricing.prompt ?? null, completion: m.pricing.completion ?? null }
        : { prompt: null, completion: null }
    }));
}

/**
 * Resolve which model a request should use.
 * Precedence (highest first): per-module override -> per-aspect override ->
 * global default -> "" (auto / pick at call time).
 *
 * @param {Record<string,string>} policy  per-key model ids (default/copilot/transform/finance/crm/docs)
 * @param {{aspect?:string,module?:string}} ctx
 * @returns {string} model id, or "" for auto
 */
function resolveModelForRequest(policy = {}, { aspect, module } = {}) {
  const pick = key => (key && typeof policy[key] === "string" && policy[key].trim() ? policy[key].trim() : "");
  if (module && MODULES.has(module)) {
    const m = pick(module);
    if (m) return m;
  }
  if (aspect && ASPECTS.has(aspect)) {
    const a = pick(aspect);
    if (a) return a;
  }
  return pick("default");
}

module.exports = { FALLBACK_MODELS, MODEL_KEYS, MODULES, ASPECTS, normalizeModels, resolveModelForRequest };
