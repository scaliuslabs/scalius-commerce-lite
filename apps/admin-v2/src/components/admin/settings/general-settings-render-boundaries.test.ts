import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./GeneralSettingsPage.tsx", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../../../routes/admin/settings/index.tsx", import.meta.url),
  "utf8",
);

describe("General settings render boundaries", () => {
  it("mounts the Auth & Access editor exactly once", () => {
    expect(source.match(/<AuthSettingsBuilder\s*\/>/g)).toHaveLength(1);
  });

  it("passes each navigation readiness state only to its owning builder", () => {
    expect(routeSource).toContain(
      "headerReadiness={result.navigationReadiness?.header}",
    );
    expect(routeSource).toContain(
      "footerReadiness={result.navigationReadiness?.footer}",
    );
    expect(source).toContain("readiness={headerReadiness}");
    expect(source).toContain("readiness={footerReadiness}");
  });

  it("uses grouped desktop navigation and a single mobile section picker", () => {
    expect(source).toContain('const tabGroups = ["Storefront", "Operations", "Access & security"]');
    expect(source).toContain('aria-label="Settings section"');
    expect(source).toContain("<SelectGroup");
    expect(source).toContain('className="min-h-11"');
    expect(source).toContain("lg:hidden");
    expect(source).toContain("hidden h-auto");
    expect(source).not.toContain("overflow-x-auto");
  });
});
