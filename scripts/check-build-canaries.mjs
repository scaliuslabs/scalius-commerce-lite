#!/usr/bin/env node
/**
 * Builds apps with synthetic canary env values and proves none reach dist.
 *
 * Each app is copied (without node_modules, build output or any local env
 * file) into a temporary overlay of the repository. The copy gets canary
 * `.dev.vars` and `.env*` files, the build process gets canary values for the
 * installed secret names, and the storefront copy gets a probe route that
 * reads them through `import.meta.env`. The app is then built with its normal
 * bundler and scripts/check-dist-secrets.mjs must find no canary and no
 * inlined env. The real app directory and its local env files are never read
 * or written; the overlay is deleted afterwards.
 *
 * Usage: node scripts/check-build-canaries.mjs [storefront|api|admin-v2]...
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { INSTALLED_SECRET_NAMES, KNOWN_SECRET_NAMES, checkAppDist, isLocalEnvFileName } from "./check-dist-secrets.mjs";

const root = resolve(import.meta.dirname, "..");
const ENV_FILES = [".dev.vars", ".env", ".env.local", ".env.production", ".env.production.local"];
const SKIPPED_ROOT_ENTRIES = new Set(["apps", ".git", ".claude", ".wrangler", ".turbo"]);
const SKIPPED_APP_ENTRIES = new Set(["node_modules", "dist", ".astro", ".wrangler", ".turbo"]);

// Build steps: [script in the app] or [package, bin, ...args]. Bundlers run
// straight from the app's node_modules with node: `pnpm exec` inside the
// overlay would run a dependency-status install against the symlinked real
// node_modules.
export const canaryApps = {
  storefront: {
    // `astro check` is the typecheck step; the bundle is what matters here.
    build: [["scripts/generate-build-id.js"], ["astro", "astro", "build"]],
    probe: {
      path: "src/pages/build-canary-probe.ts",
      source: [
        "// Build canary probe (scripts/check-build-canaries.mjs); never committed.",
        "export const prerender = false;",
        "export function GET() {",
        "  return new Response(JSON.stringify([",
        "    import.meta.env.SCALIUS_SECRET,",
        "    import.meta.env.CREDENTIAL_ENCRYPTION_KEY,",
        "    import.meta.env.API_TOKEN,",
        "    import.meta.env.SCALIUS_CANARY_PLAIN,",
        "    import.meta.env.PUBLIC_SCALIUS_CANARY,",
        "    Object.keys(import.meta.env),",
        "  ]));",
        "}",
        "",
      ].join("\n"),
    },
  },
  api: {
    build: [["wrangler", "wrangler", "deploy", "--dry-run", "--outdir", "dist"]],
    // wrangler.jsonc serves ../admin-v2/dist; the dry run only needs it to exist.
    siblingPlaceholders: { "admin-v2": { "dist/index.html": "<!doctype html>\n" } },
  },
  "admin-v2": {
    build: [["vite", "vite", "build"]],
  },
};

/** Resolves a build step to [script path, args]: a script in the app, or a package bin. */
function stepScript(appSource, [first, ...rest]) {
  if (first.includes("/")) return [first, rest];
  const [bin, ...args] = rest;
  const manifestPath = createRequire(join(appSource, "package.json")).resolve(`${first}/package.json`);
  const { bin: bins } = createRequire(import.meta.url)(manifestPath);
  return [join(dirname(manifestPath), typeof bins === "string" ? bins : bins[bin]), args];
}

function linkEntries(fromDir, toDir, skip) {
  for (const entry of readdirSync(fromDir)) {
    if (skip.has(entry)) continue;
    symlinkSync(join(fromDir, entry), join(toDir, entry));
  }
}

/** Removes the overlay without following any symlink into the real repository. */
export function removeOverlay(dir) {
  if (!lstatSync(dir, { throwIfNoEntry: false })) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) unlinkSync(path);
    else if (stat.isDirectory()) removeOverlay(path);
    else unlinkSync(path);
  }
  rmdirSync(dir);
}

