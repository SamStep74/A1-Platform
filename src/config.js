"use strict";

const path = require("node:path");

function readEnv(env, name, fallback) {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function replaceDatabaseName(databaseUrl, databaseName) {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function getConfig(env = process.env) {
  const registryUrl = readEnv(
    env,
    "TENANT_REGISTRY_DATABASE_URL",
    "postgresql://a1:a1@127.0.0.1:5432/a1_registry"
  );
  const adminUrl = readEnv(env, "DATABASE_ADMIN_URL", replaceDatabaseName(registryUrl, "postgres"));
  const appDomain = readEnv(env, "APP_DOMAIN", "a1suite.am");
  const localStorageRoot = readEnv(env, "A1_LOCAL_STORAGE_ROOT", path.resolve(process.cwd(), ".a1-storage"));

  return {
    appEnv: readEnv(env, "APP_ENV", "development"),
    appDomain,
    appVersion: readEnv(env, "A1_VERSION", "2026.06.01"),
    apiPort: Number(readEnv(env, "PORT", "4200")),
    registryUrl,
    adminUrl,
    redisUrl: readEnv(env, "REDIS_URL", "redis://127.0.0.1:6379"),
    storage: {
      driver: readEnv(env, "A1_STORAGE_DRIVER", "s3"),
      endpoint: readEnv(env, "S3_ENDPOINT", "http://127.0.0.1:9000"),
      region: readEnv(env, "S3_REGION", "am"),
      bucket: readEnv(env, "S3_BUCKET", "a1-documents"),
      accessKeyId: readEnv(env, "S3_ACCESS_KEY", "a1"),
      secretAccessKey: readEnv(env, "S3_SECRET_KEY", "a1-secret"),
      forcePathStyle: String(readEnv(env, "S3_FORCE_PATH_STYLE", "true")).toLowerCase() !== "false",
      localRoot: localStorageRoot
    },
    backups: {
      bucket: readEnv(env, "BACKUP_BUCKET", "a1-backups"),
      encryptionKey: readEnv(env, "BACKUP_ENCRYPTION_KEY", "")
    }
  };
}

module.exports = { getConfig, replaceDatabaseName };
