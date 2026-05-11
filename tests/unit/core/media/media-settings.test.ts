import { describe, expect, it } from "vitest";
import {
  isValidMediaHostInput,
  normalizeMediaHost,
  parseMediaOptimizationSettings,
} from "../../../../packages/core/src/modules/settings/site-settings.service";

describe("media optimization settings", () => {
  it("normalizes pasted CDN hosts without accepting paths or queries", () => {
    expect(normalizeMediaHost("https://CDN.Example.com/")).toBe(
      "cdn.example.com",
    );
    expect(normalizeMediaHost("cdn.example.com/path/to/file.jpg")).toBe("");
    expect(normalizeMediaHost("cdn.example.com?x=1")).toBe("");
    expect(normalizeMediaHost("*.example.com")).toBe("");
  });

  it("validates optional hostname fields", () => {
    expect(isValidMediaHostInput("")).toBe(true);
    expect(isValidMediaHostInput("assets.example.com")).toBe(true);
    expect(isValidMediaHostInput("https://assets.example.com/")).toBe(true);
    expect(isValidMediaHostInput("https://assets.example.com/image.jpg")).toBe(
      false,
    );
  });

  it("parses stored settings into a safe canonical shape", () => {
    expect(
      parseMediaOptimizationSettings(
        JSON.stringify({
          enabled: false,
          canonicalCdnUrl: "https://cdn.example.com/",
          allowedImageHosts: ["media.example.com", "media.example.com"],
          canonicalHostAliases: ["old.example.com/path", "old.example.com"],
        }),
      ),
    ).toEqual({
      enabled: false,
      canonicalCdnUrl: "cdn.example.com",
      allowedImageHosts: ["media.example.com"],
      canonicalHostAliases: ["old.example.com"],
    });
  });
});
