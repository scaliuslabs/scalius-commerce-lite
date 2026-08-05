import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const clientRoot = resolve(workspaceRoot, "apps/admin-v2/dist/client");

// These literals belong to the relational provider implementations and must
// never appear in browser output. Their presence means an isomorphic route or
// UI component reached across the server/database boundary through a barrel.
const SERVER_DATABASE_MARKERS = [
  "x-turso-encryption-key",
  "D1 database binding (env.DB) is not available",
  "DATABASE_PROVIDER must be one of",
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
for (const file of await collectJavaScriptFiles(clientRoot)) {
  const source = await readFile(file, "utf8");
  const markers = SERVER_DATABASE_MARKERS.filter((marker) => source.includes(marker));
  if (markers.length > 0) {
    violations.push({ file: relative(workspaceRoot, file), markers });
  }
}

if (violations.length > 0) {
  console.error("Admin browser bundle contains server database code:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.markers.join(", ")}`);
  }
  console.error(
    "Import browser-safe leaf modules instead of server-heavy @scalius/core module barrels.",
  );
  process.exitCode = 1;
} else {
  console.log("Admin browser/server bundle boundary: OK");
}
