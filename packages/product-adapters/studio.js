"use strict";

const { tenantContextMiddleware } = require("../../src/tenant-context");

function createStudioTenantMiddleware(registry) {
  return tenantContextMiddleware({ registry, productCode: "studio" });
}

module.exports = { createStudioTenantMiddleware };
