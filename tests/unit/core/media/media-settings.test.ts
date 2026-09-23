import { createSqliteD1Database } from "../../../../packages/database/src/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { mediaDocument, normalizeMediaHost } from "../../../../packages/core/src/modules/settings/documents";
import { isValidMediaHostInput } from "../../../../packages/core/src/modules/settings/site-settings.service";

describe("media delivery settings", () => {
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

  it("reads a stored document into a safe canonical shape", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('media', 'document', ?, 'json', 'media')")
      .run(JSON.stringify({
        enabled: false,
        canonicalCdnUrl: "https://cdn.example.com/",
        allowedImageHosts: ["media.example.com", "media.example.com"],
        canonicalHostAliases: ["old.example.com/path", "old.example.com"],
      }));
    expect(await mediaDocument.read(db)).toEqual({
      canonicalCdnUrl: "cdn.example.com",
      canonicalHostAliases: ["old.example.com"],
    });
  });
});
