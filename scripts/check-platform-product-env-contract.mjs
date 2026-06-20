#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFile = "test/product-env.test.js";
const expectedTestCount = 6;
const requiredTitles = [
  "renders CRM env for platform Postgres JSONB storage",
  "renders HayHashvapah env for platform Postgres JSONB storage",
  "redacts sensitive URLs and platform token when requested",
  "renders all product env sections and external data roots",
  "refuses env for disabled tenant modules",
  "writes per-product env files and a manifest",
];
const forbiddenSentinelPatterns = [
  { label: "platform token env", pattern: /\bA1_PLATFORM_TOKEN\s*[:=]/i },
  { label: "database url env", pattern: /\b(?:DATABASE_URL|A1_(?:CRM|HAYHASHVAPAH)_DATABASE_URL)\s*[:=]/i },
  { label: "postgres password", pattern: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i },
  { label: "platform token value", pattern: /\bplatform-token\b/ },
  { label: "authorization header", pattern: /\bauthorization\b\s*[:=]/i },
  { label: "bearer token", pattern: /\bbearer\s+[-._~+/=a-z0-9]+/i },
];

function testEnv(env, tempRoot) {
  return {
    CI: "1",
    NODE_ENV: "test",
    A1_PLATFORM_TOKEN: "",
    DATABASE_URL: "",
    A1_CRM_DATABASE_URL: "",
    A1_HAYHASHVAPAH_DATABASE_URL: "",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PATH: env.PATH || "",
    HOME: env.HOME || "",
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    SystemRoot: env.SystemRoot || "",
    ComSpec: env.ComSpec || "",
    PATHEXT: env.PATHEXT || "",
  };
}

function validateTapReport(reportPath) {
  if (!existsSync(reportPath)) return "missing Node TAP report";
  if (requiredTitles.length !== expectedTestCount) {
    return `checker expected-title list has ${requiredTitles.length} entries, expected ${expectedTestCount}`;
  }
  const tap = readFileSync(reportPath, "utf8");
  if (!tap.includes(`1..${expectedTestCount}`)) {
    return `missing TAP plan 1..${expectedTestCount}`;
  }
  if (/^not ok\s+\d+/m.test(tap)) return "TAP report contains failing tests";
  if (/^ok\s+\d+\s+-\s+.+#\s*(SKIP|TODO)\b/im.test(tap)) {
    return "TAP report contains skipped or TODO tests";
  }
  if (new RegExp(`#\\s+(fail|cancelled|skipped|todo)\\s+[1-9]`).test(tap)) {
    return "TAP summary contains non-passing tests";
  }
  const okTitles = Array.from(tap.matchAll(/^ok\s+\d+\s+-\s+(.+)$/gm), (match) => match[1].trim());
  if (okTitles.length !== expectedTestCount) {
    return `expected ${expectedTestCount} passing tests, got ${okTitles.length}`;
  }
  const titleSet = new Set(okTitles);
  if (titleSet.size !== expectedTestCount) {
    return "TAP report contains duplicate passing test titles";
  }
  for (const title of requiredTitles) {
    if (!titleSet.has(title)) return `missing expected test title: ${title}`;
  }
  return "";
}

function findSentinelLeak(...parts) {
  const output = parts.filter(Boolean).join("\n");
  const match = forbiddenSentinelPatterns.find((sentinel) => sentinel.pattern.test(output));
  return match ? match.label : "";
}

let tempRoot = "";
let result = { status: 1, stdout: "", stderr: "", error: null };
let reportError = "";
let leakDetected = false;

try {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "a1-platform-product-env-contract-"));
  const reportPath = path.join(tempRoot, "platform-product-env-contract.tap");
  result = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    `--test-reporter-destination=${reportPath}`,
    testFile,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: testEnv(process.env, tempRoot),
    shell: false,
  });
  reportError = validateTapReport(reportPath);
  const leak = findSentinelLeak(
    existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "",
    result.stdout,
    result.stderr,
  );
  if (leak) {
    leakDetected = true;
    reportError = "secret sentinel leaked in eval output";
  }
} catch (error) {
  reportError = error && error.message ? error.message : String(error);
} finally {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}

const failed = result.error || result.status !== 0 || reportError;
console.log(`failing_checks=${failed ? 1 : 0}`);

if (reportError) {
  console.error(`report_validation_error=${reportError}`);
}
if (!leakDetected && !failed && result.stdout) process.stdout.write(result.stdout);
if (!leakDetected && !failed && result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  console.error(result.error.message);
}
process.exitCode = failed ? 1 : 0;
