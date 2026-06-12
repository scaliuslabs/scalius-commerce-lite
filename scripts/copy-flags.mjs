#!/usr/bin/env node
/**
 * copy-flags.mjs — Copies country flag SVGs into app public directories.
 *
 * Flags are served as static assets from /flags/{XX}.svg, avoiding
 * external requests to GitHub Pages at runtime. The react-phone-number-input
 * component is configured with flagUrl pointing to this local path.
 *
 * Called automatically as a prebuild step via `pnpm build`.
 */

import { cpSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const requiredFlagFiles = ["BD.svg", "GB.svg", "US.svg"];

// Find country-flag-icons/3x2 — pnpm hoists it under .pnpm/ so we search for it
function findFlagDir() {
  // Direct path (npm/yarn flat node_modules)
  const direct = resolve(root, "node_modules", "country-flag-icons", "3x2");
  if (existsSync(direct)) return direct;

  // pnpm strict hoisting: search inside .pnpm/
  const pnpmDir = resolve(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;

  for (const entry of readdirSync(pnpmDir)) {
    if (entry.startsWith("country-flag-icons@")) {
      const candidate = join(pnpmDir, entry, "node_modules", "country-flag-icons", "3x2");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const flagSrc = findFlagDir();
if (!flagSrc) {
  console.error("country-flag-icons not found. Install dependencies before building.");
  process.exit(1);
}

const sourceFlags = readdirSync(flagSrc).filter((file) => file.endsWith(".svg"));
if (sourceFlags.length < 200) {
  console.error(`country-flag-icons source looks incomplete: found ${sourceFlags.length} SVG files.`);
  process.exit(1);
}

for (const file of requiredFlagFiles) {
  if (!existsSync(join(flagSrc, file))) {
    console.error(`country-flag-icons source is missing required flag: ${file}`);
    process.exit(1);
  }
}

const targets = [
  resolve(root, "apps", "storefront", "public", "flags"),
  resolve(root, "apps", "admin-v2", "public", "flags"),
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(flagSrc, target, { recursive: true });

  for (const file of requiredFlagFiles) {
    if (!existsSync(join(target, file))) {
      console.error(`Flag copy failed for ${target}: missing ${file}`);
      process.exit(1);
    }
  }
}

console.log(`Copied ${sourceFlags.length} flag SVGs to ${targets.length} app public directories`);
