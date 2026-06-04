"use strict";

/**
 * Advisory-only "supplemental sources" policy — e.g. Open Notebook hits shown
 * BESIDE a product's authoritative citations. Pure (no I/O).
 *
 * The cap / dedupe key / ordering / excerpt length below is the product-tunable
 * knob. Supplemental sources are advisory: a consuming product MUST keep them out
 * of any authoritative-citation gate (they never satisfy a required citation).
 */

const MAX_SUPPLEMENTAL_SOURCES = 3;
const SUPPLEMENTAL_EXCERPT_MAX = 280;

function normalizeSupplementalSources(raw, { max = MAX_SUPPLEMENTAL_SOURCES } = {}) {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map(row => {
      const r = row || {};
      return {
        title: String(r.title || "Open Notebook").replace(/\s+/g, " ").trim() || "Open Notebook",
        excerpt: String(r.text || r.excerpt || "").replace(/\s+/g, " ").trim().slice(0, SUPPLEMENTAL_EXCERPT_MAX),
        sourceUrl: typeof r.sourceUrl === "string" ? r.sourceUrl : "",
        score: Number.isFinite(r.score) ? r.score : 0,
        origin: "open-notebook",
        advisory: true
      };
    })
    .filter(row => row.excerpt.length > 0)
    .sort((a, b) => b.score - a.score);
  // Dedupe on sourceUrl when present, else title; keep the highest-scored hit.
  const seen = new Set();
  const out = [];
  for (const row of cleaned) {
    const key = (row.sourceUrl || row.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { normalizeSupplementalSources, MAX_SUPPLEMENTAL_SOURCES, SUPPLEMENTAL_EXCERPT_MAX };
