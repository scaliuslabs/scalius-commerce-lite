import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const builderSource = readFileSync(
  resolve(directory, "SeoSettingsBuilder.tsx"),
  "utf8",
);
const outcomeSource = readFileSync(
  resolve(directory, "SeoDiscoveryStatusCard.tsx"),
  "utf8",
);

describe("SEO outcome-first workspace", () => {
  it("places the public outcome before the editor and keeps it visible on desktop", () => {
    expect(builderSource.indexOf("<SeoDiscoveryStatusCard")).toBeLessThan(
      builderSource.indexOf("Search appearance"),
    );
    expect(builderSource).toContain("xl:sticky xl:top-4");
    expect(outcomeSource).toContain("Public discovery outcome");
    expect(outcomeSource).toContain("Live proof checks the");
  });

  it("keeps exact discovery authorities and consequences in the same workspace", () => {
    for (const authority of [
      "Product Catalog Feed",
      "UCP Catalog Discovery",
      "Structured Data",
      "Return Policy Schema",
      "Additional robots.txt rules",
    ]) {
      expect(builderSource).toContain(authority);
    }
    expect(builderSource).toContain("Save discovery settings");
  });
});
