import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buyerProductImageSurfaces = [
  "../components/CartFlyout.tsx",
  "./cart/client.ts",
  "../pages/account.astro",
  "../pages/account/orders/[id].astro",
].map((path) => ({
  path,
  source: readFileSync(new URL(path, import.meta.url), "utf8"),
}));

describe("buyer catalog image presentation boundaries", () => {
  it.each(buyerProductImageSurfaces)(
    "keeps the complete purchased product visible in $path",
    ({ source }) => {
      expect(source).toContain("object-contain");
      expect(source).not.toContain("object-cover");
      expect(source).toContain('fit: "contain"');
      expect(source).not.toContain('fit: "cover"');
    },
  );
});
