import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { inspectAdminStaticAssets } from "./admin-static-assets.mjs";
import { findStaticImportCycles } from "./admin-client-import-graph.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
const clientRoot = resolve(workspaceRoot, "apps/admin-v2/dist/client");

// These literals belong to the relational provider implementations and must
// never appear in browser output. Their presence means an isomorphic route or
// UI component reached across the server/database boundary through a barrel.
const SERVER_DATABASE_MARKERS = [
  "x-turso-encryption-key",
  "D1 database binding (env.DB) is not available",
  "DATABASE_PROVIDER must be one of",
  "drizzle:SQLiteInlineForeignKeys",
  "SQLiteBlobBuffer",
];

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(path)));
    } else if (extname(entry.name) === ".js") {
      files.push(path);
    }
  }

  return files;
}

const violations = [];
const javaScriptFiles = await collectJavaScriptFiles(clientRoot);
const browserSources = new Map();
for (const file of javaScriptFiles) {
  const source = await readFile(file, "utf8");
  browserSources.set(file, source);
  const markers = SERVER_DATABASE_MARKERS.filter((marker) => source.includes(marker));
  if (markers.length > 0) {
    violations.push({ file: relative(workspaceRoot, file), markers });
  }
}

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error("Admin browser bundle contains server database code:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.markers.join(", ")}`);
  }
  console.error(
    "Import browser-safe leaf modules instead of server-heavy @scalius/core module barrels.",
  );
} else {
  console.log("Admin browser/server bundle boundary: OK");
}

const staticImportCycles = findStaticImportCycles(browserSources);
if (staticImportCycles.length > 0) {
  failed = true;
  console.error("Admin browser bundle contains circular static chunk imports:");
  for (const cycle of staticImportCycles) {
    console.error(`- ${cycle.map((file) => relative(workspaceRoot, file)).join(" -> ")}`);
  }
  console.error(
    "Keep strongly connected modules in one chunk; forced size splitting can break ESM initialization.",
  );
} else {
  console.log("Admin browser static chunk graph: acyclic");
}

const staticAssetReport = inspectAdminStaticAssets({ rootDir: workspaceRoot });
if (!staticAssetReport.ok || !staticAssetReport.distPresent) {
  failed = true;
  console.error("Admin static asset cache boundary failed:");
  for (const error of staticAssetReport.errors) console.error(`- ${error}`);
  if (!staticAssetReport.distPresent) {
    console.error("- apps/admin-v2/dist/client is missing.");
  }
} else {
  console.log(
    `Admin immutable static assets: OK (${staticAssetReport.scripts} JS, ${staticAssetReport.styles} CSS; ${staticAssetReport.copiedPublicScriptsAndStyles} public script/style preserved)`,
  );
}

if (failed) process.exitCode = 1;
