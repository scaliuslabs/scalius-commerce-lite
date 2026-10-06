// Settings → Customer accounts is the one place that decides what checkout
// collects and which channels send codes. Every surface reads the
// customer_auth document through `customerAuthDocument` and the shared
// helpers; the older scattered switches must not come back.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { customerHistory, customers, orders } from "@scalius/database/schema";
import { NO_PHONE, phoneOrNull, storedPhone } from "@scalius/shared/customer-auth-policy";

const ROOT = join(__dirname, "../../../../..");
const SOURCE_DIRS = ["apps/api/src", "apps/storefront/src", "apps/admin-v2/src", "packages/core/src", "packages/shared/src", "packages/database/src"];
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

describe("a contact without a phone stays inside storage", () => {
  it("maps the phone columns with the shared helper pair", () => {
    for (const column of [customers.phone, customerHistory.phone, orders.customerPhone]) {
      for (const value of ["+8801712000001", " +14155550100 ", "", "  "]) {
        expect(column.mapFromDriverValue(value), value).toBe(phoneOrNull(value));
        expect(column.mapToDriverValue(value), value).toBe(storedPhone(value));
      }
      expect(column.mapToDriverValue(NO_PHONE)).toBe(NO_PHONE);
    }
  });

  it("never compares a phone with '' by hand", () => {
    // Only the helper pair (`storedPhone` / `phoneOrNull`), the column type
    // and the 0117 indexes know the stored form.
    const allowed = new Set([
      "packages/shared/src/customer-auth-policy.ts",
      "packages/database/src/schema/shared.ts",
      "packages/database/src/schema/customers.ts",
    ]);
    const handComparison = /[pP]hone\w*\)?\s*(?:===|!==|==|!=)\s*(?:""|'')|(?:""|'')\s*(?:===|!==|==|!=)\s*[\w.]*[pP]hone|phone["`}]?\s*(?:=|<>|!=)\s*''/;
    const offenders = files
      .filter((file) => !allowed.has(file.path) && handComparison.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
