"use strict";

const { tenantContextMiddleware } = require("../../src/tenant-context");

function createHayHashvapahTenantMiddleware(registry) {
  return tenantContextMiddleware({ registry, productCode: "hayhashvapah" });
}

module.exports = { createHayHashvapahTenantMiddleware };
