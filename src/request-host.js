"use strict";

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  return String(value || "").split(",")[0].trim();
}

function tenantRequestHost(headers = {}) {
  return firstHeaderValue(headers["x-a1-request-host"])
    || firstHeaderValue(headers["x-forwarded-host"])
    || firstHeaderValue(headers.host);
}

module.exports = { tenantRequestHost };
