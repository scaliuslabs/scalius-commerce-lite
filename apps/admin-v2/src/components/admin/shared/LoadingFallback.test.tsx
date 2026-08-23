import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./LoadingFallback.tsx", import.meta.url), "utf8");

describe("cold surface loading fallbacks", () => {
  it("uses stable page and panel shapes instead of generic spinners", () => {
    expect(source).toContain("export function PageLoadingSkeleton");
    expect(source).toContain("export function PanelLoadingSkeleton");
    expect(source).not.toContain("animate-spin");
    expect(source).not.toContain("PageLoadingSpinner");
  });
});
