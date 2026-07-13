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

  it("keeps the nested return-policy editor shrink-safe beside the outcome rail", () => {
    expect(builderSource).toContain(
      'xl:grid-cols-[minmax(0,1fr)_20rem]',
    );
    expect(builderSource).toContain(
      'className="mt-4 grid min-w-0 gap-3 md:grid-cols-2"',
    );
    expect(builderSource).not.toContain(
      'md:grid-cols-2 xl:grid-cols-4',
    );
    expect(builderSource).toContain(
      'className="grid min-w-0 gap-2 md:col-span-2"',
    );
    expect(builderSource.match(/SelectTrigger[^>]+className="min-w-0"/g)).toHaveLength(3);
  });
});
