#!/usr/bin/env node

import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "..");

export const measuredRoutes = [
  { id: "__root__", label: "Document shell", maxJavaScript: 4, maxBrotliKiB: 145 },
  { id: "/admin", label: "Admin shell", maxJavaScript: 20, maxBrotliKiB: 175 },
  { id: "/admin/", label: "Dashboard", maxJavaScript: 28, maxBrotliKiB: 180 },
  { id: "/admin/products/", label: "Products", maxJavaScript: 40, maxBrotliKiB: 210 },
  { id: "/admin/orders/", label: "Orders", maxJavaScript: 42, maxBrotliKiB: 225 },
  { id: "/admin/customers/", label: "Customers", maxJavaScript: 38, maxBrotliKiB: 205 },
  { id: "/admin/inventory/", label: "Inventory", maxJavaScript: 42, maxBrotliKiB: 210 },
  { id: "/admin/discounts/", label: "Discounts", maxJavaScript: 38, maxBrotliKiB: 200 },
  { id: "/admin/analytics/", label: "Analytics", maxJavaScript: 40, maxBrotliKiB: 205 },
  { id: "/admin/media", label: "Media", maxJavaScript: 28, maxBrotliKiB: 180 },
];

const forbiddenPrincipalChunkNames = [
  /^html2pdf-.*\.js$/,
  /^TiptapEditor-.*\.js$/,
  /^media-theme-.*\.js$/,
  // html5-qrcode currently emits its browser engine under this name. The
  // scanner route loads it dynamically; principal admin pages must not.
  /^esm-.*\.js$/,
];

function parseArguments(argv) {
  const result = { check: false, repoRoot: defaultRepoRoot };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      result.check = true;
      continue;
    }
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      result.repoRoot = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return result;
}

function findStartManifest(serverAssetDirectory) {
  const candidates = readdirSync(serverAssetDirectory).filter(
    (fileName) =>
      fileName.startsWith("_tanstack-start-manifest_") && fileName.endsWith(".js"),
  );

  if (candidates.length !== 1) {
    throw new Error(
      `Expected one TanStack Start manifest in ${serverAssetDirectory}, found ${candidates.length}`,
    );
  }

  return join(serverAssetDirectory, candidates[0]);
}

function routeHierarchy(routeId) {
  if (routeId === "__root__") return ["__root__"];
  if (routeId === "/admin") return ["__root__", "/admin"];
  return ["__root__", "/admin", routeId];
}

export function collectRouteJavaScript(routes, routeId) {
  const routeIds = routeHierarchy(routeId);
  const files = new Set();

  for (const hierarchyRouteId of routeIds) {
    const route = routes[hierarchyRouteId];
    if (!route) throw new Error(`Route ${hierarchyRouteId} is absent from the Start manifest`);

    for (const preload of route.preloads ?? []) {
      if (preload.endsWith(".js")) files.add(preload);
    }
  }

  return [...files].sort();
}

function measureFiles(clientDirectory, files, compressionCache) {
  let rawBytes = 0;
  let brotliBytes = 0;

  for (const file of files) {
    const filePath = join(clientDirectory, file);
    if (!existsSync(filePath)) throw new Error(`Manifest asset does not exist: ${filePath}`);

    rawBytes += statSync(filePath).size;
    let compressedSize = compressionCache.get(filePath);
    if (compressedSize === undefined) {
      compressedSize = brotliCompressSync(readFileSync(filePath), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      }).length;
      compressionCache.set(filePath, compressedSize);
    }
    brotliBytes += compressedSize;
  }

  return { rawBytes, brotliBytes };
}

function formatKiB(bytes) {
  return (bytes / 1024).toFixed(1);
}

export async function analyzeAdminClientBundle(repoRoot = defaultRepoRoot) {
  const appDirectory = join(repoRoot, "apps/admin-v2");
  const clientDirectory = join(appDirectory, "dist/client");
  const serverAssetDirectory = join(appDirectory, "dist/server/assets/immutable");
  const manifestPath = findStartManifest(serverAssetDirectory);
  const manifestModule = await import(`${pathToFileURL(manifestPath).href}?report=${Date.now()}`);
  const routes = manifestModule.tsrStartManifest().routes;
  const compressionCache = new Map();

  return measuredRoutes.map((route) => {
    const files = collectRouteJavaScript(routes, route.id);
    return {
      ...route,
      files,
      ...measureFiles(clientDirectory, files, compressionCache),
    };
  });
}

export function validateAdminClientBundle(measurements) {
  const failures = [];

  for (const measurement of measurements) {
    if (measurement.files.length > measurement.maxJavaScript) {
      failures.push(
        `${measurement.label} has ${measurement.files.length} JavaScript assets (budget ${measurement.maxJavaScript})`,
      );
    }

    const brotliKiB = measurement.brotliBytes / 1024;
    if (brotliKiB > measurement.maxBrotliKiB) {
      failures.push(
        `${measurement.label} is ${brotliKiB.toFixed(1)} KiB Brotli (budget ${measurement.maxBrotliKiB} KiB)`,
      );
    }

    for (const file of measurement.files) {
      const fileName = file.split("/").at(-1) ?? file;
      if (forbiddenPrincipalChunkNames.some((pattern) => pattern.test(fileName))) {
        failures.push(`${measurement.label} eagerly loads heavy lazy chunk ${fileName}`);
      }
    }
  }

  return failures;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const measurements = await analyzeAdminClientBundle(options.repoRoot);

  console.log("Admin client direct-route preload closure:");
  console.table(
    measurements.map((measurement) => ({
      route: measurement.label,
      javascript: measurement.files.length,
      "raw KiB": formatKiB(measurement.rawBytes),
      "Brotli KiB": formatKiB(measurement.brotliBytes),
    })),
  );

  if (options.check) {
    const failures = validateAdminClientBundle(measurements);
    if (failures.length > 0) {
      console.error("Admin client bundle budgets failed:");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log("Admin client bundle budgets: OK");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
