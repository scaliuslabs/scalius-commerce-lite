import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("storefront brand image presentation boundaries", () => {
  it("never enlarges the header, footer, favicon, or schema logo", () => {
    expect(readSource("../components/header/HeaderLayout.astro"))
      .toContain('fit: "scale-down"');
    expect(readSource("../components/Footer.astro"))
      .toContain('fit: "scale-down"');

    const layout = readSource("../layouts/Layout.astro");
    expect(layout.match(/fit: "scale-down"/g)).toHaveLength(2);
  });

  it("preserves complete custom social marks instead of square-cropping them", () => {
    const serializedMedia = readSource("./serialized-media.ts");
    const socialOptions = serializedMedia.slice(
      serializedMedia.indexOf("const SOCIAL_ICON_IMAGE_OPTIONS"),
      serializedMedia.indexOf("function optimizeRasterUrl"),
    );

    expect(socialOptions).toContain('fit: "scale-down"');
    expect(socialOptions).not.toContain('fit: "cover"');
  });
});
