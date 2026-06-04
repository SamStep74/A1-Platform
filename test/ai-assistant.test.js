"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlatformAssistant, isAiConfigured } = require("../src/aiAssistant");

test("isAiConfigured reflects OPENROUTER_API_KEY", () => {
  assert.equal(isAiConfigured({ OPENROUTER_API_KEY: "k" }), true);
  assert.equal(isAiConfigured({}), false);
});

test("ask requires a question", async () => {
  const a = createPlatformAssistant({ env: { OPENROUTER_API_KEY: "k" } });
  await assert.rejects(
    () => a.ask({ question: "  " }),
    (err) => { assert.equal(err.statusCode, 400); return true; },
  );
});

test("ask requires OPENROUTER_API_KEY", async () => {
  const a = createPlatformAssistant({ env: {} });
  await assert.rejects(
    () => a.ask({ question: "how many tenants?" }),
    (err) => { assert.equal(err.code, "AI_NOT_CONFIGURED"); return true; },
  );
});

test("ask returns an advisory answer and sends safe context + question to OpenRouter", async () => {
  const realFetch = globalThis.fetch;
  let seen = {};
  globalThis.fetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ model: "openai/gpt-4o", choices: [{ message: { content: "You have 3 tenants." } }] }) };
  };
  try {
    const a = createPlatformAssistant({ env: { OPENROUTER_API_KEY: "sk-or-x", OPENROUTER_MODEL: "openai/gpt-4o" } });
    const out = await a.ask({ question: "How many tenants?", context: { tenantCount: 3, byStatus: { active: 3 } } });
    assert.equal(out.provider, "openrouter");
    assert.equal(out.advisory, true);
    assert.equal(out.answer, "You have 3 tenants.");
    assert.ok(Array.isArray(out.guardrails) && out.guardrails.length >= 1);
    assert.ok(String(seen.url).endsWith("/chat/completions"));
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.model, "openai/gpt-4o");
    assert.match(body.messages[0].content, /ADVISORY and READ-ONLY/);
    assert.match(body.messages[1].content, /tenantCount/);
    assert.match(body.messages[1].content, /How many tenants\?/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
