"use strict";

/**
 * @a1/ai — shared, framework-agnostic AI provider core for the A1 product family.
 *
 * Each product wires it once via dependency injection, e.g.:
 *
 *   const { createAi } = require("@a1/ai");
 *   const ai = createAi({
 *     safeFetch: config.safeFetch,                 // (url, options, env) => Promise<Response> (egress-gated)
 *     isEgressAllowed: config.isOpenRouterEgressAllowed, // (env) => boolean
 *     openrouter: config.openrouter,               // { modelsUrl, referer, title }
 *     resolveDataDir: config.resolveDataDir,        // () => string (where ai-settings.json lives)
 *     defaultModels: config.aiModels                // { default, copilot, transform, finance, crm, docs }
 *   });
 *
 *   await ai.listModels({ apiKey });               // live OpenRouter menu (+ offline fallback)
 *   ai.settings.getSettings() / updateSettings() / redactedForClient() / resolveModelPolicy();
 *   ai.resolveModelForRequest(policy, { aspect, module });
 *   await ai.openNotebook.search(query, { settings, k });
 *   ai.normalizeSupplementalSources(rows);
 *
 * The package imports NO product config — egress policy, data dir, and HTTP all
 * come from the host product, keeping every A1 product on one AI source of truth.
 */

const policy = require("./src/model-policy");
const { createModelCatalog } = require("./src/model-catalog");
const { createSettingsStore } = require("./src/settings-store");
const openNotebookMod = require("./src/open-notebook");
const supplemental = require("./src/supplemental");
const { createChatClient } = require("./src/chat");

function createAi(deps = {}) {
  const {
    safeFetch,
    isEgressAllowed,
    openrouter,
    resolveDataDir,
    fileName,
    modelKeys = policy.MODEL_KEYS,
    defaultModels = {}
  } = deps;

  const catalog = createModelCatalog({ safeFetch, isEgressAllowed, openrouter });
  const settings = createSettingsStore({ resolveDataDir, fileName, modelKeys, defaultModels });
  const openNotebook = openNotebookMod.createOpenNotebook({ safeFetch });
  const chat = createChatClient({ safeFetch, openrouter, maxOutputTokens: deps.maxOutputTokens });

  return {
    // model menu + policy
    listModels: catalog.listModels,
    normalizeModels: policy.normalizeModels,
    resolveModelForRequest: policy.resolveModelForRequest,
    FALLBACK_MODELS: policy.FALLBACK_MODELS,
    MODEL_KEYS: Array.isArray(modelKeys) && modelKeys.length ? modelKeys.slice() : policy.MODEL_KEYS,
    MODULES: policy.MODULES,
    ASPECTS: policy.ASPECTS,
    // local settings
    settings,
    // generation + opt-in supplemental source
    chat,
    openNotebook,
    normalizeSupplementalSources: supplemental.normalizeSupplementalSources,
    MAX_SUPPLEMENTAL_SOURCES: supplemental.MAX_SUPPLEMENTAL_SOURCES
  };
}

module.exports = {
  createAi,
  // factories
  createModelCatalog,
  createSettingsStore,
  createOpenNotebook: openNotebookMod.createOpenNotebook,
  createChatClient,
  // pure helpers / constants
  normalizeModels: policy.normalizeModels,
  resolveModelForRequest: policy.resolveModelForRequest,
  normalizeResults: openNotebookMod.normalizeResults,
  isEnabled: openNotebookMod.isEnabled,
  normalizeSupplementalSources: supplemental.normalizeSupplementalSources,
  FALLBACK_MODELS: policy.FALLBACK_MODELS,
  MODEL_KEYS: policy.MODEL_KEYS,
  MODULES: policy.MODULES,
  ASPECTS: policy.ASPECTS,
  MAX_SUPPLEMENTAL_SOURCES: supplemental.MAX_SUPPLEMENTAL_SOURCES,
  SUPPLEMENTAL_EXCERPT_MAX: supplemental.SUPPLEMENTAL_EXCERPT_MAX,
  DEFAULT_SEARCH_PATH: openNotebookMod.DEFAULT_SEARCH_PATH
};
