#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const targetArgs = args.filter((arg) => arg !== "--check");
const defaultTargets = ["apps/api", "apps/admin-v2", "apps/storefront"];

function isForbiddenEnvFile(name) {
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".dev.vars" ||
    name.endsWith(".vars")
  );
}

function collectForbiddenFiles(dir, found = []) {
  if (!existsSync(dir)) return found;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      collectForbiddenFiles(fullPath, found);
      continue;
    }

    if (stat.isFile() && isForbiddenEnvFile(entry)) {
      found.push(fullPath);
    }
  }

  return found;
}

function resolveDistDir(target) {
  const absolute = resolve(root, target);
  return basename(absolute) === "dist" ? absolute : join(absolute, "dist");
}

const targets = targetArgs.length > 0 ? targetArgs : defaultTargets;
const forbiddenFiles = targets.flatMap((target) =>
  collectForbiddenFiles(resolveDistDir(target)),
);

if (forbiddenFiles.length === 0) {
  console.log("No local env files found in app dist outputs.");
  process.exit(0);
}

const relativeFiles = forbiddenFiles.map((file) => relative(root, file));

if (checkOnly) {
  console.error("Local env files found in app dist outputs:");
  for (const file of relativeFiles) console.error(`  - ${file}`);
  console.error("Run the relevant app build or clean-dist-env-files script before deploy.");
  process.exit(1);
}

for (const file of forbiddenFiles) {
  rmSync(file, { force: true });
}

console.log("Removed local env files from app dist outputs:");
for (const file of relativeFiles) console.log(`  - ${file}`);
