"use strict";

/**
 * Open Notebook (lfnovo/open-notebook) — opt-in AI source that sits BESIDE a
 * product's local RAG. We connect to a self-hosted instance over its REST API;
 * we never bundle its Python/SurrealDB runtime.
 *
 * Framework-agnostic: the egress-gated fetch is INJECTED. The connector is:
 *   - opt-in     — only runs when settings.openNotebook.enabled + baseUrl are set
 *   - egress-gated — calls go through the injected safeFetch (loopback ok; remote
 *                    hosts must be allowlisted by the host product)
 *   - non-throwing — any failure returns [] so the host retrieval flow is never broken
 *
 * Returned rows match the common RAG result shape so callers can merge sources.
 */

const DEFAULT_SEARCH_PATH = "/api/search";

function isEnabled(settings) {
  return Boolean(
    settings && settings.openNotebook && settings.openNotebook.enabled && settings.openNotebook.baseUrl
  );
}

// Tolerate the likely Open Notebook response shapes ({results}|{sources}|{data}|array).
function normalizeResults(raw, k = 6) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  else if (raw && Array.isArray(raw.results)) items = raw.results;
  else if (raw && Array.isArray(raw.sources)) items = raw.sources;
  else if (raw && Array.isArray(raw.data)) items = raw.data;
  return items
    .slice(0, k)
    .map(it => ({
      title: String(it.title || it.name || it.notebook || "Open Notebook"),
      text: String(it.text || it.content || it.snippet || it.chunk || ""),
      score: Number.isFinite(it.score) ? it.score : (Number.isFinite(it.relevance) ? it.relevance : 0),
      sourceUrl: typeof it.url === "string" ? it.url : (typeof it.source_url === "string" ? it.source_url : ""),
      origin: "open-notebook"
    }))
    .filter(r => r.text);
}

/**
 * @param {{ safeFetch: (url:string, options:object, env?:object) => Promise<{ok:boolean,json:Function}> }} deps
 */
function createOpenNotebook({ safeFetch } = {}) {
  if (typeof safeFetch !== "function") throw new TypeError("createOpenNotebook requires safeFetch(url, options, env)");

  async function search(query, { settings, k = 6, env = process.env } = {}) {
    if (!isEnabled(settings)) return [];
    const q = String(query || "").trim();
    if (!q) return [];
    const on = settings.openNotebook;
    const url = on.baseUrl.replace(/\/+$/, "") + (on.searchPath || DEFAULT_SEARCH_PATH);
    try {
      const headers = { "Content-Type": "application/json" };
      if (on.apiKey) headers.Authorization = `Bearer ${on.apiKey}`;
      const res = await safeFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: q, limit: k })
      }, env);
      if (!res || !res.ok) return [];
      return normalizeResults(await res.json(), k);
    } catch {
      // Egress-blocked, network, or parse error — degrade silently beside local RAG.
      return [];
    }
  }

  return { isEnabled, normalizeResults, search, DEFAULT_SEARCH_PATH };
}

module.exports = { createOpenNotebook, isEnabled, normalizeResults, DEFAULT_SEARCH_PATH };
