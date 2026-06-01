"use strict";

const { getConfig } = require("./config");
const { PlatformDb } = require("./platform-db");

const config = getConfig();
const platformDb = new PlatformDb(config);
const intervalMs = Number(process.env.WORKER_HEALTH_INTERVAL_MS || 60_000);

async function tick() {
  try {
    const tenants = await platformDb.listTenants();
    process.stdout.write(`[worker] ${new Date().toISOString()} tenants=${tenants.length}\n`);
  } catch (error) {
    process.stderr.write(`[worker] health tick failed: ${error.message}\n`);
  }
}

if (require.main === module) {
  tick();
  setInterval(tick, intervalMs);
}

module.exports = { tick };
