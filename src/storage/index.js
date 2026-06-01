"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { getConfig } = require("../config");
const { normalizeSlug } = require("../naming");

const PRODUCT_CODES = new Set(["platform", "studio", "hayhashvapah", "crm"]);

function normalizeProduct(productCode) {
  const product = String(productCode || "platform").trim().toLowerCase();
  if (!PRODUCT_CODES.has(product)) throw new Error(`Unknown storage product: ${productCode}`);
  return product;
}

function normalizeObjectName(key) {
  const clean = String(key || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!clean || clean.includes("../") || clean === ".." || clean.startsWith("..")) {
    throw new Error(`Unsafe object key: ${key}`);
  }
  return clean;
}

function tenantObjectKey(tenantSlug, productCode, key) {
  return `tenants/${normalizeSlug(tenantSlug)}/${normalizeProduct(productCode)}/${normalizeObjectName(key)}`;
}

async function ensureParent(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function copyDirContents(sourceDir, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true });
  if (!fs.existsSync(sourceDir)) return 0;
  let count = 0;
  async function walk(src, dst) {
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await walk(s, d);
      } else if (entry.isFile()) {
        await ensureParent(d);
        await fsp.copyFile(s, d);
        count += 1;
      }
    }
  }
  await walk(sourceDir, targetDir);
  return count;
}

class LocalTenantStorage {
  constructor(options = {}) {
    this.root = path.resolve(options.root || getConfig().storage.localRoot);
    this.bucket = options.bucket || "a1-documents";
  }

  fullPath(objectKey) {
    return path.join(this.root, this.bucket, normalizeObjectName(objectKey));
  }

  async putObject(tenantSlug, productCode, key, body) {
    const objectKey = tenantObjectKey(tenantSlug, productCode, key);
    const target = this.fullPath(objectKey);
    await ensureParent(target);
    await fsp.writeFile(target, body);
    return { key: objectKey };
  }

  async getObject(tenantSlug, productCode, key) {
    return fsp.readFile(this.fullPath(tenantObjectKey(tenantSlug, productCode, key)));
  }

  async deleteObject(tenantSlug, productCode, key) {
    await fsp.rm(this.fullPath(tenantObjectKey(tenantSlug, productCode, key)), { force: true });
  }

  async listObjects(tenantSlug, productCode = "") {
    const prefix = productCode
      ? `tenants/${normalizeSlug(tenantSlug)}/${normalizeProduct(productCode)}/`
      : `tenants/${normalizeSlug(tenantSlug)}/`;
    const base = this.fullPath(prefix);
    if (!fs.existsSync(base)) return [];
    const keys = [];
    async function walk(dir) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) keys.push(path.relative(path.join(base, "..", ".."), full).split(path.sep).join("/"));
      }
    }
    await walk(base);
    return keys.sort();
  }

  async syncPrefixToDir(tenantSlug, targetDir) {
    const sourceDir = this.fullPath(`tenants/${normalizeSlug(tenantSlug)}/`);
    return copyDirContents(sourceDir, targetDir);
  }

  async syncDirToPrefix(tenantSlug, sourceDir) {
    const targetDir = this.fullPath(`tenants/${normalizeSlug(tenantSlug)}/`);
    return copyDirContents(sourceDir, targetDir);
  }

  async countTenantObjects(tenantSlug) {
    return (await this.listObjects(tenantSlug)).length;
  }
}

class S3TenantStorage {
  constructor(options = {}) {
    const { S3Client } = require("@aws-sdk/client-s3");
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      }
    });
  }

  async putObject(tenantSlug, productCode, key, body) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const objectKey = tenantObjectKey(tenantSlug, productCode, key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: body }));
    return { key: objectKey };
  }

  async getObject(tenantSlug, productCode, key) {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: tenantObjectKey(tenantSlug, productCode, key)
    }));
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async deleteObject(tenantSlug, productCode, key) {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: tenantObjectKey(tenantSlug, productCode, key)
    }));
  }

  async listObjects(tenantSlug, productCode = "") {
    const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
    const prefix = productCode
      ? `tenants/${normalizeSlug(tenantSlug)}/${normalizeProduct(productCode)}/`
      : `tenants/${normalizeSlug(tenantSlug)}/`;
    const keys = [];
    let ContinuationToken;
    do {
      const result = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken
      }));
      for (const item of result.Contents || []) keys.push(item.Key);
      ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);
    return keys.sort();
  }

  async syncPrefixToDir(tenantSlug, targetDir) {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    await fsp.mkdir(targetDir, { recursive: true });
    const keys = await this.listObjects(tenantSlug);
    for (const key of keys) {
      const relative = key.replace(`tenants/${normalizeSlug(tenantSlug)}/`, "");
      const target = path.join(targetDir, relative);
      await ensureParent(target);
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      await pipeline(result.Body, fs.createWriteStream(target));
    }
    return keys.length;
  }

  async syncDirToPrefix(tenantSlug, sourceDir) {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    let count = 0;
    async function walk(dir, files = []) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, files);
        else if (entry.isFile()) files.push(full);
      }
      return files;
    }
    if (!fs.existsSync(sourceDir)) return 0;
    for (const file of await walk(sourceDir)) {
      const relative = path.relative(sourceDir, file).split(path.sep).join("/");
      const key = `tenants/${normalizeSlug(tenantSlug)}/${normalizeObjectName(relative)}`;
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(file)
      }));
      count += 1;
    }
    return count;
  }

  async countTenantObjects(tenantSlug) {
    return (await this.listObjects(tenantSlug)).length;
  }
}

function createStorage(config = getConfig().storage) {
  if (config.driver === "local") {
    return new LocalTenantStorage({ root: config.localRoot, bucket: config.bucket });
  }
  return new S3TenantStorage(config);
}

module.exports = {
  PRODUCT_CODES,
  tenantObjectKey,
  LocalTenantStorage,
  S3TenantStorage,
  createStorage
};
