"use strict";

module.exports = {
  backupRestore: require("./backup-restore"),
  config: require("./config"),
  gateway: require("./gateway"),
  naming: require("./naming"),
  platformDb: require("./platform-db"),
  productImporters: require("./product-importers"),
  storage: require("./storage"),
  tenantContext: require("./tenant-context"),
  tenantTransfer: require("./tenant-transfer")
};
