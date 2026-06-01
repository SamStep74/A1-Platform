"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

async function listFiles(root) {
  const files = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files.sort();
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function writeChecksums(root, fileName = "checksums.txt") {
  const checksumPath = path.join(root, fileName);
  const files = (await listFiles(root)).filter((file) => path.resolve(file) !== path.resolve(checksumPath));
  const lines = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    lines.push(`${await sha256File(file)}  ${relative}`);
  }
  await fsp.writeFile(checksumPath, `${lines.join("\n")}\n`, "utf8");
  return checksumPath;
}

async function verifyChecksums(root, fileName = "checksums.txt") {
  const checksumPath = path.join(root, fileName);
  const content = await fsp.readFile(checksumPath, "utf8");
  const checks = [];
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})\s\s(.+)$/);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const [, expected, relative] = match;
    const actual = await sha256File(path.join(root, relative));
    checks.push({ file: relative, ok: actual === expected, expected, actual });
  }
  return checks;
}

module.exports = { listFiles, sha256File, writeChecksums, verifyChecksums };
