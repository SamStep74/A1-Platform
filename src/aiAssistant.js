"use strict";

/**
 * A1 Platform — advisory, read-only operations assistant (net-new AI feature).
 *
 * Built on the shared @a1/ai chat client (OpenRouter), vendored at src/vendor/a1-ai.
 * It NEVER executes changes — it explains, summarizes, and suggests, using only the
 * safe AGGREGATE context the caller passes (no tenant secrets/PII reach the model).
 * Env-driven (OPENROUTER_API_KEY / OPENROUTER_MODEL). Egress goes direct (Platform
 * has no allowlist layer today).
 */

const a1ai = require("./vendor/a1-ai");

const SYSTEM_INSTRUCTIONS = [
  "You are the A1 Platform operations assistant for a self-hosted, sovereign Armenian business platform.",
  "You are ADVISORY and READ-ONLY: explain, summarize, and suggest — never claim to have provisioned tenants, run migrations, changed config, or executed commands.",
  "Base answers on the provided platform context and the operator's question; if information is missing, say so and suggest what to check.",
  "Be concise and practical. Answer in the operator's language (Armenian, Russian, or English)."
].join(" ");

const GUARDRAILS = [
  "Advisory only — this assistant does not make platform changes.",
  "Verify suggestions against the live platform; destructive operations require explicit operator action."
];

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}

function isAiConfigured(env = process.env) {
  return Boolean(env.OPENROUTER_API_KEY);
}

function createPlatformAssistant({ env = process.env } = {}) {
  const chat = a1ai.createChatClient({
    safeFetch: (...args) => fetch(...args),
    openrouter: {
      baseUrl: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      referer: "https://a1.am",
      title: "A1 Platform"
    }
  });

  async function ask({ question, context = {}, env: callEnv = env } = {}) {
    const q = String(question || "").trim();
    if (!q) throw httpError(400, "QUESTION_REQUIRED", "A question is required.");
    if (!callEnv.OPENROUTER_API_KEY) {
      throw httpError(503, "AI_NOT_CONFIGURED", "Platform AI is not configured. Set OPENROUTER_API_KEY.");
    }
    const input = `Platform context (safe aggregates only):\n${JSON.stringify(context, null, 2)}\n\nOperator question:\n${q}`;
    const result = await chat.callModel({
      instructions: SYSTEM_INSTRUCTIONS,
      input,
      model: callEnv.OPENROUTER_MODEL || "",
      apiKey: callEnv.OPENROUTER_API_KEY,
      env: callEnv
    });
    return {
      provider: "openrouter",
      model: result.model || callEnv.OPENROUTER_MODEL || "auto",
      advisory: true,
      answer: result.text,
      guardrails: GUARDRAILS
    };
  }

  return { ask };
}

module.exports = { createPlatformAssistant, isAiConfigured, SYSTEM_INSTRUCTIONS, GUARDRAILS };
