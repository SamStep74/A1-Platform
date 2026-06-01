"use strict";

module.exports = {
  config: require("./config"),
  naming: require("./naming"),
  platformDb: require("./platform-db"),
  productImporters: require("./product-importers"),
  storage: require("./storage"),
  tenantContext: require("./tenant-context"),
  tenantTransfer: require("./tenant-transfer")
};
