#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (
      ![".ts", ".tsx"].includes(extname(entry.name)) ||
      entry.name.endsWith(".d.ts") ||
      entry.name.includes(".test.")
    ) return [];
    return [path];
  });
}

const rules = [
  ["packages/core/src/auth/auth.ts", ["let cachedAuth", "cachedEnvSignature"]],
  ["packages/core/src/auth/rbac/auto-seed.ts", ["let seedingPromise", "let seedingChecked"]],
  ["packages/core/src/auth/rbac/helpers.ts", ["const permissionCache = new Map"]],
  ["packages/core/src/integrations/firebase/admin.ts", ["let fcmInstance"]],
  ["packages/core/src/integrations/storage.ts", ["let _publicUrl", "initPublicMediaUrl"]],
  ["packages/core/src/integrations/email/provider.ts", ["let activeProviderName"]],
  ["packages/core/src/modules/delivery/pathao-location-import.ts", ["let cachedToken"]],
  ["packages/core/src/modules/payments/stripe.ts", ["let _stripe", "let _stripeKey"]],
  ["packages/core/src/modules/payments/polar.ts", ["let _cachedClient", "let _cachedClientKey"]],
  ["apps/api/src/utils/kv-cache.ts", ["new InMemoryCache", "const memCache"]],
];

const failures = [];
for (const file of [
  ...sourceFiles(resolve(root, "apps/api/src")),
  ...sourceFiles(resolve(root, "packages/core/src")),
  ...sourceFiles(resolve(root, "packages/database/src")),
]) {
  const relativePath = relative(root, file);
  const sourceText = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    ) {
      const names = statement.declarationList.declarations
        .map((declaration) => declaration.name.getText(source))
        .join(", ");
      failures.push(`${relativePath}: mutable module variable ${JSON.stringify(names)}`);
    }
  }
}

for (const [relativePath, forbiddenValues] of rules) {
  const source = readFileSync(resolve(root, relativePath), "utf8");
  for (const forbidden of forbiddenValues) {
    if (source.includes(forbidden)) {
      failures.push(`${relativePath}: request-scoped state marker ${JSON.stringify(forbidden)}`);
    }
  }
}

const appPath = "apps/api/src/runtime/base-app.ts";
const appSource = readFileSync(resolve(root, appPath), "utf8");
if (
  !appSource.includes("withPublicMediaUrl(") ||
  !appSource.includes("() => next()")
) {
  failures.push(`${appPath}: API requests must establish the async media presentation context`);
}

const adminServerPath = "apps/admin-v2/src/server.ts";
const adminServerSource = readFileSync(resolve(root, adminServerPath), "utf8");
if (
  !adminServerSource.includes("withPublicMediaUrl(") ||
  !adminServerSource.includes("() => handler.fetch(request)")
) {
  failures.push(`${adminServerPath}: admin requests must establish the async media presentation context`);
}

if (failures.length > 0) {
  console.error("Worker request-isolation boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Worker request-isolation boundary check: OK");
}
