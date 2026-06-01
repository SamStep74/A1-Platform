"use strict";

module.exports = {
  backupRestore: require("./backup-restore"),
  config: require("./config"),
  gateway: require("./gateway"),
  naming: require("./naming"),
  platformDb: require("./platform-db"),
  productImport: require("./product-import"),
  productImporters: require("./product-importers"),
  storage: require("./storage"),
  tenantContext: require("./tenant-context"),
  tenantTransfer: require("./tenant-transfer")
};
