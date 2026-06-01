"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalTenantStorage, tenantObjectKey } = require("../src/storage");

test("builds tenant/product-prefixed object keys", () => {
  assert.equal(
    tenantObjectKey("Demo Client", "crm", "documents/quote.pdf"),
    "tenants/demo-client/crm/documents/quote.pdf"
  );
  assert.throws(() => tenantObjectKey("demo", "crm", "../secret"), /Unsafe object key/);
});

test("local storage keeps tenant files under tenant prefix and syncs bundles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-storage-"));
  const storage = new LocalTenantStorage({ root, bucket: "a1-documents" });

  await storage.putObject("demo", "crm", "documents/quote.txt", "quote");
  await storage.putObject("demo", "hayhashvapah", "invoices/invoice.txt", "invoice");

  assert.equal((await storage.countTenantObjects("demo")), 2);
  assert.equal(String(await storage.getObject("demo", "crm", "documents/quote.txt")), "quote");

  const out = await fs.mkdtemp(path.join(os.tmpdir(), "a1-export-files-"));
  assert.equal(await storage.syncPrefixToDir("demo", out), 2);
  assert.equal(await fs.readFile(path.join(out, "crm", "documents", "quote.txt"), "utf8"), "quote");

  const imported = new LocalTenantStorage({ root: await fs.mkdtemp(path.join(os.tmpdir(), "a1-imported-storage-")), bucket: "a1-documents" });
  assert.equal(await imported.syncDirToPrefix("demo", out), 2);
  assert.equal((await imported.countTenantObjects("demo")), 2);
});