export function canaryEnvFile(values) {
  return `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

/** Builds one app in an overlay with canaries. Returns violation strings (names only). */
export function runCanaryBuild(app, { log = console.log } = {}) {
  const spec = canaryApps[app];
  if (!spec) throw new Error(`Unknown app ${JSON.stringify(app)}; use ${Object.keys(canaryApps).join(", ")}.`);
  const token = randomBytes(6).toString("hex");
  const canary = (label) => `SCALIUS_BUILD_CANARY_${token}_${label}`;
  const overlay = mkdtempSync(join(tmpdir(), "scalius-build-canary-"));
  try {
    linkEntries(root, overlay, SKIPPED_ROOT_ENTRIES);
    mkdirSync(join(overlay, "apps"));
    for (const sibling of readdirSync(join(root, "apps"))) {
      if (sibling === app) continue;
      const placeholder = spec.siblingPlaceholders?.[sibling];
      if (!placeholder) {
        symlinkSync(join(root, "apps", sibling), join(overlay, "apps", sibling));
        continue;
      }
      for (const [file, text] of Object.entries(placeholder)) {
        mkdirSync(join(overlay, "apps", sibling, file, ".."), { recursive: true });
        writeFileSync(join(overlay, "apps", sibling, file), text);
      }
    }
    const source = join(root, "apps", app);
    const appDir = join(overlay, "apps", app);
    mkdirSync(appDir);
    for (const entry of readdirSync(source)) {
      if (SKIPPED_APP_ENTRIES.has(entry) || isLocalEnvFileName(entry)) continue;
      cpSync(join(source, entry), join(appDir, entry), {
        recursive: true,
        filter: (path) => !isLocalEnvFileName(basename(path)),
      });
    }
    symlinkSync(join(source, "node_modules"), join(appDir, "node_modules"));

    const fileNames = [...new Set([...KNOWN_SECRET_NAMES, "SCALIUS_CANARY_PLAIN", "PUBLIC_SCALIUS_CANARY", "VITE_SCALIUS_CANARY"])];
    const canaries = [];
    for (const file of ENV_FILES) {
      const values = Object.fromEntries(fileNames.map((name) => [name, canary(`${file.replace(/\W/g, "")}_${name}`)]));
      canaries.push(...Object.values(values));
      writeFileSync(join(appDir, file), canaryEnvFile(values));
    }
    const shellValues = Object.fromEntries(INSTALLED_SECRET_NAMES.map((name) => [name, canary(`shell_${name}`)]));
    canaries.push(...Object.values(shellValues));
    if (spec.probe) writeFileSync(join(appDir, spec.probe.path), spec.probe.source);

    log(`▶ Canary build: ${app}`);
    for (const step of spec.build) {
      const [script, args] = stepScript(source, step);
      execFileSync(process.execPath, [script, ...args], {
        cwd: appDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...shellValues, NODE_ENV: "production" },
        maxBuffer: 64 * 1024 * 1024,
      });
    }
    const distDir = join(appDir, "dist");
    const built = existsSync(distDir) ? readdirSync(distDir, { recursive: true }).map(String) : [];
    if (built.length === 0) return [`${app}: canary build produced no dist output`];
    if (spec.probe && !built.some((file) => file.includes(basename(spec.probe.path, ".ts")))) {
      return [`${app}: the canary probe route was not bundled`];
    }
    // Every canary is a whole-token substring check; the common prefix alone catches partial copies.
    return checkAppDist(appDir, { canaries: [canary(""), ...canaries] })
      .map((violation) => `${app}: ${violation.replace(/^.*?apps\//, "apps/")}`);
  } finally {
    removeOverlay(overlay);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const apps = process.argv.slice(2);
  const violations = [];
  for (const app of apps.length > 0 ? apps : Object.keys(canaryApps)) {
    try {
      violations.push(...runCanaryBuild(app));
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n");
      violations.push(`${app}: canary build failed: ${error.message.split("\n")[0]}${output ? `\n${output}` : ""}`);
    }
  }
  if (violations.length > 0) {
    console.error("Build canary check failed:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log("Build canary check: OK (no canary or inlined env in any dist output)");
}
