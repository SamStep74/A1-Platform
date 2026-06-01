"use strict";

const { spawn } = require("node:child_process");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env || {}) },
      cwd: options.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function pgDump(databaseUrl, outputFile, runner = runCommand) {
  return runner("pg_dump", ["-Fc", "--no-owner", "--dbname", databaseUrl, "--file", outputFile]);
}

async function pgRestore(databaseUrl, dumpFile, runner = runCommand) {
  return runner("pg_restore", ["--clean", "--if-exists", "--no-owner", "--dbname", databaseUrl, dumpFile]);
}

module.exports = { runCommand, pgDump, pgRestore };
