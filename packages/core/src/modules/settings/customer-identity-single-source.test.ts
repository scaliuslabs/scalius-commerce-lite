// Settings → Customer accounts is the one place that decides what checkout
// collects and which channels send codes. Every surface reads the
// customer_auth document through `customerAuthDocument` and the shared
// helpers; the older scattered switches must not come back.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../../..");
const SOURCE_DIRS = ["apps/api/src", "apps/storefront/src", "apps/admin-v2/src", "packages/core/src", "packages/shared/src"];
const SKIP = /(node_modules|generated|\.gen\.|routeTree|\.test\.|__tests__|dist)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP.test(path)) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|astro)$/.test(name) ? [path] : [];
  });
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));

describe("customer identity has one source", () => {
  it("keeps no second switch for contact fields or code channels", () => {
    for (const legacy of ["showEmailField", "authVerificationMethod", "customerAuthPolicy", "otpChannels", "readyPhoneCodeChannel"]) {
      expect(files.filter((file) => file.text.includes(legacy)).map((file) => file.path), legacy).toEqual([]);
    }
  });

  it("reads the customer_auth row only through its settings document", () => {
    // (Agent continuations also have a "customer_auth" kind; that is not the settings row.)
    const raw = files
      .filter((file) => /key: ["'`]customer_auth["'`]|category[^\n]{0,60}["'`]customer_auth["'`]|["'`]customer_auth["'`][^\n]{0,60}category/.test(file.text))
      .map((file) => file.path);
    expect(raw).toEqual(["packages/core/src/modules/settings/documents.ts"]);
  });
});
