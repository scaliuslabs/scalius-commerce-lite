// One error-code vocabulary: every code the API, core, the SDK and the
// bundled apps produce is lower_snake (`price_changed`, `revision_conflict`,
// `api_operation_not_stable`). An app or a client compares codes as written,
// so a second casing is a second contract. The dashboard's sign-in and
// account-security flows keep Better Auth's own codes (its library returns
// them on the same screens), and so are left out here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCES = ["apps/api/src", "packages/core/src", "packages/shared/src", "packages/plugin-sdk/src", "plugins", "apps/storefront/src/pages/api"];
/** Better Auth's vocabulary and the flows built on it; Firebase's own codes; test harnesses. */
const AUTH_FAMILY = [/^apps\/api\/src\/dashboard\//, /^apps\/api\/src\/routes\/admin\/auth-management\.ts$/, /^packages\/core\/src\/auth\//, /^packages\/core\/src\/integrations\/firebase\//, /^apps\/api\/src\/testing\//];
const CODE = /^[a-z][a-z0-9_]*$/;
/** Where a literal becomes an error code: an AppError, an error envelope, a refusal helper. */
const PRODUCERS = [
  /\bnew [A-Z]\w*Error\(\s*\d{3}\s*,\s*["']([^"']+)["']/g,
  /\bsuper\(\s*\d{3}\s*,\s*["']([^"']+)["']/g,
  /\b(?:jsonError|refusal)\(\s*\d{3}\s*,\s*["']([^"']+)["']/g,
  /\berror:\s*\{\s*code:\s*["']([^"']+)["']/g,
  /\{\s*code:\s*["']([^"']+)["']\s*,\s*message:/g,
  /\bfail\(\s*["']([^"']+)["']\s*,/g,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|gen)\./.test(name)) out.push(path);
  }
  return out;
}

describe("the error-code vocabulary", () => {
  it("produces lower_snake codes only", () => {
    const offending: string[] = [];
    for (const source of SOURCES) {
      for (const file of sourceFiles(join(ROOT, source))) {
        const path = relative(ROOT, file);
        if (AUTH_FAMILY.some((pattern) => pattern.test(path))) continue;
        const text = readFileSync(file, "utf8");
        for (const pattern of PRODUCERS) {
          for (const match of text.matchAll(pattern)) {
            // A sentence is a message (some helpers take the message first), not a code.
            if (!/\s/.test(match[1]!) && !CODE.test(match[1]!)) offending.push(`${path}: ${match[1]}`);
          }
        }
      }
    }
    expect([...new Set(offending)]).toEqual([]);
  });
});
