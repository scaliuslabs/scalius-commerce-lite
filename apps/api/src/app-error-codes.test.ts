// The sealed app-facing error codes (`@scalius/shared/plugins/app-errors`,
// audit L5) against what the platform produces where an app can see it:
//
//   - the ctx hosts (the bridge and the services behind ctx.objects, ctx.kv,
//     ctx.customFields, ctx.customers, ctx.jobs, ctx.messaging): every code
//     they throw crosses the bridge, so each is sealed;
//   - the app API dispatch (`ctx.api.call`) and its retry contract;
//   - every route module that declares a stable operation: a code it answers
//     is sealed, or listed here as one only its beta routes answer.
//
// Core services behind stable routes refuse with the generic codes and the
// sealed domain codes; a new domain code there is added to the table by hand.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES, isAppErrorCode } from "@scalius/shared/plugins/app-errors";
import { STABLE_OPERATION_IDS } from "@scalius/shared/plugins/app-operations";
import { dispatchRefusalCode } from "./plugins/api-call";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Where a literal becomes an error code. */
const PRODUCERS = [
  /\bnew [A-Z]\w*Error\(\s*\d{3}\s*,\s*["']([a-z][a-z0-9_]*)["']/g,
  /\b(?:refusal|jsonError)\(\s*\d{3}\s*,\s*["']([a-z][a-z0-9_]*)["']/g,
  /\bnew (?:PluginError|ObjectError|PluginPlatformError)\(\s*["']([a-z][a-z0-9_]*)["']/g,
  /\b(?:fail|refuse)\(\s*["']([a-z][a-z0-9_]*)["']\s*,/g,
  /\berror:\s*\{\s*code:\s*["']([a-z][a-z0-9_]*)["']/g,
  // A bridge refusal spelled as it crosses: `[code] message`.
  /\bError\(\s*["'`]\[([a-z][a-z0-9_]*)\] /g,
];

/** The ctx hosts: everything they throw reaches an app's code. */
const CONTEXT_HOSTS = [
  "apps/api/src/plugins/bridge.ts",
  "apps/api/src/plugins/custom-fields.ts",
  "apps/api/src/plugins/customer-roles.ts",
  "apps/api/src/plugins/jobs.ts",
  "apps/api/src/plugins/messaging.ts",
  "apps/api/src/plugins/api-call.ts",
  "apps/api/src/routes/admin/idempotency.ts",
  "packages/core/src/modules/plugins/kv.ts",
  "packages/core/src/modules/objects",
  "packages/plugin-sdk/src/runtime.ts",
  "packages/plugin-sdk/src/testing.ts",
];

/**
 * Codes stable route modules answer only on their beta (dashboard) routes,
 * reviewed: none reaches an app.
 */
const BETA_ROUTE_ONLY = new Set<string>([]);

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((name) => {
    if (name === "node_modules" || name === "generated") return [];
    const child = join(path, name);
    return statSync(join(ROOT, child)).isDirectory() ? files(child) : /\.(ts|tsx)$/.test(name) && !/\.(test|gen)\./.test(name) ? [join(ROOT, child)] : [];
  });
}

function producedCodes(file: string): string[] {
  // Comment lines describe codes; they produce none.
  const text = readFileSync(file, "utf8").replace(/^\s*(?:\/\/|\/?\*).*$/gmu, "");
  return PRODUCERS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!));
}

describe("the sealed app error codes", () => {
  it("are lower_snake with an HTTP status and a meaning", () => {
    for (const [code, entry] of Object.entries(APP_ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(entry.status, code).toBeGreaterThanOrEqual(400);
      expect(entry.status, code).toBeLessThan(600);
      expect(entry.meaning.length, code).toBeGreaterThan(10);
    }
  });

  it("cover every code a ctx host, the app API dispatch or the retry contract produces", () => {
    const unsealed: string[] = [];
    for (const path of CONTEXT_HOSTS) {
      for (const file of files(path)) {
        for (const code of producedCodes(file)) if (!isAppErrorCode(code)) unsealed.push(`${relative(ROOT, file)}: ${code}`);
      }
    }
    expect([...new Set(unsealed)]).toEqual([]);
  });

  it("cover every code a stable operation's route module answers", () => {
    const unsealed: string[] = [];
    let modules = 0;
    for (const file of files("apps/api/src/routes")) {
      const text = readFileSync(file, "utf8");
      const declares = [...text.matchAll(/operationId:\s*["']([^"']+)["']/g)].some((match) => STABLE_OPERATION_IDS.has(match[1]!));
      if (!declares) continue;
      modules += 1;
      for (const code of producedCodes(file)) {
        if (!isAppErrorCode(code) && !BETA_ROUTE_ONLY.has(code)) unsealed.push(`${relative(ROOT, file)}: ${code}`);
      }
    }
    expect(modules).toBeGreaterThan(10);
    expect([...new Set(unsealed)]).toEqual([]);
  });

  it("translates every dispatch refusal into one sealed code", () => {
    for (const code of ["operation_forbidden", "invalid_input", "missing_path_parameter", "body_too_large", "operation_failed", "unknown_body_property", "idempotency_key_required", "rate_limited", "something_new"]) {
      expect(isAppErrorCode(dispatchRefusalCode(code)), code).toBe(true);
    }
    expect(dispatchRefusalCode("something_new")).toBe("internal_error");
  });

  it("merge one fact into one code", () => {
    for (const retired of ["object_invalid_record", "plugin_inactive", "internal", "app_only"]) {
      expect(isAppErrorCode(retired), retired).toBe(false);
    }
  });
});
