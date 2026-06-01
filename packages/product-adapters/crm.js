"use strict";

const { tenantContextMiddleware } = require("../../src/tenant-context");

function createCrmTenantMiddleware(registry) {
  return tenantContextMiddleware({ registry, productCode: "crm" });
}

module.exports = { createCrmTenantMiddleware };
