#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST_ROOT="${A1_VM_IMPORT_DIR:-/opt/a1/imports/product-sources}"
CRM_SLUG="${1:-}"

usage() {
  cat <<'USAGE'
Usage:
  infra/vm/copy-product-sources.sh <slug>

Copies source data for one tenant into the platform import root.
Use -h|--help for this help text.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$CRM_SLUG" ]]; then
  echo "Missing tenant slug. Usage: infra/vm/copy-product-sources.sh <slug>" >&2
  exit 2
fi

STUDIO_DATA_DIR="${A1_STUDIO_DATA_DIR:-${ARMOSPHERA_ONE_DATA_DIR:-$HOME/Library/Application Support/ArmospheraOneClaude}}"
STUDIO_DB="${A1_STUDIO_SQLITE:-${ARMOSPHERA_ONE_DB:-$STUDIO_DATA_DIR/armosphera-one.db}}"
HAYHASHVAPAH_DATA_DIR="${A1_HAYHASHVAPAH_DATA_DIR:-$HOME/Library/Application Support/HayHashvapahWebClaude/data}"
HAYHASHVAPAH_DB="${A1_HAYHASHVAPAH_SQLITE:-$HAYHASHVAPAH_DATA_DIR/hayhashvapah.sqlite}"
CRM_REPO_DIR="${A1_CRM_REPO_DIR:-$HOME/dev/A1-SMB-CRM-HY}"
CRM_DATA_DIR="${A1_CRM_DATA_DIR:-$CRM_REPO_DIR/data}"
CRM_TENANTS_DIR="${A1_CRM_TENANTS_DIR:-$CRM_DATA_DIR/tenants}"
CRM_RECORDS_DIR="${A1_CRM_RECORDS_DIR:-$CRM_DATA_DIR/records}"
CRM_GENERATE_DEMO="${A1_CRM_GENERATE_DEMO:-1}"
GENERATED_CRM_ROOT="${A1_GENERATED_CRM_ROOT:-/tmp/a1-crm-source-$CRM_SLUG}"
CRM_TENANT_SOURCE_EFFECTIVE="$CRM_TENANTS_DIR/${CRM_SLUG:-<slug>}.json"
CRM_RECORDS_SOURCE_EFFECTIVE="$CRM_RECORDS_DIR/${CRM_SLUG:-<slug>}.json"
CRM_SOURCE_MODE="configured"
MANIFEST_FILE=""

cleanup() {
  if [[ -n "$MANIFEST_FILE" && -f "$MANIFEST_FILE" ]]; then
    rm -f "$MANIFEST_FILE"
  fi
}
trap cleanup EXIT

put_if_exists() {
  local source="$1"
  local destination="$2"
  if [[ -e "$source" ]]; then
    "$ROOT/infra/vm/a1-vm.sh" put "$source" "$destination"
    echo "copied: $source -> $destination"
  else
    echo "missing, skipped: $source" >&2
  fi
}

put_sqlite_bundle() {
  local source="$1"
  local destination="$2"
  put_if_exists "$source" "$destination"
  put_if_exists "$source-wal" "$destination-wal"
  put_if_exists "$source-shm" "$destination-shm"
}

generate_crm_demo_source() {
  if [[ -z "$CRM_SLUG" || "$CRM_GENERATE_DEMO" != "1" ]]; then
    return 1
  fi
  if [[ ! -f "$CRM_REPO_DIR/lib/crmGenerator.js" || ! -f "$CRM_REPO_DIR/lib/recordStore.js" ]]; then
    return 1
  fi

  A1_CRM_REPO_DIR="$CRM_REPO_DIR" \
  A1_CRM_SLUG="$CRM_SLUG" \
  A1_GENERATED_CRM_ROOT="$GENERATED_CRM_ROOT" \
  node <<'NODE'
const path = require("node:path");
const fs = require("node:fs/promises");

const repoDir = process.env.A1_CRM_REPO_DIR;
const slug = process.env.A1_CRM_SLUG;
const root = process.env.A1_GENERATED_CRM_ROOT;
const { generateCrmBlueprint } = require(path.join(repoDir, "lib", "crmGenerator"));
const { seedRecords } = require(path.join(repoDir, "lib", "recordStore"));

(async () => {
  const tenantDir = path.join(root, "tenants");
  const recordsDir = path.join(root, "records");
  await fs.mkdir(tenantDir, { recursive: true });
  await fs.mkdir(recordsDir, { recursive: true });
  const result = await generateCrmBlueprint({
    businessName: "Demo Client",
    slug,
    sector: "services",
    region: "Yerevan",
    languages: ["hy", "en", "ru"],
    channels: ["phone", "whatsapp", "website"],
    customerType: "B2B and B2C",
    monthlyLeads: 120,
    averageDeal: 45000,
    currency: "AMD",
    teamSize: 8,
    roles: ["Owner", "Sales Manager", "Operator", "Accountant"],
    integrations: ["WhatsApp", "Email", "A1 HayHashvapah"],
    priority: "portable A1 CRM tenant import drill"
  }, { baseDomain: "a1suite.local" });
  const generatedSlug = result.blueprint.deployment.slug;
  const records = seedRecords(result.blueprint, generatedSlug);
  await fs.writeFile(path.join(tenantDir, `${generatedSlug}.json`), `${JSON.stringify(result.blueprint, null, 2)}\n`);
  await fs.writeFile(path.join(recordsDir, `${generatedSlug}.json`), `${JSON.stringify(records, null, 2)}\n`);
  process.stdout.write(`generated CRM ${result.source} source for ${generatedSlug} at ${root}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
NODE
}

copy_crm_sources() {
  if [[ -z "$CRM_SLUG" ]]; then
    echo "CRM slug not provided; pass a slug to copy CRM JSON sources." >&2
    return 0
  fi

  local tenant_source="$CRM_TENANTS_DIR/$CRM_SLUG.json"
  local records_source="$CRM_RECORDS_DIR/$CRM_SLUG.json"
  if [[ (! -e "$tenant_source" || ! -e "$records_source") && "$CRM_GENERATE_DEMO" == "1" ]]; then
    if generate_crm_demo_source; then
      tenant_source="$GENERATED_CRM_ROOT/tenants/$CRM_SLUG.json"
      records_source="$GENERATED_CRM_ROOT/records/$CRM_SLUG.json"
      CRM_SOURCE_MODE="generated-demo"
    fi
  fi

  CRM_TENANT_SOURCE_EFFECTIVE="$tenant_source"
  CRM_RECORDS_SOURCE_EFFECTIVE="$records_source"
  put_if_exists "$tenant_source" "$DEST_ROOT/crm/tenants/$CRM_SLUG.json"
  put_if_exists "$records_source" "$DEST_ROOT/crm/records/$CRM_SLUG.json"
}

write_source_manifest() {
  MANIFEST_FILE="$(mktemp "${TMPDIR:-/tmp}/a1-product-source-manifest.XXXXXX.json")"
  A1_MANIFEST_FILE="$MANIFEST_FILE" \
  A1_DEST_ROOT="$DEST_ROOT" \
  A1_CRM_SLUG="$CRM_SLUG" \
  A1_STUDIO_DATA_DIR_VALUE="$STUDIO_DATA_DIR" \
  A1_STUDIO_SQLITE_VALUE="$STUDIO_DB" \
  A1_HAYHASHVAPAH_DATA_DIR_VALUE="$HAYHASHVAPAH_DATA_DIR" \
  A1_HAYHASHVAPAH_SQLITE_VALUE="$HAYHASHVAPAH_DB" \
  A1_CRM_REPO_DIR_VALUE="$CRM_REPO_DIR" \
  A1_CRM_DATA_DIR_VALUE="$CRM_DATA_DIR" \
  A1_CRM_TENANTS_DIR_VALUE="$CRM_TENANTS_DIR" \
  A1_CRM_RECORDS_DIR_VALUE="$CRM_RECORDS_DIR" \
  A1_CRM_TENANT_SOURCE_VALUE="$CRM_TENANT_SOURCE_EFFECTIVE" \
  A1_CRM_RECORDS_SOURCE_VALUE="$CRM_RECORDS_SOURCE_EFFECTIVE" \
  A1_CRM_SOURCE_MODE_VALUE="$CRM_SOURCE_MODE" \
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const posix = path.posix;

const destRoot = process.env.A1_DEST_ROOT;
const slug = process.env.A1_CRM_SLUG || "<slug>";
const manifest = {
  format_version: "1",
  generated_at: new Date().toISOString(),
  destination_root: destRoot,
  tenant_slug: slug,
  sources: {
    studio: {
      data_dir: process.env.A1_STUDIO_DATA_DIR_VALUE,
      sqlite: process.env.A1_STUDIO_SQLITE_VALUE,
      remote_sqlite: posix.join(destRoot, "studio", "armosphera-one.db")
    },
    hayhashvapah: {
      data_dir: process.env.A1_HAYHASHVAPAH_DATA_DIR_VALUE,
      sqlite: process.env.A1_HAYHASHVAPAH_SQLITE_VALUE,
      remote_sqlite: posix.join(destRoot, "hayhashvapah", "hayhashvapah.sqlite")
    },
    crm: {
      source_mode: process.env.A1_CRM_SOURCE_MODE_VALUE,
      repo_dir: process.env.A1_CRM_REPO_DIR_VALUE,
      data_dir: process.env.A1_CRM_DATA_DIR_VALUE,
      tenants_dir: process.env.A1_CRM_TENANTS_DIR_VALUE,
      records_dir: process.env.A1_CRM_RECORDS_DIR_VALUE,
      tenant_json: process.env.A1_CRM_TENANT_SOURCE_VALUE,
      records_json: process.env.A1_CRM_RECORDS_SOURCE_VALUE,
      remote_tenant_json: posix.join(destRoot, "crm", "tenants", `${slug}.json`),
      remote_records_json: posix.join(destRoot, "crm", "records", `${slug}.json`)
    }
  }
};

fs.writeFileSync(process.env.A1_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  put_if_exists "$MANIFEST_FILE" "$DEST_ROOT/source-manifest.json"
}

put_sqlite_bundle "$STUDIO_DB" "$DEST_ROOT/studio/armosphera-one.db"
put_sqlite_bundle "$HAYHASHVAPAH_DB" "$DEST_ROOT/hayhashvapah/hayhashvapah.sqlite"
copy_crm_sources
write_source_manifest

cat <<EOF

VM import paths:
  Source manifest:     $DEST_ROOT/source-manifest.json
  Studio SQLite:       $DEST_ROOT/studio/armosphera-one.db
  HayHashvapah SQLite: $DEST_ROOT/hayhashvapah/hayhashvapah.sqlite
  CRM tenant JSON:     $DEST_ROOT/crm/tenants/<slug>.json
  CRM records JSON:    $DEST_ROOT/crm/records/<slug>.json

Source overrides:
  A1_STUDIO_DATA_DIR=$STUDIO_DATA_DIR
  A1_STUDIO_SQLITE=$STUDIO_DB
  ARMOSPHERA_ONE_DATA_DIR=$STUDIO_DATA_DIR
  ARMOSPHERA_ONE_DB=$STUDIO_DB
  A1_HAYHASHVAPAH_DATA_DIR=$HAYHASHVAPAH_DATA_DIR
  A1_HAYHASHVAPAH_SQLITE=$HAYHASHVAPAH_DB
  A1_CRM_DATA_DIR=$CRM_DATA_DIR
EOF
