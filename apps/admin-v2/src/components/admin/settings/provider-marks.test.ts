import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_MARKS } from "./provider-marks";

const PUBLIC_DIR = fileURLToPath(new URL("../../../../public/", import.meta.url));

describe("provider mark manifest", () => {
  it("keeps every adopted mark local, traceable, and byte-verified", () => {
    expect(Object.keys(PROVIDER_MARKS)).toHaveLength(19);

    for (const mark of Object.values(PROVIDER_MARKS)) {
      expect(mark.firstPartyAssetUrl).toMatch(/^https:\/\//);
      expect(mark.governingTermsUrl).toMatch(/^https:\/\//);
      expect(mark.allowedSurface).toBe("direct-provider-settings");
      expect(mark.minimumCssPixels).toBeGreaterThanOrEqual(16);

      if (mark.derivative) {
        expect(mark.derivative.operation.length).toBeGreaterThan(24);
        expect(mark.derivative.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(mark.derivative.sourceSha256).not.toBe(mark.sha256);
      }

      for (const assetPath of [mark.lightSrc, mark.darkSrc].filter(Boolean) as string[]) {
        expect(assetPath).toMatch(/^\/provider-marks\//);
        const absolutePath = `${PUBLIC_DIR}${assetPath.slice(1)}`;
        expect(existsSync(absolutePath)).toBe(true);
      }

      const primaryPath = `${PUBLIC_DIR}${mark.lightSrc.slice(1)}`;
      const digest = createHash("sha256").update(readFileSync(primaryPath)).digest("hex");
      expect(digest).toBe(mark.sha256);
      if (mark.darkSrc) {
        const darkPath = `${PUBLIC_DIR}${mark.darkSrc.slice(1)}`;
        const darkDigest = createHash("sha256").update(readFileSync(darkPath)).digest("hex");
        expect(darkDigest).toBe(mark.darkSha256);
      }
    }
  });
});
