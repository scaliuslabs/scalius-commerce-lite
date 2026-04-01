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

import { cpSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

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
  console.warn("⚠ country-flag-icons not found — skipping flag copy. Flags will load from GitHub fallback.");
  process.exit(0);
}

const targets = [
  resolve(root, "apps", "storefront", "public", "flags"),
  resolve(root, "apps", "admin-v2", "public", "flags"),
];

for (const target of targets) {
  mkdirSync(target, { recursive: true });
  cpSync(flagSrc, target, { recursive: true });
}

console.log(`✓ Copied flag SVGs to ${targets.length} app public directories`);
